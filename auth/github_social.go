package auth

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"kiro-go/config"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	// GitHub Social constants
	GitHubSocialAuthMethod  = "social"
	GitHubSocialProvider    = "Github"
	DefaultGitHubRegion     = "us-east-1"
	DefaultGitHubProfileArn = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK"
	GitHubSocialClientID    = "Kiro-CLI"
	GitHubSocialUserAgent   = "kiro-cli/1.0.0"

	// Kiro Auth Gateway & Portal endpoints
	defaultKiroAuthGatewayBase = "https://prod.us-east-1.auth.desktop.kiro.dev"
	defaultKiroPortalSignInURL = "https://app.kiro.dev/signin"
	githubSocialLoopbackBase   = "http://localhost:3128"
	githubSocialOAuthCallback  = "/oauth/callback"
	githubSocialRedirectSource = "KiroIDE"
	githubSocialSessionTTL     = 10 * time.Minute
	githubSocialMaxCallbackLen = 16 << 10
	githubSocialMaxResponse    = 1 << 20
)

// Overridable for testing
var (
	kiroAuthGatewayBase = defaultKiroAuthGatewayBase
	kiroPortalSignInURL = defaultKiroPortalSignInURL
)

// GitHubSocialSession represents a GitHub Social login session (Device Flow or Portal Flow).
type GitHubSocialSession struct {
	ID                      string
	Mode                    string // "device" or "portal"
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	Interval                int // poll interval in seconds
	ExpiresAt               time.Time

	// Portal Flow PKCE & State
	CodeVerifier string
	State        string
	RedirectURI  string

	ProxyURL string
}

// GitHubSocialResult represents the result of a completed GitHub Social login.
type GitHubSocialResult struct {
	AccessToken      string
	RefreshToken     string
	ProfileArn       string
	IdentityProvider string
	ExpiresIn        int
	ExpiresAt        int64
	Region           string
	AuthMethod       string
	Provider         string
	Email            string
	UserID           string
}

// Internal session storage
var (
	gitHubSocialSessions   = make(map[string]*GitHubSocialSession)
	gitHubSocialSessionsMu sync.RWMutex
)

// CreateAccount converts the GitHubSocialResult to a config.Account ready to be saved.
func (r *GitHubSocialResult) CreateAccount() *config.Account {
	region := r.Region
	if region == "" {
		region = DefaultGitHubRegion
	}
	provider := r.Provider
	if provider == "" {
		provider = GitHubSocialProvider
	}
	authMethod := r.AuthMethod
	if authMethod == "" {
		authMethod = GitHubSocialAuthMethod
	}
	profileArn := strings.TrimSpace(r.ProfileArn)
	if profileArn == "" {
		profileArn = DefaultGitHubProfileArn
	}
	expiresAt := r.ExpiresAt
	if expiresAt == 0 && r.ExpiresIn > 0 {
		expiresAt = time.Now().Unix() + int64(r.ExpiresIn)
	}

	return &config.Account{
		ID:           GenerateAccountID(),
		Email:        r.Email,
		UserId:       r.UserID,
		AccessToken:  r.AccessToken,
		RefreshToken: r.RefreshToken,
		ProfileArn:   profileArn,
		AuthMethod:   authMethod,
		Provider:     provider,
		Region:       region,
		ExpiresAt:    expiresAt,
		Enabled:      true,
		MachineId:    config.GenerateMachineId(),
	}
}

// StartGitHubLogin starts a GitHub social login session.
// mode can be "device" (default) or "portal".
// proxyURL can be specified or empty to use the global proxy.
func StartGitHubLogin(mode, proxyURL string) (*GitHubSocialSession, string, error) {
	if mode == "" {
		mode = "device"
	}
	mode = strings.ToLower(strings.TrimSpace(mode))

	switch mode {
	case "device":
		return startGitHubDeviceFlow(proxyURL)
	case "portal":
		return startGitHubPortalFlow(proxyURL)
	default:
		return nil, "", fmt.Errorf("unsupported login mode: %q, must be 'device' or 'portal'", mode)
	}
}

// startGitHubDeviceFlow initiates GitHub Device Flow via Kiro Auth Gateway.
func startGitHubDeviceFlow(proxyURL string) (*GitHubSocialSession, string, error) {
	client := GetAuthClientForProxy(proxyURL)

	reqPayload := map[string]string{
		"clientId":      GitHubSocialClientID,
		"loginProvider": GitHubSocialProvider,
	}
	reqBody, _ := json.Marshal(reqPayload)

	authURL := kiroAuthGatewayBase + "/oauth/device/authorization"
	req, err := http.NewRequest(http.MethodPost, authURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", fmt.Errorf("create device authorization request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", GitHubSocialUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("device authorization failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, "", fmt.Errorf("device authorization failed: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var authResp struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationURI         string `json:"verificationUri"`
		VerificationURIComplete string `json:"verificationUriComplete"`
		ExpiresInMs             int    `json:"expiresInMilliseconds"`
		IntervalInMs            int    `json:"intervalInMilliseconds"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		return nil, "", fmt.Errorf("parse device authorization response: %w", err)
	}

	interval := authResp.IntervalInMs / 1000
	if interval <= 0 {
		interval = 5
	}
	expiresInSec := authResp.ExpiresInMs / 1000
	if expiresInSec <= 0 {
		expiresInSec = 300
	}

	verificationURI := authResp.VerificationURIComplete
	if verificationURI == "" {
		verificationURI = authResp.VerificationURI
	}

	session := &GitHubSocialSession{
		ID:                      uuid.NewString(),
		Mode:                    "device",
		DeviceCode:              authResp.DeviceCode,
		UserCode:                authResp.UserCode,
		VerificationURI:         authResp.VerificationURI,
		VerificationURIComplete: verificationURI,
		Interval:                interval,
		ExpiresAt:               time.Now().Add(time.Duration(expiresInSec) * time.Second),
		ProxyURL:                proxyURL,
	}

	gitHubSocialSessionsMu.Lock()
	gitHubSocialSessions[session.ID] = session
	gitHubSocialSessionsMu.Unlock()

	go cleanupExpiredGitHubSocialSessions()

	return session, verificationURI, nil
}

// startGitHubPortalFlow initiates Portal PKCE callback flow.
func startGitHubPortalFlow(proxyURL string) (*GitHubSocialSession, string, error) {
	verifier, err := generateRandomURLSafe(32)
	if err != nil {
		return nil, "", fmt.Errorf("generate PKCE verifier: %w", err)
	}
	state, err := generateRandomURLSafe(32)
	if err != nil {
		return nil, "", fmt.Errorf("generate OAuth state: %w", err)
	}

	redirectURI := githubSocialLoopbackBase + githubSocialOAuthCallback

	q := url.Values{}
	q.Set("state", state)
	q.Set("code_challenge", generatePKCEChallenge(verifier))
	q.Set("code_challenge_method", "S256")
	q.Set("redirect_uri", redirectURI)
	q.Set("redirect_from", githubSocialRedirectSource)

	authURL := kiroPortalSignInURL + "?" + q.Encode()

	session := &GitHubSocialSession{
		ID:           uuid.NewString(),
		Mode:         "portal",
		CodeVerifier: verifier,
		State:        state,
		RedirectURI:  redirectURI,
		ExpiresAt:    time.Now().Add(githubSocialSessionTTL),
		ProxyURL:     proxyURL,
	}

	gitHubSocialSessionsMu.Lock()
	gitHubSocialSessions[session.ID] = session
	gitHubSocialSessionsMu.Unlock()

	go cleanupExpiredGitHubSocialSessions()

	return session, authURL, nil
}

// PollGitHubLogin polls for Device Flow token status.
// Returns:
//   - result: populated when status == "completed" or "success"
//   - status: "pending", "slow_down", "completed"
//   - err: error if failed or expired
func PollGitHubLogin(sessionID string) (*GitHubSocialResult, string, error) {
	gitHubSocialSessionsMu.RLock()
	session, exists := gitHubSocialSessions[sessionID]
	gitHubSocialSessionsMu.RUnlock()

	if !exists {
		return nil, "", fmt.Errorf("session not found or expired")
	}

	if time.Now().After(session.ExpiresAt) {
		gitHubSocialSessionsMu.Lock()
		delete(gitHubSocialSessions, sessionID)
		gitHubSocialSessionsMu.Unlock()
		return nil, "", fmt.Errorf("session expired")
	}

	if session.Mode != "device" {
		return nil, "", fmt.Errorf("session %s is in portal mode, use CompleteGitHubLogin instead", sessionID)
	}

	client := GetAuthClientForProxy(session.ProxyURL)

	pollPayload := map[string]string{
		"clientId":   GitHubSocialClientID,
		"deviceCode": session.DeviceCode,
	}
	reqBody, _ := json.Marshal(pollPayload)

	pollURL := kiroAuthGatewayBase + "/oauth/device/poll"
	req, err := http.NewRequest(http.MethodPost, pollURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", fmt.Errorf("create device poll request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", GitHubSocialUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("device poll request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, githubSocialMaxResponse))
	if err != nil {
		return nil, "", fmt.Errorf("read device poll response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errResp struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
			Message          string `json:"message"`
		}
		_ = json.Unmarshal(body, &errResp)

		errCode := strings.ToLower(strings.TrimSpace(errResp.Error))
		if errCode == "" {
			errCode = strings.ToLower(strings.TrimSpace(errResp.Message))
		}

		switch errCode {
		case "authorization_pending", "pending":
			return nil, "pending", nil
		case "slow_down":
			gitHubSocialSessionsMu.Lock()
			session.Interval += 5
			gitHubSocialSessionsMu.Unlock()
			return nil, "slow_down", nil
		case "expired_token", "invalid_token":
			gitHubSocialSessionsMu.Lock()
			delete(gitHubSocialSessions, sessionID)
			gitHubSocialSessionsMu.Unlock()
			return nil, "", fmt.Errorf("device code expired or already used (%s)", errCode)
		case "access_denied":
			gitHubSocialSessionsMu.Lock()
			delete(gitHubSocialSessions, sessionID)
			gitHubSocialSessionsMu.Unlock()
			return nil, "", fmt.Errorf("user denied authorization")
		default:
			return nil, "", fmt.Errorf("device authorization error (HTTP %d): %s", resp.StatusCode, string(body))
		}
	}

	var pollResp struct {
		Status            string `json:"status"`
		AccessToken       string `json:"accessToken"`
		AccessTokenSnake  string `json:"access_token"`
		RefreshToken      string `json:"refreshToken"`
		RefreshTokenSnake string `json:"refresh_token"`
		ProfileArn        string `json:"profileArn"`
		ProfileArnSnake   string `json:"profile_arn"`
		IdentityProvider  string `json:"identityProvider"`
		ExpiresIn         int    `json:"expiresIn"`
		ExpiresInSnake    int    `json:"expires_in"`
		Error             string `json:"error"`
		ErrorDescription  string `json:"error_description"`
		Message           string `json:"message"`
	}

	if err := json.Unmarshal(body, &pollResp); err != nil {
		return nil, "", fmt.Errorf("parse device poll response: %w", err)
	}

	accessToken := strings.TrimSpace(pollResp.AccessToken)
	if accessToken == "" {
		accessToken = strings.TrimSpace(pollResp.AccessTokenSnake)
	}
	refreshToken := strings.TrimSpace(pollResp.RefreshToken)
	if refreshToken == "" {
		refreshToken = strings.TrimSpace(pollResp.RefreshTokenSnake)
	}
	profileArn := strings.TrimSpace(pollResp.ProfileArn)
	if profileArn == "" {
		profileArn = strings.TrimSpace(pollResp.ProfileArnSnake)
	}
	expiresIn := pollResp.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = pollResp.ExpiresInSnake
	}
	if expiresIn <= 0 {
		expiresIn = 3600
	}

	status := strings.ToLower(strings.TrimSpace(pollResp.Status))
	if status == "" {
		if pollResp.Error != "" {
			status = strings.ToLower(strings.TrimSpace(pollResp.Error))
		} else if accessToken != "" {
			status = "authorized"
		}
	}

	switch status {
	case "authorization_pending", "pending":
		return nil, "pending", nil
	case "slow_down":
		gitHubSocialSessionsMu.Lock()
		session.Interval += 5
		gitHubSocialSessionsMu.Unlock()
		return nil, "slow_down", nil
	case "authorized", "success", "completed", "approved":
		if accessToken == "" {
			return nil, "", fmt.Errorf("token response missing accessToken")
		}

		// Clean up session
		gitHubSocialSessionsMu.Lock()
		delete(gitHubSocialSessions, sessionID)
		gitHubSocialSessionsMu.Unlock()

		provider := pollResp.IdentityProvider
		if provider == "" {
			provider = GitHubSocialProvider
		}

		claims := parseSocialTokenClaims(accessToken)
		if profileArn == "" {
			profileArn = claims.ProfileArn
		}
		if profileArn == "" {
			profileArn = DefaultGitHubProfileArn
		}

		email, userID, _ := GetUserInfo(accessToken)
		if email == "" {
			email = claims.Email
		}
		if userID == "" {
			userID = claims.UserID
		}
		if email == "" {
			if userID != "" {
				email = "github_" + userID + "@kiro.dev"
			} else if session.UserCode != "" {
				email = "github_user_" + session.UserCode + "@kiro.dev"
			} else {
				email = "github_account@kiro.dev"
			}
		}

		result := &GitHubSocialResult{
			AccessToken:      accessToken,
			RefreshToken:     refreshToken,
			ProfileArn:       profileArn,
			IdentityProvider: provider,
			ExpiresIn:        expiresIn,
			ExpiresAt:        time.Now().Unix() + int64(expiresIn),
			Region:           DefaultGitHubRegion,
			AuthMethod:       GitHubSocialAuthMethod,
			Provider:         provider,
			Email:            email,
			UserID:           userID,
		}
		return result, "completed", nil
	case "invalid_token", "expired_token":
		gitHubSocialSessionsMu.Lock()
		delete(gitHubSocialSessions, sessionID)
		gitHubSocialSessionsMu.Unlock()
		return nil, "", fmt.Errorf("device code expired or already used (%s)", status)
	case "access_denied":
		gitHubSocialSessionsMu.Lock()
		delete(gitHubSocialSessions, sessionID)
		gitHubSocialSessionsMu.Unlock()
		return nil, "", fmt.Errorf("user denied authorization")
	default:
		if accessToken != "" {
			gitHubSocialSessionsMu.Lock()
			delete(gitHubSocialSessions, sessionID)
			gitHubSocialSessionsMu.Unlock()

			provider := pollResp.IdentityProvider
			if provider == "" {
				provider = GitHubSocialProvider
			}
			claims := parseSocialTokenClaims(accessToken)
			if profileArn == "" {
				profileArn = claims.ProfileArn
			}
			if profileArn == "" {
				profileArn = DefaultGitHubProfileArn
			}
			email, userID, _ := GetUserInfo(accessToken)
			if email == "" {
				email = claims.Email
			}
			if userID == "" {
				userID = claims.UserID
			}
			if email == "" {
				email = "github_account@kiro.dev"
			}
			result := &GitHubSocialResult{
				AccessToken:      accessToken,
				RefreshToken:     refreshToken,
				ProfileArn:       profileArn,
				IdentityProvider: provider,
				ExpiresIn:        expiresIn,
				ExpiresAt:        time.Now().Unix() + int64(expiresIn),
				Region:           DefaultGitHubRegion,
				AuthMethod:       GitHubSocialAuthMethod,
				Provider:         provider,
				Email:            email,
				UserID:           userID,
			}
			return result, "completed", nil
		}
		return nil, "", fmt.Errorf("unexpected status from auth gateway: %s", pollResp.Status)
	}
}

// CompleteGitHubLogin completes the login by processing the callback URL from Kiro Portal OAuth.
func CompleteGitHubLogin(sessionID, callbackURL string) (*GitHubSocialResult, error) {
	gitHubSocialSessionsMu.RLock()
	session, exists := gitHubSocialSessions[sessionID]
	gitHubSocialSessionsMu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("session not found or expired")
	}

	if time.Now().After(session.ExpiresAt) {
		gitHubSocialSessionsMu.Lock()
		delete(gitHubSocialSessions, sessionID)
		gitHubSocialSessionsMu.Unlock()
		return nil, fmt.Errorf("session expired")
	}

	callbackURL = strings.TrimSpace(callbackURL)
	if callbackURL == "" {
		return nil, fmt.Errorf("callback URL is required")
	}
	if len(callbackURL) > githubSocialMaxCallbackLen {
		return nil, fmt.Errorf("callback URL is too long")
	}

	u, err := url.Parse(callbackURL)
	if err != nil {
		return nil, fmt.Errorf("invalid callback URL: %w", err)
	}

	q := u.Query()
	if errParam := q.Get("error"); errParam != "" {
		desc := q.Get("error_description")
		if desc != "" {
			return nil, fmt.Errorf("authorization failed: %s: %s", errParam, desc)
		}
		return nil, fmt.Errorf("authorization failed: %s", errParam)
	}

	state := q.Get("state")
	if session.State != "" && state != "" && state != session.State {
		return nil, fmt.Errorf("state mismatch: possible CSRF or invalid session")
	}

	code := q.Get("code")
	if code == "" {
		return nil, fmt.Errorf("callback URL missing code parameter")
	}

	client := GetAuthClientForProxy(session.ProxyURL)

	// In Kiro IDE's flow, redirect_uri for token exchange includes ?login_option=github (or matched query)
	exchangeRedirectURI := session.RedirectURI
	if exchangeRedirectURI == "" {
		exchangeRedirectURI = githubSocialLoopbackBase + githubSocialOAuthCallback
	}
	if !strings.Contains(exchangeRedirectURI, "login_option=") {
		exchangeRedirectURI += "?login_option=github"
	}

	tokenPayload := map[string]string{
		"code":          code,
		"code_verifier": session.CodeVerifier,
		"redirect_uri":  exchangeRedirectURI,
	}
	reqBody, _ := json.Marshal(tokenPayload)

	tokenURL := kiroAuthGatewayBase + "/oauth/token"
	req, err := http.NewRequest(http.MethodPost, tokenURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create token exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", GitHubSocialUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, githubSocialMaxResponse))
	if err != nil {
		return nil, fmt.Errorf("read token exchange response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token exchange failed (HTTP %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken       string `json:"accessToken"`
		AccessTokenSnake  string `json:"access_token"`
		RefreshToken      string `json:"refreshToken"`
		RefreshTokenSnake string `json:"refresh_token"`
		ProfileArn        string `json:"profileArn"`
		ProfileArnSnake   string `json:"profile_arn"`
		IdentityProvider  string `json:"identityProvider"`
		ExpiresIn         int    `json:"expiresIn"`
		ExpiresInSnake    int    `json:"expires_in"`
	}

	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("parse token exchange response: %w", err)
	}

	accessToken := strings.TrimSpace(tokenResp.AccessToken)
	if accessToken == "" {
		accessToken = strings.TrimSpace(tokenResp.AccessTokenSnake)
	}
	if accessToken == "" {
		return nil, fmt.Errorf("token exchange response missing accessToken")
	}

	refreshToken := strings.TrimSpace(tokenResp.RefreshToken)
	if refreshToken == "" {
		refreshToken = strings.TrimSpace(tokenResp.RefreshTokenSnake)
	}
	profileArn := strings.TrimSpace(tokenResp.ProfileArn)
	if profileArn == "" {
		profileArn = strings.TrimSpace(tokenResp.ProfileArnSnake)
	}

	// Clean up session
	gitHubSocialSessionsMu.Lock()
	delete(gitHubSocialSessions, sessionID)
	gitHubSocialSessionsMu.Unlock()

	expiresIn := tokenResp.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = tokenResp.ExpiresInSnake
	}
	if expiresIn <= 0 {
		expiresIn = 3600
	}

	provider := tokenResp.IdentityProvider
	if provider == "" {
		provider = GitHubSocialProvider
	}

	claims := parseSocialTokenClaims(accessToken)
	if profileArn == "" {
		profileArn = claims.ProfileArn
	}
	if profileArn == "" {
		profileArn = DefaultGitHubProfileArn
	}

	email, userID, _ := GetUserInfo(accessToken)
	if email == "" {
		email = claims.Email
	}
	if userID == "" {
		userID = claims.UserID
	}
	if email == "" {
		if userID != "" {
			email = "github_" + userID + "@kiro.dev"
		} else {
			email = "github_portal@kiro.dev"
		}
	}

	result := &GitHubSocialResult{
		AccessToken:      accessToken,
		RefreshToken:     refreshToken,
		ProfileArn:       profileArn,
		IdentityProvider: provider,
		ExpiresIn:        expiresIn,
		ExpiresAt:        time.Now().Unix() + int64(expiresIn),
		Region:           DefaultGitHubRegion,
		AuthMethod:       GitHubSocialAuthMethod,
		Provider:         provider,
		Email:            email,
		UserID:           userID,
	}

	return result, nil
}

type socialTokenClaims struct {
	Email      string
	UserID     string
	ProfileArn string
}

func parseSocialTokenClaims(accessToken string) socialTokenClaims {
	if len(accessToken) == 0 || len(accessToken) > 256<<10 {
		return socialTokenClaims{}
	}
	parts := strings.Split(accessToken, ".")
	if len(parts) < 2 {
		return socialTokenClaims{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return socialTokenClaims{}
		}
	}
	var claims struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		Username          string `json:"username"`
		CognitoUsername   string `json:"cognito:username"`
		Sub               string `json:"sub"`
		UserID            string `json:"userId"`
		ProfileArn        string `json:"profileArn"`
		ProfileArnSnake   string `json:"profile_arn"`
		CustomProfileArn  string `json:"custom:profile_arn"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return socialTokenClaims{}
	}
	email := ""
	for _, candidate := range []string{claims.Email, claims.PreferredUsername, claims.Username, claims.CognitoUsername} {
		if c := strings.TrimSpace(candidate); c != "" {
			email = c
			break
		}
	}
	userID := ""
	for _, candidate := range []string{claims.Sub, claims.UserID, claims.Username, claims.CognitoUsername} {
		if c := strings.TrimSpace(candidate); c != "" {
			userID = c
			break
		}
	}
	profileArn := ""
	for _, candidate := range []string{claims.ProfileArn, claims.ProfileArnSnake, claims.CustomProfileArn} {
		if c := strings.TrimSpace(candidate); c != "" {
			profileArn = c
			break
		}
	}
	return socialTokenClaims{
		Email:      email,
		UserID:     userID,
		ProfileArn: profileArn,
	}
}

// CancelGitHubLogin removes an active login session.
func CancelGitHubLogin(sessionID string) {
	gitHubSocialSessionsMu.Lock()
	delete(gitHubSocialSessions, sessionID)
	gitHubSocialSessionsMu.Unlock()
}

// GetGitHubSocialSession retrieves the session info by ID.
func GetGitHubSocialSession(sessionID string) *GitHubSocialSession {
	gitHubSocialSessionsMu.RLock()
	defer gitHubSocialSessionsMu.RUnlock()
	return gitHubSocialSessions[sessionID]
}

func cleanupExpiredGitHubSocialSessions() {
	gitHubSocialSessionsMu.Lock()
	defer gitHubSocialSessionsMu.Unlock()

	now := time.Now()
	for id, session := range gitHubSocialSessions {
		if now.After(session.ExpiresAt) {
			delete(gitHubSocialSessions, id)
		}
	}
}

func generateRandomURLSafe(size int) (string, error) {
	b := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func generatePKCEChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
