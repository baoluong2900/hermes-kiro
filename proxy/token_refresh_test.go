package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"kiro-go/auth"
	"kiro-go/config"
	accountpool "kiro-go/pool"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	rotatingMicrosoftTenantID = "a1111111-b222-4ccc-8ddd-e55555555555"
	rotatingMicrosoftClientID = "f1111111-a222-4bbb-8ccc-d55555555555"
)

type tokenRefreshRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn tokenRefreshRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestRefreshAccountTokenSerializesExternalIDPRotation(t *testing.T) {
	h, initial, _ := newRotatingExternalIDPHandler(t)

	firstRequestEntered := make(chan struct{})
	releaseFirstRequest := make(chan struct{})
	var (
		requestsMu    sync.Mutex
		refreshTokens []string
	)
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: tokenRefreshRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if err := request.ParseForm(); err != nil {
				return nil, fmt.Errorf("parse refresh form: %w", err)
			}
			refreshToken := request.Form.Get("refresh_token")
			requestsMu.Lock()
			requestNumber := len(refreshTokens)
			refreshTokens = append(refreshTokens, refreshToken)
			requestsMu.Unlock()

			if requestNumber == 0 {
				close(firstRequestEntered)
				<-releaseFirstRequest
			}

			switch refreshToken {
			case "refresh-1":
				return tokenRefreshJSONResponse(request, "access-1", "refresh-2"), nil
			case "refresh-2":
				return tokenRefreshJSONResponse(request, "access-2", "refresh-3"), nil
			default:
				return nil, fmt.Errorf("unexpected refresh token %q", refreshToken)
			}
		}),
	}
	previousClient := auth.SetGlobalAuthClientForTest(client)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousClient) })

	firstAccount := initial
	secondAccount := initial
	errs := make(chan error, 2)
	go func() {
		_, err := h.refreshAccountToken(&firstAccount, true)
		errs <- err
	}()
	<-firstRequestEntered

	secondStarted := make(chan struct{})
	go func() {
		close(secondStarted)
		_, err := h.refreshAccountToken(&secondAccount, true)
		errs <- err
	}()
	<-secondStarted
	close(releaseFirstRequest)

	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("refresh %d failed: %v", i+1, err)
		}
	}

	requestsMu.Lock()
	gotRefreshTokens := append([]string(nil), refreshTokens...)
	requestsMu.Unlock()
	if strings.Join(gotRefreshTokens, ",") != "refresh-1,refresh-2" {
		t.Fatalf("refresh token sequence = %v, want [refresh-1 refresh-2]", gotRefreshTokens)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("persisted accounts = %d, want 1", len(accounts))
	}
	if accounts[0].AccessToken != "access-2" || accounts[0].RefreshToken != "refresh-3" {
		t.Fatalf("persisted tokens = (%q, %q), want (access-2, refresh-3)",
			accounts[0].AccessToken, accounts[0].RefreshToken)
	}
	runtimeAccount := h.pool.GetByID(initial.ID)
	if runtimeAccount == nil {
		t.Fatal("refreshed account is missing from runtime pool")
	}
	if runtimeAccount.AccessToken != "access-2" || runtimeAccount.RefreshToken != "refresh-3" {
		t.Fatalf("runtime tokens = (%q, %q), want (access-2, refresh-3)",
			runtimeAccount.AccessToken, runtimeAccount.RefreshToken)
	}
}

func TestRefreshAccountTokenDoesNotPublishWhenPersistenceFails(t *testing.T) {
	h, initial, configPath := newRotatingExternalIDPHandler(t)

	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: tokenRefreshRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return tokenRefreshJSONResponse(request, "access-1", "refresh-2"), nil
		}),
	}
	previousClient := auth.SetGlobalAuthClientForTest(client)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousClient) })

	if err := os.Remove(configPath); err != nil {
		t.Fatalf("remove config file: %v", err)
	}
	if err := os.Mkdir(configPath, 0o700); err != nil {
		t.Fatalf("replace config file with directory: %v", err)
	}

	callerAccount := initial
	refreshed, err := h.refreshAccountToken(&callerAccount, true)
	if err == nil || !strings.Contains(err.Error(), "persist refreshed token") {
		t.Fatalf("refresh error = %v, want persistence error", err)
	}
	if refreshed {
		t.Fatal("refresh reported success despite persistence failure")
	}

	runtimeAccount := h.pool.GetByID(initial.ID)
	if runtimeAccount == nil {
		t.Fatal("account is missing from runtime pool")
	}
	if runtimeAccount.AccessToken != initial.AccessToken || runtimeAccount.RefreshToken != initial.RefreshToken {
		t.Fatalf("runtime pool published unpersisted tokens: (%q, %q)",
			runtimeAccount.AccessToken, runtimeAccount.RefreshToken)
	}
	if callerAccount.AccessToken != initial.AccessToken || callerAccount.RefreshToken != initial.RefreshToken {
		t.Fatalf("caller observed unpersisted tokens: (%q, %q)",
			callerAccount.AccessToken, callerAccount.RefreshToken)
	}
	persisted := config.GetAccounts()
	if len(persisted) != 1 ||
		persisted[0].AccessToken != initial.AccessToken ||
		persisted[0].RefreshToken != initial.RefreshToken {
		t.Fatalf("in-memory config retained unpersisted tokens: %+v", persisted)
	}
}

func newRotatingExternalIDPHandler(t *testing.T) (*Handler, config.Account, string) {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Init(configPath); err != nil {
		t.Fatalf("config.Init: %v", err)
	}

	issuerURL := "https://login.microsoftonline.com/" + rotatingMicrosoftTenantID + "/v2.0"
	account := config.Account{
		ID:            "rotation-test-account",
		Email:         "rotation@example.com",
		Enabled:       true,
		AccessToken:   "access-0",
		RefreshToken:  "refresh-1",
		ClientID:      rotatingMicrosoftClientID,
		AuthMethod:    auth.MicrosoftSSOAuthMethod,
		Provider:      auth.MicrosoftSSOProvider,
		Region:        "us-east-1",
		ExpiresAt:     time.Now().Add(-time.Minute).Unix(),
		TokenEndpoint: "https://login.microsoftonline.com/" + rotatingMicrosoftTenantID + "/oauth2/v2.0/token",
		IssuerURL:     issuerURL,
		Scopes: strings.Join([]string{
			"api://" + rotatingMicrosoftClientID + "/codewhisperer:conversations",
			"api://" + rotatingMicrosoftClientID + "/codewhisperer:completions",
			"offline_access",
		}, " "),
	}
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("config.AddAccount: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p}, account, configPath
}

func tokenRefreshJSONResponse(request *http.Request, accessToken, refreshToken string) *http.Response {
	body, _ := json.Marshal(map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"expires_in":    3600,
		"token_type":    "Bearer",
	})
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Request:    request,
	}
}
