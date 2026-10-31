package proxy

import (
	"encoding/json"
	"testing"

	"kiro-go/config"
)

// claudeSchemaJSON mirrors the shape Kiro advertises for Claude families in
// ListAvailableModels: a thinking block (type/display) plus output_config.effort.
const claudeSchemaJSON = `{
  "properties": {
    "thinking": {
      "properties": {
        "type":    {"enum": ["adaptive", "disabled"]},
        "display": {"enum": ["summarized", "omitted"]}
      }
    },
    "output_config": {
      "properties": {
        "effort": {"enum": ["low", "medium", "high", "max"], "default": "high"}
      }
    }
  }
}`

// gptSchemaJSON mirrors the GPT-family shape: reasoning.effort, including the
// "none" rung that only this family advertises.
const gptSchemaJSON = `{
  "properties": {
    "reasoning": {
      "properties": {
        "effort": {"enum": ["none", "low", "medium", "high", "xhigh", "max"], "default": "medium"},
        "mode":   {"enum": ["standard", "pro"]}
      }
    }
  }
}`

func mustSchema(t *testing.T, raw string) *ModelRequestFieldsSchema {
	t.Helper()
	var s ModelRequestFieldsSchema
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
	}
	return &s
}

func registerModel(t *testing.T, id, raw string) {
	t.Helper()
	updateModelReasoningCapabilities([]ModelInfo{{
		ModelId:                            id,
		AdditionalModelRequestFieldsSchema: mustSchema(t, raw),
	}})
	t.Cleanup(resetModelReasoningCapabilities)
}

func TestReasoningCapabilityFromSchema(t *testing.T) {
	claude := reasoningCapabilityFromSchema(mustSchema(t, claudeSchemaJSON))
	if claude.Transport != reasoningTransportThinking {
		t.Fatalf("claude schema: expected thinking transport, got %v", claude.Transport)
	}
	if got := claude.Efforts; len(got) != 4 || got[0] != "low" || got[3] != "max" {
		t.Fatalf("claude efforts not ladder-ordered: %v", got)
	}
	if claude.DefaultEffort != "high" {
		t.Fatalf("claude default effort: %q", claude.DefaultEffort)
	}
	if claude.SupportsNone {
		t.Fatalf("claude schema must not advertise none")
	}
	if !claude.SupportsDisplay("omitted") {
		t.Fatalf("claude displays: %v", claude.Displays)
	}

	gpt := reasoningCapabilityFromSchema(mustSchema(t, gptSchemaJSON))
	if gpt.Transport != reasoningTransportAdditionalFields {
		t.Fatalf("gpt schema: expected additional-fields transport, got %v", gpt.Transport)
	}
	if !gpt.SupportsNone {
		t.Fatalf("gpt schema should advertise none: %+v", gpt)
	}

	if got := reasoningCapabilityFromSchema(nil); got.Transport != reasoningTransportNone {
		t.Fatalf("absent schema must yield no transport, got %v", got.Transport)
	}
}

// An effort the model does not advertise is clamped down its own ladder rather
// than forwarded: sending an unlisted enum value is a hard upstream 400.
func TestClampEffortToAdvertisedLadder(t *testing.T) {
	cap := reasoningCapabilityFromSchema(mustSchema(t, claudeSchemaJSON)) // no "xhigh"
	got, ok := normalizeNativeThinkingEffort(cap, "xhigh")
	if !ok || got != "high" {
		t.Fatalf("xhigh should clamp to high, got %q (ok=%v)", got, ok)
	}
	if got, ok := normalizeNativeThinkingEffort(cap, "minimal"); !ok || got != "low" {
		t.Fatalf("minimal should map to low, got %q (ok=%v)", got, ok)
	}
	// "none" is not a rung on the Claude ladder: it means "send no directive".
	if _, ok := normalizeNativeThinkingEffort(cap, "none"); ok {
		t.Fatalf("none must not resolve on a model that does not advertise it")
	}
}

func TestEffortForThinkingBudget(t *testing.T) {
	cases := map[int]string{0: "", 1024: "low", 4096: "low", 10000: "medium", 31999: "high", 60000: "xhigh", 200000: "max"}
	for budget, want := range cases {
		if got := effortForThinkingBudget(budget); got != want {
			t.Fatalf("budget %d: got %q, want %q", budget, got, want)
		}
	}
}

// Claude Code sends thinking: {type: "enabled", budget_tokens: N} and no effort
// field. That has to produce a native directive, or the turn comes back without
// a signature and the next request cannot replay it.
func TestNativeThinkingFromLegacyBudgetForm(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)

	req := &ClaudeRequest{
		Model:    "claude-sonnet-5",
		Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 31999},
	}
	cfg := config.ThinkingConfig{NativeMode: "auto", NativeDisplay: "summarized"}

	d := resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(req, false), cfg)
	if !d.Native.Enabled {
		t.Fatalf("expected native thinking for the legacy budget form, got %+v", d)
	}
	if d.Native.Effort != "high" {
		t.Fatalf("budget 31999 should map to high, got %q", d.Native.Effort)
	}

	payload := &KiroPayload{}
	applyReasoningDecision(payload, d)
	if payload.Thinking == nil || payload.Thinking.Type != "adaptive" || payload.Thinking.Display != "summarized" {
		t.Fatalf("payload root thinking directive wrong: %+v", payload.Thinking)
	}
	if payload.OutputConfig == nil || payload.OutputConfig.Effort != "high" {
		t.Fatalf("payload root output_config wrong: %+v", payload.OutputConfig)
	}
	// The directive is mirrored onto the current message, matching the upstream
	// contract (camelCase outputConfig there, snake_case at the root).
	msg := payload.ConversationState.CurrentMessage.UserInputMessage
	if msg.Thinking == nil || msg.OutputConfig == nil || msg.OutputConfig.Effort != "high" {
		t.Fatalf("current message directive not mirrored: %+v %+v", msg.Thinking, msg.OutputConfig)
	}
}

func TestNativeThinkingHonorsExplicitEffort(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)
	cfg := config.ThinkingConfig{NativeMode: "auto", NativeDisplay: "summarized"}

	req := &ClaudeRequest{Model: "claude-sonnet-5", OutputConfig: &ClaudeOutputConfig{Effort: "low"}}
	d := resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(req, false), cfg)
	if !d.Native.Enabled || d.Native.Effort != "low" {
		t.Fatalf("output_config.effort ignored: %+v", d)
	}

	// thinking.effort wins over output_config.effort when both are present.
	req.Thinking = &ClaudeThinkingConfig{Type: "adaptive", Effort: "max"}
	d = resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(req, false), cfg)
	if d.Native.Effort != "max" {
		t.Fatalf("thinking.effort should win, got %q", d.Native.Effort)
	}
}

func TestNativeThinkingModeGating(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)
	plain := &ClaudeRequest{Model: "claude-sonnet-5"}

	// auto: nothing asked for, nothing attached.
	d := resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(plain, false),
		config.ThinkingConfig{NativeMode: "auto"})
	if d.Native.Enabled {
		t.Fatalf("auto must not attach a directive nobody asked for: %+v", d)
	}

	// force: attach anyway, at the upstream-advertised default.
	d = resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(plain, false),
		config.ThinkingConfig{NativeMode: "force"})
	if !d.Native.Enabled || d.Native.Effort != "high" {
		t.Fatalf("force should attach the schema default: %+v", d)
	}

	// off: never attach, even when the client asked.
	asked := &ClaudeRequest{Model: "claude-sonnet-5", Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 8000}}
	d = resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(asked, false),
		config.ThinkingConfig{NativeMode: "off"})
	if d.Native.Enabled {
		t.Fatalf("off must never attach a directive: %+v", d)
	}
}

// thinking.type=disabled is an explicit opt-out and outranks NativeMode "force".
func TestNativeThinkingExplicitOptOut(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)
	req := &ClaudeRequest{Model: "claude-sonnet-5", Thinking: &ClaudeThinkingConfig{Type: "disabled"}}

	d := resolveReasoningDirectives("claude-sonnet-5", resolveClaudeReasoningRequest(req, false),
		config.ThinkingConfig{NativeMode: "force"})
	if d.Native.Enabled {
		t.Fatalf("explicit opt-out ignored: %+v", d)
	}
}

// A model the upstream list has never advertised gets no directive at all:
// guessing one is a hard 400, because additionalProperties is false upstream.
func TestNoDirectiveForUnknownModel(t *testing.T) {
	resetModelReasoningCapabilities()
	req := &ClaudeRequest{Model: "some-new-model", Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 8000}}

	d := resolveReasoningDirectives("some-new-model", resolveClaudeReasoningRequest(req, false),
		config.ThinkingConfig{NativeMode: "force"})
	if d.Native.Enabled || d.GPTEffort != "" {
		t.Fatalf("unknown model must get no directive: %+v", d)
	}
}

// GPT families take the directive on additionalModelRequestFields instead, and
// never the Claude thinking/outputConfig pair — the two are mutually exclusive.
func TestGPTFamilyUsesAdditionalModelRequestFields(t *testing.T) {
	registerModel(t, "gpt-5.6-sol", gptSchemaJSON)
	req := &OpenAIRequest{Model: "gpt-5.6-sol", ReasoningEffort: "max"}

	d := resolveReasoningDirectives("gpt-5.6-sol", resolveOpenAIReasoningRequest(req, false),
		config.ThinkingConfig{NativeMode: "auto"})
	if d.GPTEffort != "max" || d.Native.Enabled {
		t.Fatalf("expected additional-fields transport only: %+v", d)
	}

	payload := &KiroPayload{}
	applyReasoningDecision(payload, d)
	if payload.AdditionalModelRequestFields == nil || payload.AdditionalModelRequestFields.Reasoning == nil ||
		payload.AdditionalModelRequestFields.Reasoning.Effort != "max" {
		t.Fatalf("additionalModelRequestFields wrong: %+v", payload.AdditionalModelRequestFields)
	}
	if payload.Thinking != nil || payload.OutputConfig != nil {
		t.Fatalf("GPT payload must not carry Claude thinking directives: %+v %+v", payload.Thinking, payload.OutputConfig)
	}

	// "none" is a legal enum value here, so the opt-out travels explicitly
	// instead of being dropped — and must not switch reasoning rendering on.
	req.ReasoningEffort = "none"
	d = resolveReasoningDirectives("gpt-5.6-sol", resolveOpenAIReasoningRequest(req, false),
		config.ThinkingConfig{NativeMode: "force"})
	if d.GPTEffort != "none" {
		t.Fatalf("explicit none should be forwarded, got %+v", d)
	}
	if d.ProducesReasoning() {
		t.Fatalf("effort=none produces no reasoning: %+v", d)
	}
}

// A refresh from an account whose view omits the schema must not erase a
// capability another account already reported.
func TestCapabilityRegistryKeepsRicherView(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)
	updateModelReasoningCapabilities([]ModelInfo{{ModelId: "claude-sonnet-5"}})

	cap, ok := lookupModelReasoningCapability("claude-sonnet-5")
	if !ok || cap.Transport != reasoningTransportThinking {
		t.Fatalf("capability lost after a narrower refresh: %+v (ok=%v)", cap, ok)
	}
}

// The registry is keyed by real upstream ids, so a client name that the proxy
// redirects (alias, thinking suffix) must still resolve.
func TestCapabilityLookupFollowsModelAliases(t *testing.T) {
	registerModel(t, "claude-sonnet-5", claudeSchemaJSON)

	if _, ok := lookupModelReasoningCapability("claude-sonnet-5-thinking"); !ok {
		t.Fatalf("thinking-suffixed name did not resolve to its upstream id")
	}
}

// $schema is an Anthropic-side JSON-Schema artifact Kiro's native tool specs
// never carry; forwarding it risks an upstream "improperly formed request". It
// must be stripped at every level, not only at the root.
func TestEnsureObjectSchemaStripsSchemaKeywordRecursively(t *testing.T) {
	input := map[string]interface{}{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"command": map[string]interface{}{"type": "string"},
			"nested": map[string]interface{}{
				"$schema": "https://json-schema.org/draft/2020-12/schema",
				"type":    "object",
				"properties": map[string]interface{}{
					"x": map[string]interface{}{"type": "integer"},
				},
			},
		},
	}

	got := ensureObjectSchema(input).(map[string]interface{})
	if schemaHasKey(got, "$schema") {
		t.Fatalf("expected $schema removed recursively, got %#v", got)
	}
	if _, stillPresent := input["$schema"]; !stillPresent {
		t.Fatalf("sanitizer must not mutate the caller's schema")
	}
}

func schemaHasKey(value interface{}, key string) bool {
	switch v := value.(type) {
	case map[string]interface{}:
		if _, ok := v[key]; ok {
			return true
		}
		for _, child := range v {
			if schemaHasKey(child, key) {
				return true
			}
		}
	case []interface{}:
		for _, child := range v {
			if schemaHasKey(child, key) {
				return true
			}
		}
	}
	return false
}
