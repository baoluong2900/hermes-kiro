package proxy

import (
	"strings"
	"sync"
)

// modelTokenLimits holds the per-model token limits reported by Kiro's
// ListAvailableModels response (tokenLimits.maxInputTokens / maxOutputTokens).
type modelTokenLimits struct {
	maxInput  int
	maxOutput int
}

var (
	modelLimitsMu sync.RWMutex
	// modelLimits maps a lowercased Kiro model ID to the limits advertised by
	// upstream. Populated whenever the models cache is refreshed, so the proxy
	// reports the real context window instead of relying on the name heuristic.
	modelLimits = make(map[string]modelTokenLimits)
)

// recordModelTokenLimits stores the token limits advertised by upstream for each
// model. Accounts on different plans may report different ceilings for the same
// model, so the most permissive value seen is kept: under-reporting the window
// makes clients compact earlier than necessary and shrinks the usable context.
func recordModelTokenLimits(models []ModelInfo) {
	if len(models) == 0 {
		return
	}

	modelLimitsMu.Lock()
	defer modelLimitsMu.Unlock()

	for _, m := range models {
		if m.TokenLimits == nil {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(m.ModelId))
		if id == "" {
			continue
		}
		in, out := m.TokenLimits.MaxInputTokens, m.TokenLimits.MaxOutputTokens
		if in <= 0 && out <= 0 {
			continue
		}
		cur := modelLimits[id]
		if in > cur.maxInput {
			cur.maxInput = in
		}
		if out > cur.maxOutput {
			cur.maxOutput = out
		}
		modelLimits[id] = cur
	}
}

// lookupModelLimits resolves limits for a client-supplied model name. The name
// may carry the configurable thinking suffix (e.g. "claude-opus-5-thinking"),
// so an exact match is tried first and then the longest registered model ID that
// prefixes the requested name.
func lookupModelLimits(model string) (modelTokenLimits, bool) {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "" {
		return modelTokenLimits{}, false
	}

	modelLimitsMu.RLock()
	defer modelLimitsMu.RUnlock()

	if lim, ok := modelLimits[name]; ok {
		return lim, true
	}

	best := ""
	for id := range modelLimits {
		if len(id) > len(best) && strings.HasPrefix(name, id) {
			best = id
		}
	}
	if best == "" {
		return modelTokenLimits{}, false
	}
	return modelLimits[best], true
}

// modelMaxOutputTokens returns the upstream-reported output ceiling for a model,
// or 0 when upstream has not advertised one.
func modelMaxOutputTokens(model string) int {
	if lim, ok := lookupModelLimits(model); ok {
		return lim.maxOutput
	}
	return 0
}

// resetModelLimitsForTest clears the registry so tests start from a clean state.
func resetModelLimitsForTest() {
	modelLimitsMu.Lock()
	modelLimits = make(map[string]modelTokenLimits)
	modelLimitsMu.Unlock()
}
