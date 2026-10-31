package proxy

import (
	"fmt"
	"kiro-go/logger"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// collectToolResultIDs returns the set of toolUseId values referenced by the
// given tool results.
func collectToolResultIDs(toolResults []KiroToolResult) map[string]bool {
	if len(toolResults) == 0 {
		return nil
	}
	ids := make(map[string]bool, len(toolResults))
	for _, tr := range toolResults {
		if id := strings.TrimSpace(tr.ToolUseID); id != "" {
			ids[id] = true
		}
	}
	return ids
}

// currentToolResultsMatchLastAssistant reports whether the current message's
// tool results answer the structured tool calls of the final history assistant
// message. Only in that case may the current toolResults stay structured.
func currentToolResultsMatchLastAssistant(history []KiroHistoryMessage, currentToolResultIDs map[string]bool) bool {
	if len(currentToolResultIDs) == 0 || len(history) == 0 {
		return false
	}
	last := history[len(history)-1]
	if last.AssistantResponseMessage == nil || len(last.AssistantResponseMessage.ToolUses) == 0 {
		return false
	}
	for _, tu := range last.AssistantResponseMessage.ToolUses {
		if !currentToolResultIDs[tu.ToolUseID] {
			return false
		}
	}
	return true
}

// pollutedToolCallTextPattern matches the legacy "[Called tool X with input ...]"
// / "[Called tool X]" narration that an earlier version of this proxy wrote into
// assistant turns. Models trained on that in-context text began emitting it as
// output instead of issuing real tool calls; clients then stored that output as
// assistant history and replay it, re-seeding the pollution. We strip it from
// assistant content on the way back upstream so the pattern is not reinforced
// and the model can recover within an ongoing session.
var pollutedToolCallTextPattern = regexp.MustCompile(`\[Called tool [^\]]*\]`)

// stripPollutedToolCallText removes legacy tool-call narration from text and
// tidies up the leftover whitespace.
func stripPollutedToolCallText(content string) string {
	if !strings.Contains(content, "[Called tool ") {
		return content
	}
	cleaned := pollutedToolCallTextPattern.ReplaceAllString(content, "")
	// Collapse blank lines left behind by removed markers.
	cleaned = regexp.MustCompile(`\n{3,}`).ReplaceAllString(cleaned, "\n\n")
	return strings.TrimSpace(cleaned)
}

// narrateToolResults renders structured tool results as plain text for a user
// history turn. Each result is attributed to its originating tool call (by name)
// when that mapping is known, so the model retains the tool's identity without
// any assistant-side tool-invocation syntax to imitate.
//
// IMPORTANT: tool activity must never be narrated into ASSISTANT turns. Earlier
// versions wrote "[Called tool X with input ...]" into assistant content, which
// trained the model (via dozens of in-context examples) to emit that literal
// text instead of issuing real structured tool calls. All tool narration lives
// in user "Tool results" turns, which the model reads but never authors, so it
// has no invocation pattern to copy.
func narrateToolResults(toolResults []KiroToolResult, names map[string]string) string {
	if len(toolResults) == 0 {
		return ""
	}
	parts := make([]string, 0, len(toolResults))
	for _, tr := range toolResults {
		var texts []string
		for _, c := range tr.Content {
			if strings.TrimSpace(c.Text) != "" {
				texts = append(texts, c.Text)
			}
		}
		body := strings.Join(texts, "\n")
		if strings.TrimSpace(body) == "" {
			body = "(no output)"
		}
		if name := names[tr.ToolUseID]; name != "" {
			parts = append(parts, fmt.Sprintf("[%s] %s", name, body))
		} else {
			parts = append(parts, body)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return toolResultsContinuationPrefix + "\n\n" + strings.Join(parts, "\n\n")
}

// joinHistoryText combines an existing message body with narrated tool text.
func joinHistoryText(existing, narrated string) string {
	existing = strings.TrimSpace(existing)
	narrated = strings.TrimSpace(narrated)
	switch {
	case existing != "" && narrated != "":
		return existing + "\n\n" + narrated
	case narrated != "":
		return narrated
	default:
		return existing
	}
}

// sanitizeKiroHistory normalizes tool activity in history to the shape the real
// Kiro CLI sends on the wire (verified against a captured session):
//
//   - EVERY assistant turn keeps its structured toolUses, and the user turn
//     immediately after it keeps the matching structured toolResults with an
//     EMPTY content string. History strictly alternates user/assistant and
//     starts with a user turn.
//   - Only genuinely broken tool pairs are flattened into text: results with no
//     preceding call, or calls whose results never arrived (e.g. after
//     client-side context compaction dropped one side). The upstream rejects
//     those, so they are narrated on the user side instead.
//
// Earlier versions flattened ALL but one tool pair into "Tool results:" prose.
// That taught the model — via dozens of in-context examples — that tool activity
// is expressed as prose, so it would answer with a narrative instead of emitting
// a real tool call, and the turn came back END_TURN with no toolUseEvent. The
// client's agent loop then halted mid-task.
//
// currentToolResultIDs is the set of toolUseId values carried by the current
// (outgoing) message; it answers the final history assistant turn.
func sanitizeKiroHistory(history []KiroHistoryMessage, currentToolResultIDs map[string]bool) []KiroHistoryMessage {
	if len(history) == 0 {
		return history
	}

	// Map every tool-use ID to its tool name across all assistant turns, so a
	// tool result that must be flattened can still be attributed to the tool it
	// came from.
	toolNames := collectHistoryToolNames(history)

	history = scrubKiroHistoryText(history)
	history = enforceKiroAlternation(history, toolNames)
	history = reconcileKiroToolPairs(history, currentToolResultIDs, toolNames)

	return sealHistoryHead(history, toolNames)
}

// alignHistoryToolNames rewrites tool-call names in history to the exact names
// the current request's tool specifications are sent with.
//
// convertClaudeTools camelCases tool names for Kiro ("exec_command" becomes
// "execCommand"), but a replayed history carries the client's original
// spelling. The upstream then sees tool calls naming a tool it was never
// given: asked to summarize such a history, the model answered that the calls
// "used the name exec_command although the tool I was given is called
// execCommand, so I can't be sure those results came from a real run".
//
// nameMap is the sanitized→original mapping produced alongside the specs, so
// the rename always lands on the spelling actually on the wire. Names with no
// entry are left alone — not every spec is sanitized (the gateway's own
// web_search tool is injected under its literal name), and guessing would
// break those.
func alignHistoryToolNames(history []KiroHistoryMessage, nameMap map[string]string) {
	if len(nameMap) == 0 {
		return
	}
	originalToSpec := make(map[string]string, len(nameMap))
	for spec, original := range nameMap {
		originalToSpec[original] = spec
	}
	for i := range history {
		a := history[i].AssistantResponseMessage
		if a == nil {
			continue
		}
		for j := range a.ToolUses {
			if spec, ok := originalToSpec[a.ToolUses[j].Name]; ok {
				a.ToolUses[j].Name = spec
			}
		}
	}
}

// collectHistoryToolNames maps every toolUseId in history to its tool name.
func collectHistoryToolNames(history []KiroHistoryMessage) map[string]string {
	toolNames := make(map[string]string)
	for i := range history {
		if a := history[i].AssistantResponseMessage; a != nil {
			for _, tu := range a.ToolUses {
				if tu.ToolUseID != "" && tu.Name != "" {
					toolNames[tu.ToolUseID] = tu.Name
				}
			}
		}
	}
	return toolNames
}

// sealHistoryHead makes history start with a user turn (the upstream rejects a
// leading assistant turn) without orphaning tool results. Dropping a leading
// assistant turn removes the toolUses that the following user turn's structured
// toolResults answer, so those results are narrated into text instead — an
// unanswered toolUseId is what triggers the upstream's
// "unexpected tool_use_id found in tool_result blocks" 400.
func sealHistoryHead(history []KiroHistoryMessage, toolNames map[string]string) []KiroHistoryMessage {
	history = trimLeadingAssistantHistory(history)
	if len(history) == 0 {
		return history
	}
	u := history[0].UserInputMessage
	if u == nil || u.UserInputMessageContext == nil || len(u.UserInputMessageContext.ToolResults) == 0 {
		return history
	}
	u.Content = joinHistoryText(u.Content, narrateToolResults(u.UserInputMessageContext.ToolResults, toolNames))
	u.UserInputMessageContext = nil
	if strings.TrimSpace(u.Content) == "" && len(u.Images) == 0 {
		return history[1:]
	}
	return history
}

// scrubKiroHistoryText removes legacy "[Called tool ...]" narration a polluted
// client may be replaying as assistant text, strips structured tool specs from
// history turns (only the current message may carry `tools`), and drops assistant
// turns that carry neither content nor tool calls. It does NOT touch structured
// toolUses/toolResults.
func scrubKiroHistoryText(history []KiroHistoryMessage) []KiroHistoryMessage {
	cleaned := make([]KiroHistoryMessage, 0, len(history))
	for i := range history {
		msg := history[i]

		if a := msg.AssistantResponseMessage; a != nil {
			if a.Content != "" {
				a.Content = stripPollutedToolCallText(a.Content)
			}
			// A "." placeholder is an artifact of an earlier version of this
			// proxy (and is replayed by clients that stored it). Clear it: an
			// assistant turn with tool calls is legal with empty content, and a
			// turn with neither is dropped below.
			if strings.TrimSpace(a.Content) == minimalFallbackUserContent {
				a.Content = ""
			}
			if strings.TrimSpace(a.Content) == "" && len(a.ToolUses) == 0 && a.ReasoningContent == nil {
				continue // hollow assistant turn carries no information
			}
		}

		if u := msg.UserInputMessage; u != nil && u.UserInputMessageContext != nil {
			// History turns never carry tool specifications upstream.
			u.UserInputMessageContext.Tools = nil
			if len(u.UserInputMessageContext.ToolResults) == 0 {
				u.UserInputMessageContext = nil
			}
		}

		cleaned = append(cleaned, msg)
	}
	return cleaned
}

// kiroReasoningIsVerifiable reports whether a reasoningContent carries material
// the upstream verifies (a signature) or must receive back verbatim (a redacted
// blob), as opposed to unsigned reasoning text nothing depends on.
func kiroReasoningIsVerifiable(rc *KiroReasoningContent) bool {
	if rc == nil {
		return false
	}
	if rc.RedactedContent != "" {
		return true
	}
	return rc.ReasoningText != nil && rc.ReasoningText.Signature != ""
}

// mergeKiroReasoningContent resolves the reasoning of two assistant turns that
// are being merged into one. Only one can survive — the Kiro history shape has a
// single reasoningContent per assistant turn — and the pair inside the surviving
// one is never recombined with the other's. The later turn wins when it carries
// verifiable material, matching selectKiroReasoningContent: it is the reasoning
// closest to the tool calls and text that follow.
func mergeKiroReasoningContent(existing, incoming *KiroReasoningContent) *KiroReasoningContent {
	switch {
	case incoming == nil:
		return existing
	case existing == nil:
		return incoming
	case kiroReasoningIsVerifiable(incoming):
		if kiroReasoningIsVerifiable(existing) {
			logger.Debugf("[Thinking] merged two assistant turns that both carried signed reasoning; keeping the later one (upstream has one reasoningContent slot)")
		}
		return incoming
	default:
		return existing
	}
}

// enforceKiroAlternation merges consecutive same-role turns so history strictly
// alternates user/assistant, matching the real client. A gap (e.g. an assistant
// turn dropped as hollow) would otherwise leave two adjacent user turns, which
// also breaks the "results follow their call" adjacency the upstream relies on.
//
// When merging two user turns, only the FIRST turn's structured toolResults can
// still be adjacent to their originating assistant turn; the second turn's
// results are narrated into text.
func enforceKiroAlternation(history []KiroHistoryMessage, toolNames map[string]string) []KiroHistoryMessage {
	merged := make([]KiroHistoryMessage, 0, len(history))
	for i := range history {
		msg := history[i]
		if len(merged) == 0 {
			merged = append(merged, msg)
			continue
		}

		last := &merged[len(merged)-1]

		switch {
		case last.UserInputMessage != nil && msg.UserInputMessage != nil:
			cur := msg.UserInputMessage
			text := strings.TrimSpace(cur.Content)
			if cur.UserInputMessageContext != nil && len(cur.UserInputMessageContext.ToolResults) > 0 {
				if last.UserInputMessage.UserInputMessageContext == nil ||
					len(last.UserInputMessage.UserInputMessageContext.ToolResults) == 0 {
					// The earlier turn holds no results, so these can keep the
					// adjacency to the preceding assistant turn.
					last.UserInputMessage.UserInputMessageContext = cur.UserInputMessageContext
				} else {
					text = joinHistoryText(text, narrateToolResults(cur.UserInputMessageContext.ToolResults, toolNames))
				}
			}
			last.UserInputMessage.Content = joinHistoryText(last.UserInputMessage.Content, text)
			last.UserInputMessage.Images = append(last.UserInputMessage.Images, cur.Images...)

		case last.AssistantResponseMessage != nil && msg.AssistantResponseMessage != nil:
			cur := msg.AssistantResponseMessage
			last.AssistantResponseMessage.Content = joinHistoryText(last.AssistantResponseMessage.Content, cur.Content)
			last.AssistantResponseMessage.ToolUses = append(last.AssistantResponseMessage.ToolUses, cur.ToolUses...)
			last.AssistantResponseMessage.ReasoningContent = mergeKiroReasoningContent(
				last.AssistantResponseMessage.ReasoningContent, cur.ReasoningContent)

		default:
			merged = append(merged, msg)
		}
	}
	return merged
}

// reconcileKiroToolPairs keeps structured tool pairs that are complete and
// flattens the ones that are not. A pair is complete when every toolUseId of an
// assistant turn is answered by the toolResults of the turn that follows it (the
// next user history turn, or the current message for the final assistant turn).
func reconcileKiroToolPairs(history []KiroHistoryMessage, currentToolResultIDs map[string]bool, toolNames map[string]string) []KiroHistoryMessage {
	paired := make([]bool, len(history))

	for i := range history {
		a := history[i].AssistantResponseMessage
		if a == nil || len(a.ToolUses) == 0 {
			continue
		}

		answers := currentToolResultIDs
		answerIdx := -1
		if i+1 < len(history) {
			next := history[i+1].UserInputMessage
			if next == nil || next.UserInputMessageContext == nil {
				answers = nil
			} else {
				answers = collectToolResultIDs(next.UserInputMessageContext.ToolResults)
				answerIdx = i + 1
			}
		}

		if toolUsesFullyAnswered(a.ToolUses, answers) {
			// Complete pair: keep both sides structured, exactly like the real
			// client. Stamp a messageId, which the Kiro CLI always sends on
			// assistant turns that carry tool calls.
			if a.MessageID == "" {
				a.MessageID = deriveToolTurnMessageID(a.ToolUses)
			}
			if answerIdx >= 0 {
				paired[answerIdx] = true
				// A user turn answering tool calls carries empty content
				// upstream; never inject a "." or narration placeholder there.
				history[answerIdx].UserInputMessage.Content = strings.TrimSpace(history[answerIdx].UserInputMessage.Content)
			}
			continue
		}

		// Broken pair: drop the structured calls without writing any
		// tool-invocation text into the assistant turn (that prose is what the
		// model learns to imitate). Tool identity survives on the result side.
		a.ToolUses = nil
		a.MessageID = ""
	}

	cleaned := make([]KiroHistoryMessage, 0, len(history))
	for i := range history {
		msg := history[i]
		u := msg.UserInputMessage

		if u != nil && u.UserInputMessageContext != nil && len(u.UserInputMessageContext.ToolResults) > 0 && !paired[i] {
			// Orphaned results (their call is gone, e.g. compaction dropped it):
			// narrate them so the upstream does not reject the request.
			narrated := narrateToolResults(u.UserInputMessageContext.ToolResults, toolNames)
			u.Content = joinHistoryText(u.Content, narrated)
			u.UserInputMessageContext = nil
		}

		if a := msg.AssistantResponseMessage; a != nil &&
			strings.TrimSpace(a.Content) == "" && len(a.ToolUses) == 0 && a.ReasoningContent == nil {
			continue // became hollow after dropping a broken tool pair
		}

		if u != nil && strings.TrimSpace(u.Content) == "" && len(u.Images) == 0 &&
			(u.UserInputMessageContext == nil || len(u.UserInputMessageContext.ToolResults) == 0) {
			continue // nothing left to say in this user turn
		}

		cleaned = append(cleaned, msg)
	}

	// Dropping turns may have broken alternation again.
	return enforceKiroAlternation(cleaned, toolNames)
}

// toolUsesFullyAnswered reports whether every tool call is answered by the given
// set of tool-result IDs.
func toolUsesFullyAnswered(toolUses []KiroToolUse, answered map[string]bool) bool {
	if len(answered) == 0 {
		return false
	}
	for _, tu := range toolUses {
		if tu.ToolUseID == "" || !answered[tu.ToolUseID] {
			return false
		}
	}
	return true
}

// deriveToolTurnMessageID produces a stable UUID for an assistant tool turn.
// It is derived from the tool-use IDs so the same history turn keeps the same
// messageId across requests in a conversation (the real client replays a stable
// messageId; a value that churned every request would make the history look
// different to the upstream on every turn).
func deriveToolTurnMessageID(toolUses []KiroToolUse) string {
	ids := make([]string, 0, len(toolUses))
	for _, tu := range toolUses {
		ids = append(ids, tu.ToolUseID)
	}
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("kiro-go/message/"+strings.Join(ids, ","))).String()
}

func buildToolResultsContinuation(toolResults []KiroToolResult) string {
	if len(toolResults) == 0 {
		return minimalFallbackUserContent
	}

	parts := make([]string, 0, len(toolResults))
	for _, tr := range toolResults {
		if len(tr.Content) == 0 {
			continue
		}
		for _, c := range tr.Content {
			if strings.TrimSpace(c.Text) != "" {
				parts = append(parts, c.Text)
			}
		}
	}

	if len(parts) == 0 {
		return minimalFallbackUserContent
	}

	// Never trimmed: the tool output is the only copy of that information left
	// in the conversation once the structured pair is gone.
	return toolResultsContinuationPrefix + "\n\n" + strings.Join(parts, "\n\n")
}

func trimLeadingAssistantHistory(history []KiroHistoryMessage) []KiroHistoryMessage {
	idx := 0
	for idx < len(history) && history[idx].AssistantResponseMessage != nil {
		idx++
	}
	if idx == 0 {
		return history
	}
	if idx >= len(history) {
		return nil
	}
	return history[idx:]
}
