package config

import (
	"hash/fnv"
	"net/url"
	"os"
	"strings"
)

// AccountProxyURL chooses one stable exit per account so token refresh and Kiro
// requests use the same network identity. An explicit account proxy always wins.
// KIRO_ACCOUNT_PROXIES is a semicolon-separated list of COUNTRY|URL entries,
// e.g. ID|http://user:pass@host:port;VN|http://user:pass@host:port.
// ID entries take precedence over VN entries; other countries are ignored.
// If no valid regional entry exists, the configured global proxy is used.
func AccountProxyURL(account *Account) string {
	if account != nil && account.ProxyURL != "" {
		return account.ProxyURL
	}
	if account == nil || strings.TrimSpace(account.ID) == "" {
		return GetProxyURL()
	}

	if pool := regionalProxyPool(); len(pool) > 0 {
		return pool[stableIndex(account.ID, len(pool))]
	}
	return GetProxyURL()
}

// regionalProxyPool builds the candidate set an account may be pinned to, in
// priority order:
//  1. KIRO_ACCOUNT_PROXIES, a semicolon-separated list of COUNTRY|URL entries.
//     ID (Indonesia) entries win; VN (Vietnam) entries are the fallback; any
//     other country is ignored.
//  2. the proxies saved in the admin inventory.
//
// An empty result means "no regional pool" and the caller uses the global proxy.
func regionalProxyPool() []string {
	var indonesia, vietnam []string
	for _, entry := range strings.Split(os.Getenv("KIRO_ACCOUNT_PROXIES"), ";") {
		parts := strings.SplitN(strings.TrimSpace(entry), "|", 2)
		if len(parts) != 2 || !validProxyURL(strings.TrimSpace(parts[1])) {
			continue
		}
		switch strings.ToUpper(strings.TrimSpace(parts[0])) {
		case "ID":
			indonesia = append(indonesia, strings.TrimSpace(parts[1]))
		case "VN":
			vietnam = append(vietnam, strings.TrimSpace(parts[1]))
		}
	}
	if len(indonesia) > 0 {
		return indonesia
	}
	if len(vietnam) > 0 {
		return vietnam
	}
	return EnabledProxyURLs()
}

// validProxyURL accepts the schemes buildKiroTransport can dial.
func validProxyURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || parsed.Port() == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks5", "socks5h":
		return true
	default:
		return false
	}
}

// stableIndex maps a key to [0,n) with fnv-1a, so an account keeps the same
// exit across restarts without storing per-account assignments.
func stableIndex(key string, n int) int {
	if n <= 1 {
		return 0
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return int(h.Sum64() % uint64(n))
}
