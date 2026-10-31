package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"kiro-go/config"
	"net/http"
	"strings"
	"time"
)

const defaultResponsesModel = "claude-sonnet-4.5"

func (h *Handler) handleOpenAIResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.sendOpenAIError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	var req ResponsesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.sendOpenAIError(w, 400, "invalid_request_error", "Invalid JSON")
		return
	}

	if strings.TrimSpace(req.Model) == "" {
		req.Model = defaultResponsesModel
	}

	storedInputCopy := append(json.RawMessage(nil), req.Input...)

	storeResponse := true
	if req.Store != nil {
		storeResponse = *req.Store
	}

	var historyMessages []OpenAIMessage
	if req.PreviousResponseID != "" {
		prev, loadErr := loadResponse(req.PreviousResponseID)
		if loadErr != nil {
			h.sendOpenAIError(w, 404, "invalid_request_error",
				fmt.Sprintf("previous_response_id not found: %v", loadErr))
			return
		}
		historyMessages = expandPreviousResponseHistory(prev)
	}

	inputMessages, err := parseResponsesInput(req.Input)
	if err != nil {
		h.sendOpenAIError(w, 400, "invalid_request_error", err.Error())
		return
	}

	finalMessages := make([]OpenAIMessage, 0, len(historyMessages)+len(inputMessages)+1)
	finalMessages = append(finalMessages, historyMessages...)
	if strings.TrimSpace(req.Instructions) != "" {
		// New instructions on this turn always take effect, even when
		// continuing from previous_response_id. Place them after the
		// expanded history so they apply to the current and future turns,
		// while ancestor instructions (re-emitted by expandPreviousResponseHistory)
		// stay in scope for the historical exchanges they shaped.
		finalMessages = append(finalMessages, OpenAIMessage{
			Role:    "system",
			Content: req.Instructions,
		})
	}
	finalMessages = append(finalMessages, inputMessages...)

	if len(finalMessages) == 0 {
		h.sendOpenAIError(w, 400, "invalid_request_error", "input must contain at least one message")
		return
	}

	hasUser := false
	for _, m := range finalMessages {
		if m.Role == "user" {
			hasUser = true
			break
		}
	}
	if !hasUser {
		h.sendOpenAIError(w, 400, "invalid_request_error", "input must contain at least one user message")
		return
	}

	openaiReq := &OpenAIRequest{
		Model:    req.Model,
		Messages: finalMessages,
		Stream:   req.Stream,
		Tools:    req.Tools,
	}
	if req.Temperature != nil {
		openaiReq.Temperature = *req.Temperature
	}
	if req.MaxOutputTokens != nil {
		openaiReq.MaxTokens = *req.MaxOutputTokens
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, suffixThinking := ParseModelAndThinking(req.Model, thinkingCfg.Suffix)
	openaiReq.Model = actualModel
	thinking := suffixThinking
	if req.Reasoning != nil && strings.TrimSpace(req.Reasoning.Effort) != "" && !reasoningEffortDisabled(req.Reasoning.Effort) {
		thinking = true
		openaiReq.ReasoningEffort = strings.TrimSpace(req.Reasoning.Effort)
	}

	estimatedInputTokens := estimateOpenAIRequestInputTokens(openaiReq)
	// Reasoning comes only from the native directive; no thinking prompt is
	// injected into the system prompt.
	reasoning := resolveReasoningDirectives(MapModel(actualModel), resolveOpenAIReasoningRequest(openaiReq, suffixThinking), thinkingCfg)
	thinking = thinking || reasoning.ProducesReasoning()

	kiroPayload := OpenAIToKiro(openaiReq)
	applyReasoningDecision(kiroPayload, reasoning)

	apiKeyID := apiKeyIDFromContext(r.Context())
	respID := generateResponseID()

	if req.Stream {
		h.handleResponsesStream(w, kiroPayload, actualModel, thinking, estimatedInputTokens,
			apiKeyID, respID, &req, storedInputCopy, storeResponse)
		return
	}

	h.handleResponsesNonStream(w, kiroPayload, actualModel, thinking, estimatedInputTokens,
		apiKeyID, respID, &req, storedInputCopy, storeResponse)
}

func (h *Handler) handleResponsesNonStream(
	w http.ResponseWriter, payload *KiroPayload, model string, thinking bool,
	estimatedInputTokens int, apiKeyID, respID string,
	req *ResponsesRequest, storedInput json.RawMessage, storeResponse bool,
) {
	releaseCredit, admitted := globalCreditHolds.reserve(apiKeyID)
	if !admitted {
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "credit limit exceeded")
		return
	}
	defer func() { releaseCredit(0) }()

	excluded := make(map[string]bool)
	var lastErr error
	var lastAccountID string
	reqStart := time.Now()

	stickyID := h.sticky.Lookup(payload.ConversationState.ConversationID)
	for attempt := 0; attempt < maxAccountRetryAttempts; attempt++ {
		account := h.pool.GetNextForModelSticky(model, stickyID, excluded)
		if account == nil {
			break
		}
		if err := h.ensureValidToken(account); err != nil {
			lastErr = err
			excluded[account.ID] = true
			lastAccountID = account.ID
			h.handleAccountFailure(account, err)
			continue
		}

		var inputTokens, outputTokens int
		var credits float64
		var realInputTokens int

		// emit is nil: the same builder assembles the item list without
		// streaming, so the non-stream body can never describe a different
		// shape than the streaming path would have produced.
		out := newResponsesOutputBuilder(thinking, nil)

		callback := &KiroStreamCallback{
			OnText: func(text string, isThinking bool) {
				if isThinking {
					out.Reasoning(text)
				} else {
					out.Text(text)
				}
			},
			OnToolUse:  func(tu KiroToolUse) { out.ToolUse(tu) },
			OnComplete: func(inTok, outTok int) { inputTokens = inTok; outputTokens = outTok },
			OnCredits:  func(c float64) { credits = c },
			OnContextUsage: func(pct float64) {
				realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
			},
			OnSignature:         func(sig string) { out.Signature(sig) },
			OnRedactedReasoning: func(blob string) { out.Redacted(blob) },
		}

		err := CallKiroAPI(account, payload, callback)
		if err != nil {
			lastErr = err
			excluded[account.ID] = true
			lastAccountID = account.ID
			if markInputTooLong(err, model, estimatedInputTokens) {
				break
			}
			h.handleAccountModelFailure(account, model, err)
			continue
		}

		items := out.Finish()
		finalContent := out.AnswerText()
		reasoningContent := out.ReasoningOutput()
		toolUses := out.ToolUses()

		if realInputTokens > 0 {
			inputTokens = realInputTokens
		} else if inputTokens <= 0 {
			inputTokens = estimatedInputTokens
		}
		outputTokens = estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)

		h.recordSuccessForApiKey(apiKeyID, inputTokens, outputTokens, credits)
		h.pool.RecordSuccess(account.ID)
		h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)
		h.recordSuccessLog(w, "responses", model, account.ID, inputTokens, outputTokens, credits, time.Since(reqStart).Milliseconds())
		h.sticky.Remember(payload.ConversationState.ConversationID, account.ID)

		respObj := newResponsesObject(respID, model, items, inputTokens, outputTokens, req)
		respObj.StoredInput = storedInput
		respObj.Instructions = req.Instructions

		if storeResponse {
			if saveErr := saveResponse(respObj); saveErr != nil {
				logResponsesPersistFailure(respObj.ID, saveErr)
			}
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(respObj)
		return
	}

	if lastErr == nil {
		h.recordFailureWithDuration(w, "responses", model, "", errNoAvailableAccounts, time.Since(reqStart).Milliseconds())
		h.sendNoAvailableAccounts(w, endpointKindOpenAI)
		return
	}
	h.recordFailureWithDuration(w, "responses", model, lastAccountID, lastErr, time.Since(reqStart).Milliseconds())
	setRetryAfterHeader(w, lastErr)
	h.sendOpenAIError(w, upstreamErrorHTTPStatus(lastErr), clientErrorType(lastErr, "server_error"), lastErr.Error())
}

// newResponsesObject assembles the terminal response object from an already
// ordered output list. Both the non-stream path and the streaming path go
// through here, so `response.completed` always mirrors what was emitted.
func newResponsesObject(
	id, model string, output []ResponseOutputItem,
	inputTokens, outputTokens int, req *ResponsesRequest,
) *ResponsesObject {
	if len(output) == 0 {
		// A turn that produced nothing still has to return a well-formed
		// assistant message: clients index output[0] unconditionally.
		output = []ResponseOutputItem{newMessageOutputItem(generateOutputItemID("msg"), "completed", "")}
	}

	return &ResponsesObject{
		ID:                 id,
		Object:             "response",
		CreatedAt:          time.Now().Unix(),
		Status:             "completed",
		Model:              model,
		Output:             output,
		Usage:              ResponsesUsage{InputTokens: inputTokens, OutputTokens: outputTokens, TotalTokens: inputTokens + outputTokens},
		PreviousResponseID: req.PreviousResponseID,
		Metadata:           req.Metadata,
	}
}

func (h *Handler) handleResponsesStream(
	w http.ResponseWriter, payload *KiroPayload, model string, thinking bool,
	estimatedInputTokens int, apiKeyID, respID string,
	req *ResponsesRequest, storedInput json.RawMessage, storeResponse bool,
) {
	releaseCredit, admitted := globalCreditHolds.reserve(apiKeyID)
	if !admitted {
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "credit limit exceeded")
		return
	}
	defer func() { releaseCredit(0) }()

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.sendOpenAIError(w, 500, "server_error", "Streaming not supported")
		return
	}

	send := func(eventName string, payload interface{}) {
		data, err := json.Marshal(payload)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventName, string(data))
		flusher.Flush()
	}

	// sendFailure terminates the stream with response.failed followed by the
	// [DONE] sentinel. The success path emits [DONE] (see the end of the attempt
	// loop); every failure path used to return right after response.failed, so a
	// client waiting on the sentinel hung on an open stream that would never
	// produce another event. One helper keeps all failure exits in sync.
	sendFailure := func(message string) {
		send("response.failed", map[string]interface{}{
			"type": "response.failed",
			"response": map[string]interface{}{
				"id":     respID,
				"status": "failed",
				"error": map[string]string{
					"type":    "server_error",
					"message": message,
				},
			},
		})
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}

	createdAt := time.Now().Unix()
	initial := &ResponsesObject{
		ID:                 respID,
		Object:             "response",
		CreatedAt:          createdAt,
		Status:             "in_progress",
		Model:              model,
		Output:             []ResponseOutputItem{},
		Usage:              ResponsesUsage{},
		PreviousResponseID: req.PreviousResponseID,
		Metadata:           req.Metadata,
	}
	send("response.created", map[string]interface{}{
		"type":     "response.created",
		"response": initial,
	})

	excluded := make(map[string]bool)
	var lastErr error
	var lastAccountID string
	responseStarted := false
	reqStart := time.Now()

	stickyID := h.sticky.Lookup(payload.ConversationState.ConversationID)
	for attempt := 0; attempt < maxAccountRetryAttempts; attempt++ {
		account := h.pool.GetNextForModelSticky(model, stickyID, excluded)
		if account == nil {
			break
		}
		if err := h.ensureValidToken(account); err != nil {
			lastErr = err
			excluded[account.ID] = true
			lastAccountID = account.ID
			h.handleAccountFailure(account, err)
			continue
		}

		send("response.in_progress", map[string]interface{}{
			"type":     "response.in_progress",
			"response": initial,
		})

		var (
			inputTokens     int
			outputTokens    int
			credits         float64
			realInputTokens int
		)

		out := newResponsesOutputBuilder(thinking, func(event string, payload map[string]interface{}) {
			send(event, payload)
			responseStarted = true
		})

		callback := &KiroStreamCallback{
			OnText: func(text string, isThinking bool) {
				if isThinking {
					out.Reasoning(text)
				} else {
					out.Text(text)
				}
			},
			OnToolUse:           func(tu KiroToolUse) { out.ToolUse(tu) },
			OnComplete:          func(inTok, outTok int) { inputTokens = inTok; outputTokens = outTok },
			OnCredits:           func(c float64) { credits = c },
			OnSignature:         func(sig string) { out.Signature(sig) },
			OnRedactedReasoning: func(blob string) { out.Redacted(blob) },
			OnContextUsage: func(pct float64) {
				realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
			},
		}

		err := CallKiroAPI(account, payload, callback)
		if err != nil {
			if !responseStarted {
				lastErr = err
				excluded[account.ID] = true
				lastAccountID = account.ID
				if markInputTooLong(err, model, estimatedInputTokens) {
					break
				}
				h.handleAccountModelFailure(account, model, err)
				continue
			}
			sendFailure(err.Error())
			h.recordFailureWithDuration(w, "responses", model, account.ID, err, time.Since(reqStart).Milliseconds())
			// Partial output was already generated and metered upstream; attribute
			// it instead of dropping the request from the key's usage entirely.
			h.recordPartialUsageForApiKey(apiKeyID, inputTokens, outputTokens, credits)
			return
		}

		items := out.Finish()
		finalContent := out.AnswerText()
		reasoning := out.ReasoningOutput()
		toolUses := out.ToolUses()

		if realInputTokens > 0 {
			inputTokens = realInputTokens
		} else if inputTokens <= 0 {
			inputTokens = estimatedInputTokens
		}
		outputTokens = estimateOpenAIOutputTokens(finalContent, reasoning, toolUses)

		h.recordSuccessForApiKey(apiKeyID, inputTokens, outputTokens, credits)
		h.pool.RecordSuccess(account.ID)
		h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)
		h.recordSuccessLog(w, "responses", model, account.ID, inputTokens, outputTokens, credits, time.Since(reqStart).Milliseconds())
		h.sticky.Remember(payload.ConversationState.ConversationID, account.ID)

		respObj := newResponsesObject(respID, model, items, inputTokens, outputTokens, req)
		respObj.CreatedAt = createdAt
		respObj.StoredInput = storedInput
		respObj.Instructions = req.Instructions

		if storeResponse {
			if saveErr := saveResponse(respObj); saveErr != nil {
				logResponsesPersistFailure(respObj.ID, saveErr)
			}
		}

		send("response.completed", map[string]interface{}{
			"type":     "response.completed",
			"response": respObj,
		})
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
		return
	}

	if lastErr == nil {
		h.recordFailureWithDuration(w, "responses", model, "", errNoAvailableAccounts, time.Since(reqStart).Milliseconds())
		// The SSE envelope is already open so no Retry-After header is possible
		// here, but the reason still has to reach the client rather than only
		// the request log.
		sendFailure(errNoAvailableAccounts.Error())
		return
	}
	h.recordFailureWithDuration(w, "responses", model, lastAccountID, lastErr, time.Since(reqStart).Milliseconds())
	sendFailure(lastErr.Error())
}
