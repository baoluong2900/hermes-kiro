package proxy

import (
	"testing"
)

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
