// Package pool 账号池管理
// 实现轮询负载均衡、错误冷却、Token 刷新
package pool

import (
	"kiro-go/config"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const tokenRefreshSkewSeconds int64 = 120

// AccountPool 账号池
type AccountPool struct {
	mu             sync.RWMutex
	accounts       []config.Account // weighted entries, grouped by priority tier descending
	tiers          []accountTier    // slice ranges of p.accounts per priority tier, highest first
	cursors        map[int]*uint64  // per-tier round-robin cursor
	totalAccounts  int
	cooldowns      map[string]time.Time            // 账号冷却时间
	errorCounts    map[string]int                  // 连续错误计数
	modelLists     map[string]map[string]bool      // accountID → set of modelIDs (from ListAvailableModels)
	modelCooldowns map[string]map[string]time.Time // accountID → modelID → model-level cooldown
}

// accountTier marks the range [start, end) of p.accounts belonging to one
// priority tier. Weight expansion happens inside a tier, so weight balances
// traffic within a tier while priority decides which tier serves at all.
type accountTier struct {
	priority int
	start    int
	end      int
}

// NewTestPool constructs an isolated account pool for cross-package tests.
// Production code should use GetPool.
func NewTestPool(accounts ...config.Account) *AccountPool {
	p := &AccountPool{
		cooldowns:      make(map[string]time.Time),
		errorCounts:    make(map[string]int),
		modelLists:     make(map[string]map[string]bool),
		modelCooldowns: make(map[string]map[string]time.Time),
	}
	p.rebuild(accounts, true)
	return p
}

var (
	pool     *AccountPool
	poolOnce sync.Once
)

// GetPool 获取全局账号池单例
func GetPool() *AccountPool {
	poolOnce.Do(func() {
		pool = &AccountPool{
			cooldowns:      make(map[string]time.Time),
			errorCounts:    make(map[string]int),
			modelLists:     make(map[string]map[string]bool),
			modelCooldowns: make(map[string]map[string]time.Time),
		}
		pool.Reload()
	})
	return pool
}

// Reload rebuilds the tiered, weighted account list from config.
// Over-quota accounts are dropped unless either the per-account upstream
// Overages switch (OverageStatus=ENABLED) or the global AllowOverUsage
// setting permits over-quota routing.
func (p *AccountPool) Reload() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rebuild(config.GetEnabledAccounts(), config.GetAllowOverUsage())
}

// rebuild groups accounts by priority tier (highest first) and expands weight
// inside each tier. Caller holds p.mu.
func (p *AccountPool) rebuild(enabled []config.Account, allowOverUsage bool) {
	byPriority := make(map[int][]config.Account)
	priorities := make([]int, 0, 4)
	for _, a := range enabled {
		if isQuotaBlocked(a, allowOverUsage) {
			continue
		}
		if _, ok := byPriority[a.Priority]; !ok {
			priorities = append(priorities, a.Priority)
		}
		for j := 0; j < effectiveWeight(a.Weight); j++ {
			byPriority[a.Priority] = append(byPriority[a.Priority], a)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(priorities)))

	weighted := make([]config.Account, 0, len(enabled))
	tiers := make([]accountTier, 0, len(priorities))
	cursors := make(map[int]*uint64, len(priorities))
	for _, priority := range priorities {
		start := len(weighted)
		weighted = append(weighted, byPriority[priority]...)
		tiers = append(tiers, accountTier{priority: priority, start: start, end: len(weighted)})
		if cur, ok := p.cursors[priority]; ok {
			cursors[priority] = cur // keep the round-robin position across reloads
		} else {
			cursors[priority] = new(uint64)
		}
	}
	p.accounts = weighted
	p.tiers = tiers
	p.cursors = cursors
	p.totalAccounts = len(enabled)
}

// GetNext 获取下一个可用账号（加权轮询）
func (p *AccountPool) GetNext() *config.Account {
	return p.GetNextExcluding(nil)
}

// GetNextExcluding 获取下一个可用账号，并跳过指定账号。
func (p *AccountPool) GetNextExcluding(excluded map[string]bool) *config.Account {
	return p.pickRoutable("", excluded)
}

// pickRoutable walks priority tiers from highest to lowest and picks within
// the first tier that yields a routable account. Inside a tier the configured
// routing mode applies:
//   - sequential (默认): first routable account, so one account is drained
//     before the next takes over
//   - round_robin (均衡): per-tier weighted round-robin
//
// An empty model skips the model-capability check.
//
// When every candidate is cooling down this returns nil: handing out the
// account whose cooldown ends soonest would defeat the cooldown and retry-storm
// an upstream that already said 429.
func (p *AccountPool) pickRoutable(model string, excluded map[string]bool) *config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if len(p.accounts) == 0 {
		return nil
	}

	allowOverUsage := config.GetAllowOverUsage()
	roundRobin := config.GetAccountRoutingMode() == config.RoutingModeRoundRobin
	now := time.Now()
	seen := make(map[string]bool)

	for _, tier := range p.tiers {
		n := tier.end - tier.start
		start := 0
		if roundRobin {
			start = int((atomic.AddUint64(p.cursors[tier.priority], 1) - 1) % uint64(n))
		}
		for i := 0; i < n; i++ {
			acc := &p.accounts[tier.start+(start+i)%n]
			if seen[acc.ID] {
				continue
			}
			seen[acc.ID] = true
			if p.routableForModel(acc, model, excluded, allowOverUsage, now) {
				return detachedAccount(acc)
			}
		}
	}
	return nil
}

// routableForModel applies the shared per-candidate rules of the selection
// walk: not excluded, serves the model (skipped when model is empty), not
// cooling down, token usable or refreshable on demand, and not quota-blocked.
// pickRoutable and GetNextForModelSticky must agree on these, or a pinned
// account could dodge the health rules. Caller holds p.mu.
func (p *AccountPool) routableForModel(acc *config.Account, model string, excluded map[string]bool, allowOverUsage bool, now time.Time) bool {
	if excluded != nil && excluded[acc.ID] {
		return false
	}
	if model != "" && !p.accountHasModel(acc.ID, model) {
		return false
	}
	if cooldown, ok := p.cooldowns[acc.ID]; ok && now.Before(cooldown) {
		return false
	}
	// Refreshable credentials are renewed by the handler (ensureValidToken)
	// before any upstream call. Keeping them eligible lets a cold standby wake
	// immediately instead of waiting for its background refresh sweep.
	if acc.ExpiresAt > 0 && now.Unix() > acc.ExpiresAt-tokenRefreshSkewSeconds && !acc.IsRefreshableCredential() {
		return false
	}
	return !isQuotaBlocked(*acc, allowOverUsage)
}

// tierHasRoutable reports whether any account in the tier passes the shared
// health rules. Caller holds p.mu.
func (p *AccountPool) tierHasRoutable(tier accountTier, model string, excluded map[string]bool, allowOverUsage bool, now time.Time) bool {
	for i := tier.start; i < tier.end; i++ {
		if p.routableForModel(&p.accounts[i], model, excluded, allowOverUsage, now) {
			return true
		}
	}
	return false
}

// inActiveTier reports whether the account at idx belongs to the highest
// priority tier that still has a routable account. Strict priority outranks
// cache locality: a pinned account below the active tier must yield so traffic
// returns to the top tier as soon as it recovers. Caller holds p.mu.
func (p *AccountPool) inActiveTier(idx int, model string, excluded map[string]bool, allowOverUsage bool, now time.Time) bool {
	for _, tier := range p.tiers {
		inTier := idx >= tier.start && idx < tier.end
		if p.tierHasRoutable(tier, model, excluded, allowOverUsage, now) {
			return inTier
		}
		if inTier {
			return false
		}
	}
	return false
}

// GetNextForModelSticky pins the request to preferredID when that account is
// still routable and sits in the active priority tier, falling back to the
// tiered walk otherwise. The prompt-cache layer uses it to keep a conversation
// on the account holding its warm prefix: a round-robin hop to another account
// would miss that cache and re-read the whole prompt at full price.
func (p *AccountPool) GetNextForModelSticky(model, preferredID string, excluded map[string]bool) *config.Account {
	if preferredID != "" {
		p.mu.RLock()
		allowOverUsage := config.GetAllowOverUsage()
		now := time.Now()
		for i := range p.accounts {
			acc := &p.accounts[i]
			if acc.ID != preferredID {
				continue
			}
			if p.inActiveTier(i, model, excluded, allowOverUsage, now) && p.routableForModel(acc, model, excluded, allowOverUsage, now) {
				p.mu.RUnlock()
				return detachedAccount(acc)
			}
			break
		}
		p.mu.RUnlock()
	}
	return p.pickRoutable(model, excluded)
}

// SetModelList 缓存账号支持的模型集合（由 handler 在刷新后调用）
func (p *AccountPool) SetModelList(accountID string, modelIDs []string) {
	set := make(map[string]bool, len(modelIDs))
	for _, id := range modelIDs {
		set[strings.ToLower(strings.TrimSpace(id))] = true
	}
	p.mu.Lock()
	p.modelLists[accountID] = set
	p.mu.Unlock()
}

// GetModelList 返回该账号缓存的模型 ID 列表（供 admin API 使用）。
// 若尚无缓存则返回空切片。
func (p *AccountPool) GetModelList(accountID string) []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	set, ok := p.modelLists[accountID]
	if !ok || len(set) == 0 {
		return []string{}
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	return ids
}

// accountHasModel 检查账号是否支持指定模型。
// 若该账号尚无模型列表（冷启动），视为支持所有模型。
func (p *AccountPool) accountHasModel(accountID, model string) bool {
	norm := strings.ToLower(strings.TrimSpace(model))
	normBase := strings.TrimSuffix(strings.TrimSuffix(norm, "-thinking"), ":thinking")

	if p.modelCooldowns != nil {
		if cds, ok := p.modelCooldowns[accountID]; ok {
			now := time.Now()
			if cd, ok := cds[norm]; ok && now.Before(cd) {
				return false
			}
			if cd, ok := cds[normBase]; ok && now.Before(cd) {
				return false
			}
		}
	}

	list, ok := p.modelLists[accountID]
	if !ok || len(list) == 0 {
		return true // 冷启动：列表未就绪，乐观放行
	}
	return list[norm] || list[normBase]
}

// RecordModelCooldown 针对单个账号的某个具体模型设置冷却。
// 当上游账号对某个声明支持的模型返回 EmptyUpstreamResponse（空响应）时，
// 临时冷却该账号的该模型，避免不断将该模型请求分发给失效账号，同时保留该账号处理其他正常模型的能力。
func (p *AccountPool) RecordModelCooldown(accountID, model string, cooldown time.Duration) {
	if accountID == "" || model == "" || cooldown <= 0 {
		return
	}
	norm := strings.ToLower(strings.TrimSpace(model))
	normBase := strings.TrimSuffix(strings.TrimSuffix(norm, "-thinking"), ":thinking")

	p.mu.Lock()
	defer p.mu.Unlock()

	if p.modelCooldowns == nil {
		p.modelCooldowns = make(map[string]map[string]time.Time)
	}
	cds, ok := p.modelCooldowns[accountID]
	if !ok {
		cds = make(map[string]time.Time)
		p.modelCooldowns[accountID] = cds
	}
	until := time.Now().Add(cooldown)
	if existing, ok := cds[norm]; !ok || until.After(existing) {
		cds[norm] = until
	}
	if existing, ok := cds[normBase]; !ok || until.After(existing) {
		cds[normBase] = until
	}
}

// GetNextForModel 获取下一个支持指定模型的可用账号。
// model 应为去掉 thinking 后缀的实际模型名。
// 若无账号有该模型列表数据，行为与 GetNext 相同（乐观路由）。
func (p *AccountPool) GetNextForModel(model string) *config.Account {
	return p.GetNextForModelExcluding(model, nil)
}

// GetNextForModelExcluding 获取下一个支持指定模型的可用账号，并跳过指定账号。
// model 应为去掉 thinking 后缀的实际模型名；路由顺序与 GetNext 相同。
func (p *AccountPool) GetNextForModelExcluding(model string, excluded map[string]bool) *config.Account {
	return p.pickRoutable(model, excluded)
}

// GetByID 根据 ID 获取账号
func (p *AccountPool) GetByID(id string) *config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			return detachedAccount(&p.accounts[i])
		}
	}
	return nil
}

// detachedAccount returns a pointer to a private copy of a pooled account.
//
// Every getter used to hand out &p.accounts[idx] — a pointer INTO the pool's own
// slice — and release the RLock on return. Callers then read acc.AccessToken,
// acc.ExpiresAt and acc.ProfileArn with no lock held for the whole request, while
// UpdateCredentialState and UpdateProfileArn wrote those same fields under
// p.mu.Lock(). Two different lock disciplines over one address: `go test -race`
// reports it as a data race (write at pool/account.go UpdateCredentialState vs a
// bare field read in the request path). Torn reads of an AccessToken are not
// theoretical — a string header is two words.
//
// Returning a copy makes the snapshot immutable for the caller. Account holds
// only scalars and strings (no slices, maps or pointers), so a shallow copy is a
// complete one; config.GetAccounts and GetAllAccounts already rely on that.
// The cost is one ~700-byte struct copy per request, against saving a lock held
// across a multi-second upstream call.
//
// Callers that need to publish a resolved field back into the pool must go
// through UpdateProfileArn / UpdateCredentialState, which take p.mu.Lock().
func detachedAccount(acc *config.Account) *config.Account {
	if acc == nil {
		return nil
	}
	snapshot := *acc
	return &snapshot
}

// UpdateProfileArn publishes a resolved Kiro profile ARN into every pooled entry
// for the account.
//
// ResolveProfileArn used to write straight through the aliased pointer it was
// handed (proxy/kiro_api.go), which both raced and served as the cross-request
// cache that keeps the fast path at ResolveProfileArn from re-resolving over the
// network. Detaching the getters removes that accidental cache, so the publish
// has to be explicit and locked.
func (p *AccountPool) UpdateProfileArn(id string, profileArn string) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(profileArn) == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			p.accounts[i].ProfileArn = profileArn
		}
	}
}

// RecordSuccess 记录请求成功，清除冷却
func (p *AccountPool) RecordSuccess(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.cooldowns, id)
	p.errorCounts[id] = 0
}

// CooldownUntil returns the unix time the account's pool cooldown ends, or 0
// when it is not cooling. Exposed so the admin UI can explain why an enabled
// account with quota left still yields "No available accounts".
func (p *AccountPool) CooldownUntil(id string) int64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if cd, ok := p.cooldowns[id]; ok && time.Now().Before(cd) {
		return cd.Unix()
	}
	return 0
}

// RoutingState is the live per-account routing picture the admin panel shows,
// so an operator can see why an account — and with it a whole priority tier —
// is passing traffic to the tier below it.
type RoutingState struct {
	// InPool reports whether the account sits in the weighted list at all
	// (false: disabled, or quota-blocked at the last reload).
	InPool bool `json:"inPool"`
	// Cooldown reports an active failure/throttle cooldown; CooldownUntil is
	// the unix time it lifts (0 when none).
	Cooldown      bool  `json:"cooldown"`
	CooldownUntil int64 `json:"cooldownUntil"`
	// ErrorCount is the consecutive-error count toward the next cooldown.
	ErrorCount int `json:"errorCount"`
	// QuotaBlocked reports usage at the limit with no overage exemption.
	QuotaBlocked bool `json:"quotaBlocked"`
	// TokenExpiring reports an access token inside the refresh-skew window;
	// refreshable credentials are renewed on demand before the upstream call.
	TokenExpiring bool `json:"tokenExpiring"`
	// Refreshable reports whether an expiring token can be renewed on demand.
	Refreshable bool `json:"refreshable"`
}

// RoutingStateFor evaluates the same rules pickRoutable applies, for one
// account. a may be any current copy of the account record; pool membership
// and cooldowns always come from live state.
func (p *AccountPool) RoutingStateFor(a config.Account) RoutingState {
	p.mu.RLock()
	defer p.mu.RUnlock()

	now := time.Now()
	st := RoutingState{
		QuotaBlocked:  isQuotaBlocked(a, config.GetAllowOverUsage()),
		TokenExpiring: a.ExpiresAt > 0 && now.Unix() > a.ExpiresAt-tokenRefreshSkewSeconds,
		Refreshable:   a.IsRefreshableCredential(),
		ErrorCount:    p.errorCounts[a.ID],
	}
	for i := range p.accounts {
		if p.accounts[i].ID == a.ID {
			st.InPool = true
			break
		}
	}
	if until, ok := p.cooldowns[a.ID]; ok && until.After(now) {
		st.Cooldown = true
		st.CooldownUntil = until.Unix()
	}
	return st
}

// RecordError 记录请求错误，设置冷却
func (p *AccountPool) RecordError(id string, isQuotaError bool) {
	cooldown := time.Duration(0)
	if isQuotaError {
		cooldown = time.Hour
	}
	p.RecordErrorWithCooldown(id, cooldown)
}

// RecordErrorWithCooldown records a failed request and optionally applies an
// immediate cooldown. A zero duration preserves the existing transient-error
// policy: only three consecutive errors trigger a one-minute cooldown.
func (p *AccountPool) RecordErrorWithCooldown(id string, cooldown time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.errorCounts[id]++

	if cooldown > 0 {
		candidate := time.Now().Add(cooldown)
		if current, ok := p.cooldowns[id]; !ok || candidate.After(current) {
			p.cooldowns[id] = candidate
		}
	} else if p.errorCounts[id] >= 3 {
		// 连续 3 次错误，冷却 1 分钟. Never shorten an existing cooldown
		// that may have come from a concurrent quota response.
		candidate := time.Now().Add(time.Minute)
		if current, ok := p.cooldowns[id]; !ok || candidate.After(current) {
			p.cooldowns[id] = candidate
		}
	}
}

// IsAuthFailure reports whether an error indicates the refresh token / credentials
// have been revoked or invalidated upstream (401, 403 with auth markers, etc.).
// These accounts cannot be recovered automatically and must be re-authenticated.
func IsAuthFailure(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	lower := strings.ToLower(msg)

	// Match HTTP status codes only when they appear as standalone tokens to avoid
	// false positives from arbitrary digits in the error body (e.g. request IDs).
	if hasStatusToken(msg, "401") || hasStatusToken(msg, "403") {
		return true
	}
	if strings.Contains(lower, "bad credentials") ||
		strings.Contains(lower, "invalid_grant") ||
		strings.Contains(lower, "invalid grant") ||
		strings.Contains(lower, "invalid_token") ||
		strings.Contains(lower, "invalid token") ||
		strings.Contains(lower, "token expired") ||
		strings.Contains(lower, "token has expired") ||
		strings.Contains(lower, "unauthorized") {
		return true
	}
	return false
}

// hasStatusToken returns true when status appears in s with non-digit boundaries
// on both sides, so "401" matches "HTTP 401 from ..." but not "request_401abc".
func hasStatusToken(s, status string) bool {
	for {
		idx := strings.Index(s, status)
		if idx < 0 {
			return false
		}
		leftOK := idx == 0 || !isDigit(s[idx-1])
		rightIdx := idx + len(status)
		rightOK := rightIdx >= len(s) || !isDigit(s[rightIdx])
		if leftOK && rightOK {
			return true
		}
		s = s[idx+len(status):]
	}
}

func isDigit(b byte) bool {
	return b >= '0' && b <= '9'
}

// IsSuspensionError reports whether the error indicates the account has been
// temporarily suspended by upstream or has no available Kiro profile.
// Unlike auth failures (revoked credentials), these may be transient, but
// the account should be disabled until an operator re-enables it.
func IsSuspensionError(err error) bool {
	if err == nil {
		return false
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "temporarily_suspended") ||
		strings.Contains(lower, "temporarily suspended") ||
		strings.Contains(lower, "no available kiro profile")
}

// DisableAccount marks an account as disabled (auth revoked / unrecoverable),
// removes it from the in-memory pool so subsequent requests skip it, and
// persists the change via config.SetAccountBanStatus.
func (p *AccountPool) DisableAccount(id, reason string) {
	if err := config.SetAccountBanStatus(id, "DISABLED", reason); err != nil {
		// best effort — even if persistence fails, drop it from memory
		_ = err
	}
	p.mu.Lock()
	// Long cooldown as a safety net in case Reload races
	p.cooldowns[id] = time.Now().Add(24 * time.Hour)
	p.mu.Unlock()
	p.Reload()
}

// MarkOverLimit marks an account as over usage limit (after a 402 / OVERAGE response).
// With the upstream OverageStatus model, the live status is refreshed via
// FetchOverageStatus from the request handler; here we just cooldown briefly so
// the next attempt picks a different account, then reload.
func (p *AccountPool) MarkOverLimit(id string) {
	p.mu.Lock()
	p.cooldowns[id] = time.Now().Add(time.Hour)
	p.mu.Unlock()
	p.Reload()
}

// UpdateToken 更新账号 Token
func (p *AccountPool) UpdateToken(id, accessToken, refreshToken string, expiresAt int64) {
	p.UpdateCredentialState(nil, id, accessToken, refreshToken, expiresAt, "")
}

// UpdateCredentialState publishes one persisted refresh result to both the
// pool and an optional caller-owned account while holding the pool lock. The
// target may itself point into the pool.
func (p *AccountPool) UpdateCredentialState(
	target *config.Account,
	id string,
	accessToken string,
	refreshToken string,
	expiresAt int64,
	profileArn string,
) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			p.accounts[i].AccessToken = accessToken
			if refreshToken != "" {
				p.accounts[i].RefreshToken = refreshToken
			}
			p.accounts[i].ExpiresAt = expiresAt
			if profileArn != "" {
				p.accounts[i].ProfileArn = profileArn
			}
		}
	}
	if target != nil {
		target.AccessToken = accessToken
		if refreshToken != "" {
			target.RefreshToken = refreshToken
		}
		target.ExpiresAt = expiresAt
		if profileArn != "" {
			target.ProfileArn = profileArn
		}
	}
}

// Count 返回账号总数
func (p *AccountPool) Count() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.totalAccounts > 0 {
		return p.totalAccounts
	}

	seen := make(map[string]bool)
	for _, acc := range p.accounts {
		seen[acc.ID] = true
	}
	return len(seen)
}

// AvailableCount 返回可用账号数
func (p *AccountPool) AvailableCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	count := 0
	seen := make(map[string]bool)
	for _, acc := range p.accounts {
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		if cooldown, ok := p.cooldowns[acc.ID]; ok && now.Before(cooldown) {
			continue
		}
		count++
	}
	return count
}

// UpdateStats 更新账号统计
func (p *AccountPool) UpdateStats(id string, tokens int, credits float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var updated bool
	var requestCount, errorCount, totalTokens int
	var totalCredits float64
	var lastUsed int64
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			if !updated {
				p.accounts[i].RequestCount++
				p.accounts[i].TotalTokens += tokens
				p.accounts[i].TotalCredits += credits
				p.accounts[i].LastUsed = time.Now().Unix()

				requestCount = p.accounts[i].RequestCount
				errorCount = p.accounts[i].ErrorCount
				totalTokens = p.accounts[i].TotalTokens
				totalCredits = p.accounts[i].TotalCredits
				lastUsed = p.accounts[i].LastUsed
				updated = true
				continue
			}
			p.accounts[i].RequestCount = requestCount
			p.accounts[i].ErrorCount = errorCount
			p.accounts[i].TotalTokens = totalTokens
			p.accounts[i].TotalCredits = totalCredits
			p.accounts[i].LastUsed = lastUsed
		}
	}
	if updated {
		go config.UpdateAccountStats(id, requestCount, errorCount, totalTokens, totalCredits, lastUsed)
	}
}

// GetAllAccounts 获取所有账号副本
func (p *AccountPool) GetAllAccounts() []config.Account {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]config.Account, len(p.accounts))
	copy(result, p.accounts)
	return result
}

func isOverUsageLimit(acc config.Account) bool {
	return acc.UsageLimit > 0 && acc.UsageCurrent >= acc.UsageLimit
}

// isQuotaBlocked reports whether an over-quota account should be skipped:
// the per-account upstream Overages switch (OverageStatus=ENABLED) and the
// global allowOverUsage setting are the two ways to keep it routable.
func isQuotaBlocked(acc config.Account, allowOverUsage bool) bool {
	return isOverUsageLimit(acc) && !isUpstreamOverageEnabled(acc) && !allowOverUsage
}

// isUpstreamOverageEnabled reports whether the upstream Overages switch is ON for this account.
// "ENABLED" → true; anything else (DISABLED, UNKNOWN, empty) → false.
func isUpstreamOverageEnabled(acc config.Account) bool {
	return strings.EqualFold(acc.OverageStatus, "ENABLED")
}

func effectiveWeight(weight int) int {
	if weight < 1 {
		return 1
	}
	return weight
}
