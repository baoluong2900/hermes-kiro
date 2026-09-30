package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestPayloadByteLimitForModel verifies the request budget scales with the
// context window. A 1M-window model pinned to the 200K budget would silently
// discard ~80% of the context it can accept.
func TestPayloadByteLimitForModel(t *testing.T) {
	resetModelLimitsForTest()

	cases := []struct {
		model string
		want  int
	}{
		{"claude-sonnet-4.5", maxPayloadBytes},
		{"claude-sonnet-4", maxPayloadBytes},
		{"unknown-model", maxPayloadBytes},
		{"claude-opus-5", maxPayloadBytes * 5},
		{"claude-opus-5-thinking", maxPayloadBytes * 5},
		{"claude-opus-4.8", maxPayloadBytes * 5},
		{"claude-sonnet-4.6", maxPayloadBytes * 5},
	}
	for _, c := range cases {
		if got := payloadByteLimitForModel(c.model); got != c.want {
			t.Errorf("payloadByteLimitForModel(%q) = %d, want %d", c.model, got, c.want)
		}
	}
}

// TestPayloadByteLimitCeiling ensures an implausible upstream limit cannot let a
// single request grow without bound.
func TestPayloadByteLimitCeiling(t *testing.T) {
	resetModelLimitsForTest()
	defer resetModelLimitsForTest()

	recordModelTokenLimits([]ModelInfo{newModelInfoWithLimits("huge-model", 500_000_000, 0)})

	if got := payloadByteLimitForModel("huge-model"); got != maxPayloadBytesCeiling {
		t.Fatalf("limit = %d, want ceiling %d", got, maxPayloadBytesCeiling)
	}
}

// TestLargeContextModelRetainsMoreHistory is the regression guard for the 1M
// fix: given the identical conversation, a 1M-window model must retain
// substantially more history than a 200K-window model.
func TestLargeContextModelRetainsMoreHistory(t *testing.T) {
	resetModelLimitsForTest()
	defer resetModelLimitsForTest()

	// The small-window side is registered explicitly rather than named after a
	// Claude version. Kiro serves no 200K model any more: every live id is 1M, and
	// every retired 200K id now folds onto a live one through modelAliases, so
	// naming one here would silently measure two 1M models against each other.
	const smallModel = "legacy-200k-model"
	recordModelTokenLimits([]ModelInfo{newModelInfoWithLimits(smallModel, baseContextWindowTokens, 0)})

	big := strings.Repeat("lorem ipsum dolor sit amet ", 80) // ~2.1KB
	msgs := []ClaudeMessage{{Role: "user", Content: "start the long task"}}
	for i := 0; i < 1400; i++ {
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: "step result: " + big},
			ClaudeMessage{Role: "user", Content: "next: " + big},
		)
	}
	msgs = append(msgs, ClaudeMessage{Role: "user", Content: "FINAL: summarize everything above"})

	size := func(model string) int {
		payload := ClaudeToKiro(&ClaudeRequest{
			Model:    model,
			System:   "You are a helpful assistant.",
			Messages: msgs,
		}, false)
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal failed: %v", err)
		}
		return len(raw)
	}

	small := size(smallModel)
	large := size("claude-opus-5")
	t.Logf("retained payload bytes: 200K model=%d (budget %d), 1M model=%d (budget %d)",
		small, maxPayloadBytes, large, payloadByteLimitForModel("claude-opus-5"))

	if small > maxPayloadBytes {
		t.Fatalf("200K model payload %d exceeds its budget %d", small, maxPayloadBytes)
	}
	if large <= small*2 {
		t.Fatalf("1M model retained %d bytes, expected far more than the 200K model's %d", large, small)
	}
	if large > payloadByteLimitForModel("claude-opus-5") {
		t.Fatalf("1M model payload %d exceeds its budget %d", large, payloadByteLimitForModel("claude-opus-5"))
	}
}

// TestUpstreamTokenLimitsOverrideHeuristic verifies the window reported by
// ListAvailableModels wins over the model-name heuristic, so a model the
// heuristic cannot classify still gets its real window.
func TestUpstreamTokenLimitsOverrideHeuristic(t *testing.T) {
	resetModelLimitsForTest()
	defer resetModelLimitsForTest()

	// Heuristic classifies this as 200K (4.5 family).
	if got := getContextWindowSize("claude-sonnet-4.5"); got != 200_000 {
		t.Fatalf("pre-condition: window = %d, want 200000", got)
	}

	recordModelTokenLimits([]ModelInfo{
		newModelInfoWithLimits("claude-sonnet-4.5", 1_000_000, 32_000),
		newModelInfoWithLimits("mystery-model-x", 400_000, 8_000),
	})

	if got := getContextWindowSize("claude-sonnet-4.5"); got != 1_000_000 {
		t.Errorf("upstream window ignored: got %d, want 1000000", got)
	}
	if got := getContextWindowSize("mystery-model-x"); got != 400_000 {
		t.Errorf("unclassifiable model window = %d, want 400000", got)
	}
	// Thinking variants resolve to the base model's limits.
	if got := getContextWindowSize("mystery-model-x-thinking"); got != 400_000 {
		t.Errorf("thinking variant window = %d, want 400000", got)
	}
	if got := modelMaxOutputTokens("claude-sonnet-4.5"); got != 32_000 {
		t.Errorf("max output = %d, want 32000", got)
	}
}

// TestRecordModelTokenLimitsKeepsMostPermissive ensures accounts on a smaller
// plan cannot shrink a window another account already reported as larger.
func TestRecordModelTokenLimitsKeepsMostPermissive(t *testing.T) {
	resetModelLimitsForTest()
	defer resetModelLimitsForTest()

	recordModelTokenLimits([]ModelInfo{newModelInfoWithLimits("claude-opus-5", 1_000_000, 64_000)})
	recordModelTokenLimits([]ModelInfo{newModelInfoWithLimits("claude-opus-5", 200_000, 8_000)})

	if got := getContextWindowSize("claude-opus-5"); got != 1_000_000 {
		t.Errorf("window = %d, want 1000000", got)
	}
	if got := modelMaxOutputTokens("claude-opus-5"); got != 64_000 {
		t.Errorf("max output = %d, want 64000", got)
	}
}

// TestBuildModelInfoAdvertisesContextWindow verifies /v1/models publishes the
// window under the aliases clients look for; without them clients fall back to a
// small default and never use the full window.
func TestBuildModelInfoAdvertisesContextWindow(t *testing.T) {
	resetModelLimitsForTest()
	defer resetModelLimitsForTest()

	info := buildModelInfo("claude-opus-5", "anthropic", true)
	for _, key := range []string{"context_window", "context_length", "max_input_tokens"} {
		if got, ok := info[key].(int); !ok || got != 1_000_000 {
			t.Errorf("%s = %v, want 1000000", key, info[key])
		}
	}
	// No upstream output ceiling recorded yet → nothing advertised.
	if _, ok := info["max_output_tokens"]; ok {
		t.Error("max_output_tokens advertised without an upstream value")
	}

	if got := buildModelInfo("claude-sonnet-4.5", "anthropic", true)["context_window"]; got != 200_000 {
		t.Errorf("sonnet-4.5 context_window = %v, want 200000", got)
	}

	recordModelTokenLimits([]ModelInfo{newModelInfoWithLimits("claude-opus-5", 1_000_000, 64_000)})
	if got := buildModelInfo("claude-opus-5", "anthropic", true)["max_output_tokens"]; got != 64_000 {
		t.Errorf("max_output_tokens = %v, want 64000", got)
	}
}

func newModelInfoWithLimits(id string, maxIn, maxOut int) ModelInfo {
	m := ModelInfo{ModelId: id}
	m.TokenLimits = &struct {
		MaxInputTokens  int `json:"maxInputTokens"`
		MaxOutputTokens int `json:"maxOutputTokens"`
	}{MaxInputTokens: maxIn, MaxOutputTokens: maxOut}
	return m
}
