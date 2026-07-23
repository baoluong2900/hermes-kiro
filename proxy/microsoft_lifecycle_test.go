package proxy

import (
	"encoding/json"
	"fmt"
	"kiro-go/auth"
	"kiro-go/config"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestExternalIdpJSONImportRejectsDuplicateIDBeforeRefresh(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	const existingID = "12345678-1234-4123-8123-123456789012"
	if err := config.AddAccount(config.Account{
		ID:           existingID,
		RefreshToken: "already-persisted-refresh-token",
		Enabled:      true,
	}); err != nil {
		t.Fatalf("seed existing account: %v", err)
	}

	var outboundRequests int
	authClient := &http.Client{
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			outboundRequests++
			return nil, fmt.Errorf("duplicate ID must be rejected before outbound request: %s", request.URL)
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"id":            existingID,
		"refreshToken":  "different-refresh-token",
		"clientId":      handlerMicrosoftClientID,
		"authMethod":    auth.MicrosoftSSOAuthMethod,
		"tokenEndpoint": handlerMicrosoftTokenEndpoint(),
		"issuerUrl":     handlerMicrosoftIssuerURL(),
		"scopes":        handlerMicrosoftScopes(),
	})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("duplicate ID status = %d, want 409; body=%s", recorder.Code, recorder.Body.String())
	}
	if outboundRequests != 0 {
		t.Fatalf("outbound refresh requests = %d, want zero", outboundRequests)
	}
	if accounts := config.GetAccounts(); len(accounts) != 1 || accounts[0].ID != existingID {
		t.Fatalf("duplicate ID import changed persisted accounts: %+v", accounts)
	}
}

func TestBareMicrosoftCredentialBlobIsDetectedAndImported(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	sourceAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "source@example.com",
		"exp":                time.Now().Add(30 * time.Minute).Unix(),
	})
	refreshedAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "bare-import@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})

	var refreshRequests int
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			refreshRequests++
			if request.Method != http.MethodPost || request.URL.String() != tokenEndpoint {
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
			if err := request.ParseForm(); err != nil {
				return nil, fmt.Errorf("parse refresh form: %w", err)
			}
			if got := request.Form.Get("grant_type"); got != "refresh_token" {
				t.Errorf("grant_type = %q, want refresh_token", got)
			}
			if got := request.Form.Get("refresh_token"); got != "bare-refresh-token" {
				t.Errorf("refresh_token = %q, want bare-refresh-token", got)
			}
			if got := request.Form.Get("client_id"); got != handlerMicrosoftClientID {
				t.Errorf("client_id = %q, want %q", got, handlerMicrosoftClientID)
			}
			if got := request.Form.Get("scope"); got != scopes {
				t.Errorf("scope = %q, want %q", got, scopes)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"access_token":  refreshedAccessToken,
				"refresh_token": "bare-rotated-refresh-token",
				"expires_in":    3600,
				"token_type":    "Bearer",
			}), nil
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	// Deliberately omit authMethod, provider, issuerUrl, tokenEndpoint and
	// userId. The allow-listed issuer hint carried by the supplied access JWT is
	// enough to classify the shape; the mandatory live refresh still validates
	// the credential against the tenant-bound Microsoft token endpoint.
	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"clientId":     handlerMicrosoftClientID,
		"accessToken":  sourceAccessToken,
		"refreshToken": "bare-refresh-token",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("bare Microsoft import status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if refreshRequests != 1 {
		t.Fatalf("refresh requests = %d, want one", refreshRequests)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("accounts = %+v, want one imported account", accounts)
	}
	got := accounts[0]
	if got.AuthMethod != auth.MicrosoftSSOAuthMethod || got.Provider != auth.MicrosoftSSOProvider {
		t.Fatalf("bare credential was not classified as Microsoft external_idp: authMethod=%q provider=%q",
			got.AuthMethod, got.Provider)
	}
	if got.TokenEndpoint != tokenEndpoint || got.IssuerURL != issuerURL || got.Scopes != scopes {
		t.Fatalf("derived external-IdP configuration mismatch: endpoint=%q issuer=%q scopes=%q",
			got.TokenEndpoint, got.IssuerURL, got.Scopes)
	}
	if got.AccessToken != refreshedAccessToken || got.RefreshToken != "bare-rotated-refresh-token" {
		t.Fatalf("live refresh result was not persisted: access=%q refresh=%q",
			got.AccessToken, got.RefreshToken)
	}
	if got.Email != "bare-import@example.com" ||
		got.UserId != issuerURL+"."+handlerMicrosoftObjectID {
		t.Fatalf("refreshed identity mismatch: email=%q userId=%q", got.Email, got.UserId)
	}
	if got.RefreshTokenFingerprint != config.RefreshTokenFingerprint("bare-refresh-token") {
		t.Fatalf("original refresh-token fingerprint = %q, want source credential fingerprint",
			got.RefreshTokenFingerprint)
	}
}

func TestMicrosoftPendingProfileSelectionCancelErasesCredential(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	account := config.Account{
		ID:           "12345678-1234-4123-8123-123456789012",
		AccessToken:  "pending-access-token",
		RefreshToken: "pending-refresh-token",
		ClientSecret: "pending-client-secret",
		ExpiresAt:    time.Now().Add(time.Hour).Unix(),
	}
	profiles := []KiroProfile{{
		ARN:    "arn:aws:codewhisperer:us-east-1:123456789012:profile/pending",
		Name:   "Pending profile",
		Region: "us-east-1",
	}}
	selectionID, expired, err := h.storeMicrosoftProfileSelection("pending-session", account, profiles)
	discardDetachedMicrosoftProfileSelections(expired)
	if err != nil {
		t.Fatalf("store pending profile selection: %v", err)
	}
	selection := h.getMicrosoftProfileSelection(selectionID)
	if selection == nil {
		t.Fatal("pending profile selection was not stored")
	}

	cancelRecorder := httptest.NewRecorder()
	h.apiCancelMicrosoftSSO(
		cancelRecorder,
		httptest.NewRequest(
			http.MethodPost,
			"/auth/microsoft-sso/cancel",
			strings.NewReader(fmt.Sprintf(`{"selectionId":%q}`, selectionID)),
		),
	)
	if cancelRecorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if h.getMicrosoftProfileSelection(selectionID) != nil {
		t.Fatal("canceled profile selection remained addressable")
	}
	if !selection.canceled.Load() {
		t.Fatal("canceled profile selection was not marked canceled")
	}
	if !h.microsoftSessionCanceled("pending-session") {
		t.Fatal("selection-only cancellation did not mark the parent login session canceled")
	}

	selection.mu.Lock()
	if selection.Account.AccessToken != "" ||
		selection.Account.RefreshToken != "" ||
		selection.Account.ClientSecret != "" {
		t.Errorf("canceled selection retained credential material: %+v", selection.Account)
	}
	if len(selection.Profiles) != 0 {
		t.Errorf("canceled selection retained offered profiles: %+v", selection.Profiles)
	}
	selection.mu.Unlock()

	selectRecorder := callMicrosoftProfileSelectionHandler(t, h, selectionID, profiles[0].ARN)
	if selectRecorder.Code != http.StatusBadRequest {
		t.Fatalf("select-after-cancel status = %d, want 400; body=%s",
			selectRecorder.Code, selectRecorder.Body.String())
	}
	if accounts := config.GetAccounts(); len(accounts) != 0 {
		t.Fatalf("select-after-cancel persisted accounts: %+v", accounts)
	}
}

func TestMicrosoftPendingProfileSelectionCapacityLimit(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	account := config.Account{
		AccessToken:  "pending-access-token",
		RefreshToken: "pending-refresh-token",
		ExpiresAt:    time.Now().Add(time.Hour).Unix(),
	}
	profiles := []KiroProfile{{
		ARN:    "arn:aws:codewhisperer:us-east-1:123456789012:profile/pending",
		Name:   "Pending profile",
		Region: "us-east-1",
	}}

	selectionIDs := make([]string, 0, microsoftMaxPendingProfileSelections+1)
	t.Cleanup(func() {
		for _, selectionID := range selectionIDs {
			h.removeMicrosoftProfileSelection(selectionID, nil)
		}
	})
	for i := 0; i < microsoftMaxPendingProfileSelections; i++ {
		selectionID, expired, err := h.storeMicrosoftProfileSelection(
			fmt.Sprintf("pending-session-%d", i),
			account,
			profiles,
		)
		discardDetachedMicrosoftProfileSelections(expired)
		if err != nil {
			t.Fatalf("store selection %d/%d: %v", i+1, microsoftMaxPendingProfileSelections, err)
		}
		selectionIDs = append(selectionIDs, selectionID)
	}

	if _, expired, err := h.storeMicrosoftProfileSelection("over-capacity", account, profiles); err == nil {
		t.Fatalf("selection %d unexpectedly bypassed capacity limit", microsoftMaxPendingProfileSelections+1)
	} else {
		discardDetachedMicrosoftProfileSelections(expired)
	}
	h.microsoftSelectionsMu.Lock()
	pendingCount := len(h.microsoftSelections)
	h.microsoftSelectionsMu.Unlock()
	if pendingCount != microsoftMaxPendingProfileSelections {
		t.Fatalf("pending selections = %d, want capped at %d",
			pendingCount, microsoftMaxPendingProfileSelections)
	}

	h.removeMicrosoftProfileSelection(selectionIDs[0], nil)
	replacementID, expired, err := h.storeMicrosoftProfileSelection("replacement-session", account, profiles)
	discardDetachedMicrosoftProfileSelections(expired)
	if err != nil {
		t.Fatalf("store replacement after cancellation: %v", err)
	}
	selectionIDs = append(selectionIDs, replacementID)
}

func TestStoreMicrosoftProfileSelectionDoesNotWaitOnExpiredSelectionLock(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	account := config.Account{
		AccessToken:  "pending-access-token",
		RefreshToken: "pending-refresh-token",
		ExpiresAt:    time.Now().Add(time.Hour).Unix(),
	}
	profiles := []KiroProfile{{
		ARN:    "arn:aws:codewhisperer:us-east-1:123456789012:profile/pending",
		Name:   "Pending profile",
		Region: "us-east-1",
	}}

	oldID, expired, err := h.storeMicrosoftProfileSelection("old-session", account, profiles)
	discardDetachedMicrosoftProfileSelections(expired)
	if err != nil {
		t.Fatalf("store old selection: %v", err)
	}
	old := h.getMicrosoftProfileSelection(oldID)
	if old == nil {
		t.Fatal("old selection was not stored")
	}
	old.ExpiresAt = time.Now().Add(-time.Second)
	old.mu.Lock()

	type storeResult struct {
		id      string
		expired []*microsoftProfileSelection
		err     error
	}
	resultChannel := make(chan storeResult, 1)
	go func() {
		id, expired, err := h.storeMicrosoftProfileSelection("new-session", account, profiles)
		resultChannel <- storeResult{id: id, expired: expired, err: err}
	}()

	var result storeResult
	select {
	case result = <-resultChannel:
	case <-time.After(time.Second):
		old.mu.Unlock()
		t.Fatal("store blocked while trying to scrub an expired selection")
	}
	old.mu.Unlock()
	discardDetachedMicrosoftProfileSelections(result.expired)
	if result.err != nil {
		t.Fatalf("store new selection: %v", result.err)
	}
	h.removeMicrosoftProfileSelection(result.id, nil)
}

func TestMicrosoftSSOCancelDuringProfileDiscoveryDoesNotPersist(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	accessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "canceled@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			switch {
			case request.Method == http.MethodGet &&
				request.URL.String() == issuerURL+"/.well-known/openid-configuration":
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"issuer":                 issuerURL,
					"authorization_endpoint": handlerMicrosoftAuthorizationEndpoint(),
					"token_endpoint":         handlerMicrosoftTokenEndpoint(),
				}), nil
			case request.Method == http.MethodPost &&
				request.URL.String() == handlerMicrosoftTokenEndpoint():
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"access_token":  accessToken,
					"refresh_token": "canceled-login-refresh-token",
					"expires_in":    3600,
					"token_type":    "Bearer",
				}), nil
			default:
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	discoveryStarted := make(chan struct{}, 1)
	restClient := &http.Client{
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			select {
			case discoveryStarted <- struct{}{}:
			default:
			}
			<-request.Context().Done()
			return nil, request.Context().Err()
		}),
	}
	previousRestClient := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(restClient)
	t.Cleanup(func() { kiroRestHttpStore.Store(previousRestClient) })

	startRecorder := httptest.NewRecorder()
	h.apiStartMicrosoftSSO(
		startRecorder,
		httptest.NewRequest(http.MethodPost, "/auth/microsoft-sso/start", strings.NewReader("{}")),
	)
	if startRecorder.Code != http.StatusOK {
		t.Fatalf("start status = %d, body=%s", startRecorder.Code, startRecorder.Body.String())
	}
	var startResponse struct {
		SessionID    string `json:"sessionId"`
		AuthorizeURL string `json:"authorizeUrl"`
	}
	decodeHandlerMicrosoftJSON(t, startRecorder, &startResponse)
	t.Cleanup(func() { auth.CancelMicrosoftSSOLogin(startResponse.SessionID) })

	portalState := mustHandlerMicrosoftURL(t, startResponse.AuthorizeURL).Query().Get("state")
	portalCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/signin/callback",
		RawQuery: url.Values{
			"state":        {portalState},
			"login_option": {auth.MicrosoftSSOAuthMethod},
			"issuer_url":   {issuerURL},
			"client_id":    {handlerMicrosoftClientID},
			"scopes":       {handlerMicrosoftScopes()},
		}.Encode(),
	}
	firstCompleteRecorder := callMicrosoftCompleteHandler(
		t, h, startResponse.SessionID, portalCallback.String(),
	)
	if firstCompleteRecorder.Code != http.StatusOK {
		t.Fatalf("first callback status = %d, body=%s",
			firstCompleteRecorder.Code, firstCompleteRecorder.Body.String())
	}
	var firstCompleteResponse struct {
		AuthorizeURL string `json:"authorizeUrl"`
	}
	decodeHandlerMicrosoftJSON(t, firstCompleteRecorder, &firstCompleteResponse)
	providerState := mustHandlerMicrosoftURL(t, firstCompleteResponse.AuthorizeURL).Query().Get("state")
	providerCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/oauth/callback",
		RawQuery: url.Values{
			"state": {providerState},
			"code":  {"provider-code"},
		}.Encode(),
	}

	completeBody, err := json.Marshal(map[string]string{
		"sessionId":   startResponse.SessionID,
		"callbackUrl": providerCallback.String(),
	})
	if err != nil {
		t.Fatalf("marshal final callback: %v", err)
	}
	finalCompleteRecorder := httptest.NewRecorder()
	completeDone := make(chan struct{})
	go func() {
		h.apiCompleteMicrosoftSSO(
			finalCompleteRecorder,
			httptest.NewRequest(
				http.MethodPost,
				"/auth/microsoft-sso/complete",
				strings.NewReader(string(completeBody)),
			),
		)
		close(completeDone)
	}()

	select {
	case <-discoveryStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("profile discovery did not start")
	}

	cancelBody, err := json.Marshal(map[string]string{"sessionId": startResponse.SessionID})
	if err != nil {
		t.Fatalf("marshal cancel request: %v", err)
	}
	cancelRecorder := httptest.NewRecorder()
	h.apiCancelMicrosoftSSO(
		cancelRecorder,
		httptest.NewRequest(
			http.MethodPost,
			"/auth/microsoft-sso/cancel",
			strings.NewReader(string(cancelBody)),
		),
	)
	if cancelRecorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}

	select {
	case <-completeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("profile discovery did not stop after cancellation")
	}
	if finalCompleteRecorder.Code != http.StatusConflict {
		t.Fatalf("final completion status = %d, want 409 after cancellation; body=%s",
			finalCompleteRecorder.Code, finalCompleteRecorder.Body.String())
	}
	if accounts := config.GetAccounts(); len(accounts) != 0 {
		t.Fatalf("canceled login persisted accounts: %+v", accounts)
	}
	h.microsoftSelectionsMu.Lock()
	pendingSelections := len(h.microsoftSelections)
	h.microsoftSelectionsMu.Unlock()
	if pendingSelections != 0 {
		t.Fatalf("canceled login retained %d pending profile selections", pendingSelections)
	}
}
