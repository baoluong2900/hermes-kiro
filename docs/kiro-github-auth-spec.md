# Kiro GitHub / Social Auth Reverse Engineering Specification

This document details the reverse-engineered GitHub / Social authentication mechanisms used by official Kiro clients (`kiro-cli` and Kiro IDE / VSCode extension) and provides an end-to-end implementation specification for `Kiro-Go`.

---

## 1. Executive Summary

Official Kiro clients support two distinct login flows for GitHub (and Google) social auth:

1. **Device Code Flow (`kiro-cli`)**:
   - Ideal for headless, terminal, or daemon environments where local browser redirect ports cannot be exposed or bound.
   - Communicates with Kiro's auth gateway at `https://prod.us-east-1.auth.desktop.kiro.dev`.
   - Issues a user code and device code. The user confirms in their browser at `https://app.kiro.dev/account/device?user_code=...&login_provider=Github`.
   - The client polls the Kiro auth gateway until authentication completes.

2. **Web Portal PKCE Callback Flow (Kiro IDE)**:
   - Starts a local HTTP loopback server on `127.0.0.1` listening on one of a set of candidate ports (e.g. `3128, 4649, 6588, 8008, 9091, 49153-53153`).
   - Generates PKCE parameters (`code_verifier`, `code_challenge` with SHA-256) and a UUID `state`.
   - Opens `https://app.kiro.dev/signin` with parameters:
     - `state`: random UUID
     - `code_challenge`: Base64URL-encoded SHA-256 hash of `code_verifier`
     - `code_challenge_method`: `S256`
     - `redirect_uri`: `http://localhost:<port>/oauth/callback` (or `/signin/callback`)
     - `redirect_from`: `KiroIDE`
   - When the user signs in with GitHub, the browser redirects back to `http://localhost:<port>/oauth/callback?login_option=github&code=...&state=...`.
   - The client exchanges the authorization code for tokens directly at `https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token`.

3. **Token Refreshing**:
   - Both flows issue an `accessToken`, `refreshToken`, `profileArn`, and `expiresIn`.
   - Refreshed via `POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`.

---

## 2. Reverse-Engineered Architecture & Endpoints

### 2.1 Base URLs

- **Auth Service Gateway**: `https://prod.us-east-1.auth.desktop.kiro.dev`
- **Web Portal / Device App**: `https://app.kiro.dev`

### 2.2 Client Identity & User-Agent Requirements

- `clientId`: `"Kiro-CLI"` (case-sensitive)
- `User-Agent`: `kiro-cli/1.0.0` or standard Kiro client User-Agent

---

## 3. Flow 1: Device Authorization Flow (Headless / CLI)

Used by `kiro-cli` (`crates/fig_auth/src/social.rs`).

### Step 1: Initiate Device Authorization

- **Endpoint**: `POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization`
- **Headers**:
  ```http
  Content-Type: application/json
  User-Agent: kiro-cli/1.0.0
  ```
- **Request Body**:
  ```json
  {
    "clientId": "Kiro-CLI",
    "loginProvider": "Github"
  }
  ```
  *(Note: `loginProvider` accepts `"Github"` or `"Google"`).*

- **Response Body (HTTP 200)**:
  ```json
  {
    "deviceCode": "2W6RDLZ1TMSDFLNLFE",
    "userCode": "KHVX-CCSD",
    "verificationUri": "https://app.kiro.dev/account/device",
    "verificationUriComplete": "https://app.kiro.dev/account/device?user_code=KHVX-CCSD&login_provider=Github",
    "expiresInMilliseconds": 300000,
    "intervalInMilliseconds": 5000
  }
  ```

### Step 2: Display to User

Prompt user to navigate to `verificationUriComplete` (or open automatically via browser) and enter/verify `userCode`.

### Step 3: Poll Device Token

- **Endpoint**: `POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll`
- **Headers**:
  ```http
  Content-Type: application/json
  User-Agent: kiro-cli/1.0.0
  ```
- **Request Body**:
  ```json
  {
    "clientId": "Kiro-CLI",
    "deviceCode": "2W6RDLZ1TMSDFLNLFE"
  }
  ```

- **Poll Responses**:
  - **Pending (HTTP 200)**:
    ```json
    {
      "status": "authorization_pending",
      "accessToken": null,
      "refreshToken": null,
      "profileArn": null,
      "identityProvider": null
    }
    ```
    *Action*: Sleep for `intervalInMilliseconds` (typically 5000 ms) and retry.

  - **Success (HTTP 200)**:
    ```json
    {
      "status": "success",
      "accessToken": "ey...",
      "refreshToken": "ey...",
      "profileArn": "arn:aws:codewhisperer:us-east-1:...",
      "identityProvider": "Github",
      "expiresIn": 3600
    }
    ```

  - **Expired / Denied**:
    - `expired_token` or HTTP 400 with status error. Terminate polling.

---

## 4. Flow 2: Web Portal PKCE Callback Flow (Kiro IDE)

Used by Kiro IDE extension (`PortalAuthProvider` and `AuthServiceClient`).

### Step 1: Local HTTP Listener & PKCE Generation

1. Candidate ports: `[3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153]` (or dynamic port `:0` if custom redirect is allowed).
2. Start HTTP listener on `127.0.0.1:<port>` handling route `/oauth/callback`.
3. Generate PKCE:
   - `code_verifier`: 32 random bytes, Base64URL-encoded without padding (43-128 chars).
   - `code_challenge`: SHA-256 of `code_verifier`, Base64URL-encoded without padding.
   - `state`: UUID v4.

### Step 2: Open Portal URL

Construct URL:
```text
https://app.kiro.dev/signin?state={state}&code_challenge={code_challenge}&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2Foauth%2Fcallback&redirect_from=KiroIDE
```

Open in system browser.

### Step 3: Handle HTTP Callback

Browser redirects to:
```text
GET /oauth/callback?login_option=github&code={auth_code}&state={state}
```
1. Verify `state` matches expected session `state`.
2. Send HTTP 302 redirect to browser:
   - On success: `https://app.kiro.dev/signin?auth_status=success&redirect_from=KiroIDE`
   - On error: `https://app.kiro.dev/signin?auth_status=error&redirect_from=KiroIDE&error_message={msg}`

### Step 4: Exchange Authorization Code for Token

- **Endpoint**: `POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token`
- **Headers**:
  ```http
  Content-Type: application/json
  User-Agent: kiro-cli/1.0.0
  ```
- **Request Body**:
  ```json
  {
    "code": "{auth_code}",
    "code_verifier": "{code_verifier}",
    "redirect_uri": "http://localhost:{port}/oauth/callback?login_option=github"
  }
  ```
  *(Important: `redirect_uri` in the exchange payload must include `?login_option=github` as appended by the callback handler).*

- **Response Body (HTTP 200)**:
  ```json
  {
    "accessToken": "...",
    "refreshToken": "...",
    "profileArn": "arn:aws:codewhisperer:us-east-1:...",
    "expiresIn": 3600
  }
  ```

---

## 5. Token Refresh Mechanism

Both flows use the exact same refresh endpoint already partially present in `Kiro-Go` (`auth/oidc.go`).

- **Endpoint**: `POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`
- **Headers**:
  ```http
  Content-Type: application/json
  User-Agent: kiro-cli/1.0.0
  ```
- **Request Body**:
  ```json
  {
    "refreshToken": "{refresh_token}"
  }
  ```
- **Response Body (HTTP 200)**:
  ```json
  {
    "accessToken": "...",
    "refreshToken": "...",
    "profileArn": "arn:aws:codewhisperer:us-east-1:...",
    "expiresIn": 3600
  }
  ```
  *(Note: If token is invalidated or revoked, returns HTTP 401 `{"message":"Bad credentials"}`).*

---

## 6. Kiro-Go Data Models & Storage

### 6.1 Account Struct (`config/account.go` & `data/config.json`)

To seamlessly store social accounts in `Kiro-Go`:

```go
type Account struct {
    ID           string `json:"id"`
    Name         string `json:"name"`
    AuthMethod   string `json:"auth_method"`   // "social"
    Provider     string `json:"provider"`      // "Github" or "Google"
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    ProfileArn   string `json:"profile_arn"`
    ExpiresAt    int64  `json:"expires_at"`    // Unix timestamp
    Disabled     bool   `json:"disabled"`
    ProxyURL     string `json:"proxy_url,omitempty"`
}
```

### 6.2 Go Structs for Device Flow

```go
package auth

type SocialDeviceAuthRequest struct {
    ClientID      string `json:"clientId"`
    LoginProvider string `json:"loginProvider"` // "Github" or "Google"
}

type SocialDeviceAuthResponse struct {
    DeviceCode              string `json:"deviceCode"`
    UserCode                string `json:"userCode"`
    VerificationURI         string `json:"verificationUri"`
    VerificationURIComplete string `json:"verificationUriComplete"`
    ExpiresInMs             int    `json:"expiresInMilliseconds"`
    IntervalInMs            int    `json:"intervalInMilliseconds"`
}

type SocialDevicePollRequest struct {
    ClientID   string `json:"clientId"`
    DeviceCode string `json:"deviceCode"`
}

type SocialDevicePollResponse struct {
    Status           string `json:"status"` // "authorization_pending", "success", etc.
    AccessToken      string `json:"accessToken,omitempty"`
    RefreshToken     string `json:"refreshToken,omitempty"`
    ProfileArn       string `json:"profileArn,omitempty"`
    IdentityProvider string `json:"identityProvider,omitempty"`
    ExpiresIn        int    `json:"expiresIn,omitempty"`
}

type SocialTokenExchangeRequest struct {
    Code         string `json:"code"`
    CodeVerifier string `json:"code_verifier"`
    RedirectURI  string `json:"redirect_uri"`
}
```

---

## 7. Recommended Implementation Plan for Kiro-Go

1. **`auth/social.go`**:
   - `StartSocialDeviceAuth(provider string, proxyURL string) (*SocialDeviceSession, error)`:
     Calls `/oauth/device/authorization` with `clientId: "Kiro-CLI"` and `loginProvider: "Github"`.
   - `PollSocialDeviceAuth(sessionID string) (*SocialTokenResult, error)`:
     Polls `/oauth/device/poll`. When `status == "success"`, populates account credentials.
   - `StartSocialPortalAuth(provider string, proxyURL string) (*SocialPortalSession, error)`:
     Implements local listener + PKCE portal flow.

2. **Web Admin UI & API Routes (`main.go` / `admin.go`)**:
   - `POST /api/auth/social/start`:
     Accepts `{"provider": "Github", "mode": "device"}` or `{"mode": "portal"}`. Returns verification URI and session ID.
   - `GET /api/auth/social/poll?sessionId=...`:
     Polls the status for the frontend UI.
   - Once completed, automatically creates an Account with `auth_method: "social"`.

3. **Token Refresh Integration (`auth/oidc.go`)**:
   - Existing `refreshSocialToken` already calls `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken` and parses `accessToken`, `refreshToken`, `expiresIn`, `profileArn`.
   - Ensure header `User-Agent: kiro-cli/1.0.0` or standard Kiro agent header is included.
