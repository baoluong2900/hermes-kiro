package proxy

import (
	"strings"

	"kiro-go/config"
	"kiro-go/logger"
)

// Native thinking (Kiro/Claude adaptive thinking) support.
//
// This is the path that produces REAL reasoning blocks: the gateway sends
// structured `thinking`/`outputConfig` directives the Kiro API understands
// directly, and the upstream answers with genuine reasoningContentEvent chunks
// plus the cryptographic signature Anthropic clients must replay on the next
// turn. Without these directives the upstream only ever produces prompt-driven
// <thinking> text, which carries no signature — and an unsigned thinking block
// makes a multi-turn conversation unanswerable once the client echoes it back.
//
// Which models support what — the transport, the legal effort levels, the
// default effort and the display values — is read from the upstream
// ListAvailableModels schema (see model_capabilities.go), never hardcoded.
//
// Gating (config.ThinkingConfig.NativeMode):
//   - "off":   never attach native fields
//   - "auto":  (default) attach when the client asked for thinking on a
//     supported model
//   - "force": attach on every supported model, using the effort the upstream
//     schema declares as its default

// nativeThinkingConfig is the resolved decision for a single request.
type nativeThinkingConfig struct {
	Enabled bool
	Effort  string // one of the effort levels the model advertises
	Display string // summarized | omitted
}

// reasoningRequest is the resolved reasoning intent for a single request: an
// effort level plus whether the client asked for thinking explicitly (pinned on
// the model name or via the request body's thinking config).
type reasoningRequest struct {
	Effort string
	Pinned bool
	// Off records an explicit opt-out (thinking.type=disabled, effort "none").
	// It wins over everything, including NativeMode "force".
	Off bool
}

// clampEffortToLadder maps a requested effort onto the closest level a model
// actually advertises: the highest advertised rung at or below the request,
// falling back to the lowest advertised rung. This matters because the enums are
// not uniform — asking a model for "xhigh" when it does not list it must become
// "high" rather than a hard upstream 400.
func clampEffortToLadder(cap modelReasoningCapability, effort string) (string, bool) {
	if len(cap.Efforts) == 0 {
		return "", false
	}
	if cap.SupportsEffort(effort) {
		return effort, true
	}

	wantIdx := -1
	for i, rung := range effortLadder {
		if rung == effort {
			wantIdx = i
			break
		}
	}
	if wantIdx < 0 {
		return "", false
	}

	best := ""
	for _, advertised := range cap.Efforts {
		for i, rung := range effortLadder {
			if rung != advertised {
				continue
			}
			if i <= wantIdx {
				best = advertised
			}
			break
		}
	}
	if best != "" {
		return best, true
	}
	return cap.Efforts[0], true
}

// normalizeNativeThinkingEffort maps a client-provided effort level onto one the
// model advertises. Returns ("", false) when no directive should be sent.
//
// The only aliasing performed is for values the OpenAI API accepts but Kiro does
// not advertise:
//
//	"minimal" → the lowest advertised level (Kiro has no "minimal" rung)
//
// "none" is passed through when the model advertises it (GPT families list
// "none" in their enum, so the upstream can be told explicitly not to reason);
// on models without it, "none" means "send no directive at all". Anything else
// outside the advertised enum is clamped down the ladder rather than guessed at.
func normalizeNativeThinkingEffort(cap modelReasoningCapability, effort string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(effort))
	switch normalized {
	case "":
		return "", false
	case "none":
		if cap.SupportsNone {
			return "none", true
		}
		return "", false
	case "minimal":
		normalized = "low"
	}
	return clampEffortToLadder(cap, normalized)
}

// defaultEffortFor returns the effort to use when the gateway must supply one
// itself. It prefers the upstream-advertised default and otherwise takes the
// model's highest advertised level at or below "high".
func defaultEffortFor(cap modelReasoningCapability) string {
	if cap.DefaultEffort != "" && cap.SupportsEffort(cap.DefaultEffort) {
		return cap.DefaultEffort
	}
	if effort, ok := clampEffortToLadder(cap, "high"); ok {
		return effort
	}
	return ""
}

// effortForThinkingBudget maps Anthropic's extended-thinking budget_tokens onto
// the Kiro effort ladder. budget_tokens is the only knob the legacy
// `thinking: {type: "enabled", budget_tokens: N}` form carries, and it is what
// Claude Code sends, so it has to mean something here or every Claude Code
// request would fall through to the upstream default.
func effortForThinkingBudget(budget int) string {
	switch {
	case budget <= 0:
		return ""
	case budget <= 4096:
		return "low"
	case budget <= 16384:
		return "medium"
	case budget <= 32768:
		return "high"
	case budget <= 65536:
		return "xhigh"
	default:
		return "max"
	}
}

// claudeRequestEffort resolves the client-requested adaptive thinking effort
// from a full Claude request, in precedence order:
//
//  1. thinking.effort       (explicit per-thinking override)
//  2. output_config.effort  (Anthropic's canonical root-level location)
//  3. thinking.budget_tokens mapped onto the ladder (legacy "enabled" form)
//
// Returns "" when none is set.
func claudeRequestEffort(req *ClaudeRequest) string {
	if req == nil {
		return ""
	}
	if req.Thinking != nil {
		if e := strings.TrimSpace(req.Thinking.Effort); e != "" {
			return e
		}
	}
	if req.OutputConfig != nil {
		if e := strings.TrimSpace(req.OutputConfig.Effort); e != "" {
			return e
		}
	}
	if req.Thinking != nil {
		return effortForThinkingBudget(req.Thinking.BudgetTokens)
	}
	return ""
}

// resolveClaudeReasoningRequest merges the model-name intent (the configured
// thinking suffix, already stripped by resolveClaudeThinkingMode and handed in
// as suffixThinking) with the request body's thinking config.
func resolveClaudeReasoningRequest(req *ClaudeRequest, suffixThinking bool) reasoningRequest {
	rr := reasoningRequest{Effort: claudeRequestEffort(req), Pinned: suffixThinking}
	if req != nil && req.Thinking != nil {
		switch strings.ToLower(strings.TrimSpace(req.Thinking.Type)) {
		case "enabled", "adaptive":
			rr.Pinned = true
		case "disabled":
			// An explicit opt-out only counts when the model name did not pin
			// thinking on: a "-thinking" model is the user's own choice and the
			// client library may be injecting the disabled block by default.
			if !suffixThinking {
				rr.Off = true
			}
		}
	}
	if reasoningEffortDisabled(rr.Effort) {
		rr.Off = true
	}
	return rr
}

// resolveOpenAIReasoningRequest merges the model-name intent (the configured
// thinking suffix, handed in as suffixThinking) with the OpenAI-style
// reasoning_effort field.
func resolveOpenAIReasoningRequest(req *OpenAIRequest, suffixThinking bool) reasoningRequest {
	rr := reasoningRequest{Pinned: suffixThinking}
	if req != nil {
		rr.Effort = strings.TrimSpace(req.ReasoningEffort)
	}
	if rr.Effort != "" {
		rr.Pinned = true
	}
	if reasoningEffortDisabled(rr.Effort) {
		rr.Off = true
		rr.Pinned = suffixThinking
	}
	return rr
}

// buildNativeThinkingConfig decides whether and how to attach native thinking
// directives, given the resolved model, the resolved reasoning intent, and the
// gateway thinking config.
func buildNativeThinkingConfig(modelID string, rr reasoningRequest, thinkingCfg config.ThinkingConfig) nativeThinkingConfig {
	cap, ok := lookupModelReasoningCapability(modelID)
	if !ok || cap.Transport != reasoningTransportThinking {
		return nativeThinkingConfig{Enabled: false}
	}
	if rr.Off {
		return nativeThinkingConfig{Enabled: false}
	}

	mode := strings.ToLower(strings.TrimSpace(thinkingCfg.NativeMode))
	if mode == "" {
		mode = "auto"
	}
	if mode == "off" {
		return nativeThinkingConfig{Enabled: false}
	}

	nativeEffort, effortOK := normalizeNativeThinkingEffort(cap, rr.Effort)
	switch {
	case effortOK && !rr.Pinned && mode == "auto":
		// A body-supplied effort is itself a request for thinking.
	case effortOK:
		// Pinned, or "force": use the mapped effort as-is.
	case rr.Pinned || mode == "force":
		// Thinking was asked for (or forced) without a usable effort: fall back
		// to whatever the upstream schema declares as its default.
		nativeEffort = defaultEffortFor(cap)
		if nativeEffort == "" {
			return nativeThinkingConfig{Enabled: false}
		}
	default:
		return nativeThinkingConfig{Enabled: false}
	}

	return nativeThinkingConfig{
		Enabled: true,
		Effort:  nativeEffort,
		Display: resolveNativeDisplay(cap, thinkingCfg.NativeDisplay),
	}
}

// resolveNativeDisplay picks a thinking.display value the model advertises,
// preferring the configured one and falling back to "summarized".
func resolveNativeDisplay(cap modelReasoningCapability, configured string) string {
	display := strings.ToLower(strings.TrimSpace(configured))
	if cap.SupportsDisplay(display) {
		return display
	}
	if cap.SupportsDisplay("summarized") {
		return "summarized"
	}
	if len(cap.Displays) > 0 {
		return cap.Displays[0]
	}
	if display == "omitted" {
		return "omitted"
	}
	return "summarized"
}

// applyNativeThinking attaches native adaptive thinking directives to the Kiro
// payload (both at the root and on the current userInputMessage) when enabled.
// It is a no-op when nt.Enabled is false, so callers can invoke it
// unconditionally.
func applyNativeThinking(payload *KiroPayload, nt nativeThinkingConfig) {
	if payload == nil || !nt.Enabled || nt.Effort == "" {
		return
	}

	display := nt.Display
	if display != "summarized" && display != "omitted" {
		display = "summarized"
	}

	payload.Thinking = &KiroThinking{Type: "adaptive", Display: display}
	payload.OutputConfig = &KiroOutputConfig{Effort: nt.Effort}

	msg := &payload.ConversationState.CurrentMessage.UserInputMessage
	msg.Thinking = &KiroThinking{Type: "adaptive", Display: display}
	msg.OutputConfig = &KiroOutputConfig{Effort: nt.Effort}
}

// resolveAdditionalReasoningEffort returns the effort to send in
// additionalModelRequestFields.reasoning.effort, or "" when this model does not
// use that transport (or no directive should be sent at all).
//
// Unlike the Claude thinking directives, this is not gated by NativeMode: it is
// a passthrough of the reasoning effort the client itself asked for on a model
// whose reasoning is always on. NativeMode "force" only supplies a default when
// the client said nothing.
//
// "none" is a legal enum value on these models, so an explicit opt-out is sent
// through as effort=none instead of being silently dropped.
func resolveAdditionalReasoningEffort(modelID string, rr reasoningRequest, thinkingCfg config.ThinkingConfig) string {
	cap, ok := lookupModelReasoningCapability(modelID)
	if !ok || cap.Transport != reasoningTransportAdditionalFields {
		return ""
	}
	if rr.Off && cap.SupportsNone {
		return "none"
	}
	if mapped, ok := normalizeNativeThinkingEffort(cap, rr.Effort); ok {
		return mapped
	}
	// Unmappable value: an explicit request is honored as "no directive", while
	// an unspecified one may fall back to the configured default.
	if rr.Off {
		return ""
	}
	if rr.Pinned || strings.EqualFold(strings.TrimSpace(thinkingCfg.NativeMode), "force") {
		return defaultEffortFor(cap)
	}
	return ""
}

// reasoningEffortDisabled reports whether the client explicitly turned reasoning
// off. An explicit "none" is honored even under NativeMode "force"; an empty
// value merely means "unspecified".
func reasoningEffortDisabled(effort string) bool {
	return strings.EqualFold(strings.TrimSpace(effort), "none")
}

// applyAdditionalReasoningEffort attaches the GPT-family reasoning directive to
// the payload root. No mirrored copy is set on the current userInputMessage:
// the captured Kiro CLI request carries this field only at the top level.
func applyAdditionalReasoningEffort(payload *KiroPayload, effort string) {
	if payload == nil || effort == "" {
		return
	}
	payload.AdditionalModelRequestFields = &KiroAdditionalModelRequestFields{
		Reasoning: &KiroReasoningEffort{Effort: effort},
	}
}

// reasoningDecision is the resolved upstream reasoning directive for one
// request. Models exposing `reasoning` take
// additionalModelRequestFields.reasoning.effort; models exposing `thinking` take
// the Claude thinking/outputConfig pair. The two are mutually exclusive,
// matching both captured request shapes, and a model advertising neither gets
// nothing.
type reasoningDecision struct {
	Native    nativeThinkingConfig
	GPTEffort string
}

// ProducesReasoning reports whether the upstream will emit reasoning output (and
// therefore a signature) for this request. effort=none is a real directive that
// produces nothing, so it does not count.
func (d reasoningDecision) ProducesReasoning() bool {
	if d.GPTEffort != "" {
		return !reasoningEffortDisabled(d.GPTEffort)
	}
	return d.Native.Enabled
}

// Effort reports the effort level actually sent upstream, or "" when no
// directive was attached.
func (d reasoningDecision) Effort() string {
	if d.GPTEffort != "" {
		return d.GPTEffort
	}
	return d.Native.Effort
}

// resolveReasoningDirectives decides which reasoning directive to send for a
// request without mutating anything, so callers can build the payload knowing
// whether native thinking is in play.
func resolveReasoningDirectives(modelID string, rr reasoningRequest, thinkingCfg config.ThinkingConfig) reasoningDecision {
	if _, known := lookupModelReasoningCapability(modelID); !known && (rr.Effort != "" || rr.Pinned) {
		// The registry is filled from ListAvailableModels. If a client asks for
		// thinking on a model we have never seen advertised, say so instead of
		// silently dropping the request: it usually means the model-list refresh
		// failed for every account, and the turn will come back unsigned.
		logger.Warnf("[Thinking] no upstream capability data for model %q; requested effort %q ignored (no signature will be produced)", modelID, rr.Effort)
	}
	if effort := resolveAdditionalReasoningEffort(modelID, rr, thinkingCfg); effort != "" {
		return reasoningDecision{GPTEffort: effort}
	}
	return reasoningDecision{Native: buildNativeThinkingConfig(modelID, rr, thinkingCfg)}
}

// applyReasoningDecision writes a resolved decision onto the Kiro payload.
func applyReasoningDecision(payload *KiroPayload, d reasoningDecision) {
	if payload == nil {
		return
	}
	if d.GPTEffort != "" {
		applyAdditionalReasoningEffort(payload, d.GPTEffort)
		return
	}
	applyNativeThinking(payload, d.Native)
}

// applyReasoningDirectives resolves and attaches the upstream reasoning
// directive in one step.
func applyReasoningDirectives(payload *KiroPayload, modelID string, rr reasoningRequest, thinkingCfg config.ThinkingConfig) reasoningDecision {
	d := resolveReasoningDirectives(modelID, rr, thinkingCfg)
	applyReasoningDecision(payload, d)
	return d
}

// countClaudeThinkingSignals walks a Claude request's assistant history and
// reports how many thinking blocks were sent by the client and how many of
// those carried a non-empty signature. This is purely diagnostic: it lets an
// operator confirm (at debug log level) whether the client round-trips native
// thinking signatures back to the gateway on multi-turn conversations.
func countClaudeThinkingSignals(req *ClaudeRequest) (thinkingBlocks, signedBlocks int) {
	if req == nil {
		return 0, 0
	}
	for _, msg := range req.Messages {
		if msg.Role != "assistant" {
			continue
		}
		for _, block := range contentBlocksAsMaps(msg.Content) {
			if t, _ := block["type"].(string); t != "thinking" {
				continue
			}
			thinkingBlocks++
			if sig, _ := block["signature"].(string); strings.TrimSpace(sig) != "" {
				signedBlocks++
			}
		}
	}
	return thinkingBlocks, signedBlocks
}
