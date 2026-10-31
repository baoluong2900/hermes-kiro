# Kiro-Go Render ingress WAF and tunnel cutover

## Scope and status

Production `kiro-go.hermesgate.app` and alias `kiro.hermesgate.app` now use an embedded Cloudflare Tunnel to the existing Render Go server. The application, persistent `/app/data` disk, authentication and quota accounting remain on Render. No Worker handles these hostnames. Neither `hermesgate.app` nor `api.hermesgate.app` was changed.

Verified 2026-10-31, 19:05–19:11 UTC+07. This resolves the reproduced ingress `403 Blocked`; it does not promise that Kiro upstream inference never fails.

## Two independent failures

### Render public-ingress WAF false positive

The original DNS-only CNAMEs pointed at `kiro-go-n4p9.onrender.com`. Cloudflare DNS-only does not remove Render's own Cloudflare protection.

A minimal unauthenticated POST to `/v1/chat/completions` with harmless text returned application HTTP 401 JSON. The same request containing a SQL example (`OR 1=1`, `DROP TABLE`, `UNION SELECT`) returned HTTP 403 HTML with `<title>Blocked</title>`, before application authentication. The direct Render hostname behaved identically. This isolates content-sensitive public-ingress rejection, not a DNS failure or invalid API key. The exact managed rule ID was not available.

Authenticated before-cutover example:

- `2026-10-31T11:52:37Z`, Sonnet text: HTTP 200 `READY`.
- Same host/key/model, code-analysis prompt: HTTP 403 `Blocked`, Ray `a53274603ebf0fc2-HKG`.

### Excessive model cooldown after an empty upstream response

Render logs showed `claude-opus-5.5` at 11:00:40 UTC and `claude-opus-5` at 11:07:36 UTC being cooled for one hour after `EmptyUpstreamResponse`. With one eligible enabled account this makes subsequent calls return application HTTP 503 `No available accounts`, even while other models work.

`proxy/account_failover.go` now uses a separate 30-second model cooldown for empty streams. Real quota/throttling still uses the existing one-hour default and Retry-After handling. No automatic model substitution was added.

A post-deploy upstream empty response at 12:09:09/12:09:11 UTC logged `30s`, not `1h0m0s`; `claude-opus-5.5-thinking` returned HTTP 200 `READY` at 12:09:59 UTC. The upstream empty-response condition itself still exists and is not a WAF failure.

## Deployed routing

```text
Client
  -> Cloudflare zone hermesgate.app
  -> named tunnel kiro-go-render
  -> cloudflared inside the Render container (outbound HTTP/2 TCP/7844)
  -> http://127.0.0.1:8080
  -> existing Go gateway and account pool
```

- Render service: `srv-dbg8pimc6qcc73en05fg`, workspace `tea-dbflol3rjlhs73ekdhog`.
- Live image: `ghcr.io/baoluong1120/kiro-go-render:tunnel-202610311856`.
- Live deploy: `dep-dbith5942hec73bfagq0`.
- Image manifest: `sha256:cd12379f38737d8ad4afd48cce6df0db5cbf85089e7fca4dad2584140f357f56`.
- Tunnel: `1f64d963-f52a-4973-957a-6dbb65cff013`, `config_src=cloudflare`.
- Cloudflared: official image `2026.10.7`, pinned multi-architecture digest `sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba`.
- DNS: both Kiro hostnames are proxied CNAMEs to `1f64d963-f52a-4973-957a-6dbb65cff013.cfargotunnel.com`.
- Ingress: exactly those two hostnames -> `http://127.0.0.1:8080`, then `http_status:404` catch-all; private routing disabled.
- Connector read-back: healthy, four Singapore connections, `linux_amd64`, version `2026.10.7`, running on Render (not the user's Mac).

### Important Render-specific deployment details

1. Render had an existing Docker Command override, `sh /etc/secrets/kiro-start.sh`. An image-only deployment did not start cloudflared. The final command explicitly wraps the original script:
   `/usr/local/bin/docker-entrypoint.sh sh /etc/secrets/kiro-start.sh`.
   Do not replace the original initialization script with an unrelated command.
2. Both Kiro hostnames remained registered as Render Custom Domains. After the DNS change, requests still traversed the old Render/SaaS ingress. Removing only these two Render custom-domain registrations made the actual public hostnames reach the tunnel, matching the successful canary. The service/disk were not deleted.
3. The temporary canary hostname and its ingress entry were removed after verification. Worker routes remain empty in live Cloudflare and `cloudflare/wrangler.kiro.jsonc`.
4. `TUNNEL_TOKEN` is set as a Render environment secret. It is not baked into the image, source or command line. Rotate through Cloudflare and update Render securely; redeploy to load a replacement token.

## Source changes

- `Dockerfile`: pinned cloudflared build stage, Bash, binary and startup entrypoint.
- `.dockerignore`: includes only `deploy/docker/entrypoint.sh` despite the existing shell-script exclusion.
- `deploy/docker/entrypoint.sh`: without `TUNNEL_TOKEN`, exec the normal command; with token, supervise normal startup and cloudflared together, propagate exit status and terminate both children on shutdown.
- `proxy/account_failover.go`: bounded transient empty-stream model cooldown.
- `cloudflare/wrangler.kiro.jsonc`: routing comment updated; no Worker deployment.

The production artifact was an isolated overlay of the verified existing image and Go source snapshot, not a rebuild of unrelated uncommitted Worker/UI edits. No new tests were authored, no application account/API-key mutations were made, and no git commit/push was performed.

## Verification

| Actual production request | Result |
| --- | --- |
| Both `/health` and `/admin` | HTTP 200 |
| Admin API without password | HTTP 401 |
| SQL/code prompt, Sonnet 4.5 | HTTP 200 `CODE_RECEIVED`, `chatcmpl-8881df1f-3b27-4dc5-9208-aa58aac41f66` |
| Same SQL prompt without API key | HTTP 401 JSON, no HTML block |
| Same SQL prompt on direct `onrender.com` control | Still HTTP 403 HTML; proves the change is ingress routing, not global WAF removal |
| Sonnet image | HTTP 200 `Bright solid blue.` |
| Sonnet SSE | HTTP 200, `[DONE]`, zero unparseable frames |
| Longer Sonnet SSE | 99 content chunks, first at 3.942s and last at 23.637s, 4,363 characters, `[DONE]`, zero unparseable frames |
| Anthropic `/v1/messages`, SQL prompt | HTTP 200, `msg_4649f4b7-1e63-4bc7-aaf4-79a376eeaea8` |
| Responses `/v1/responses`, SQL prompt | HTTP 200 `completed`, `resp_5b9f03b41482d9d2a4fe3a7f6ae5da68` |
| Alias `kiro.hermesgate.app`, code prompt | HTTP 200 |
| Opus 5 and Opus 5.5 text | HTTP 200 `READY` |
| Opus 5.5 image | HTTP 200 `Bright azure blue` |
| User's actual attached dashboard screenshot, Opus 5.5 | HTTP 200; correctly read HTTP 403 and `kiro-go.hermesgate.app`, request `chatcmpl-dc1c9cdd-cd33-45a1-9ab9-06e8e1090166` |
| Opus 5.5 thinking after transient empty/cooldown | HTTP 200 `READY`; not a guarantee every thinking request succeeds |
| Ten health samples across both hostnames | Ten HTTP 200; no Render public-ingress header |

Local checks: `go vet ./...`, `go test ./...`, Go build, `bash -n deploy/docker/entrypoint.sh`, `git diff --check`; image startup without token and invalid-token fail-closed lifecycle exercised. Valid connector operation verified on Render itself.

Authenticated admin read-back succeeded after cutover. Concurrent admin edits were observed: baseline 10 accounts/1 enabled/4 API keys; later 10 accounts/2 enabled/5 API keys, with changed account IDs. This task did not create/delete/enable accounts or issue/revoke API keys, and did not overwrite live config to force the baseline back.

Machine-readable, credential-free probe output is in the task scratch `kiro-tunnel-probes.jsonl`; the reusable scratch runner is `kiro-tunnel-probe.py`. Scratch is ephemeral and not the runtime dependency.

## Timeout limits and genuine remainder

Cloudflare currently documents a **125-second Proxy Read Timeout** (not the historical 100 seconds), changeable on Enterprise. Tunnel bypasses Render's public ingress but does not eliminate Cloudflare's own edge limits. An SSE stream must emit flushed bytes inside the read-idle window; `Connection: keep-alive` is insufficient.

The existing Go stream handlers do not add recurring independent heartbeat comments, and nonstream upstream calls lack an end-to-end request-context deadline. Long silent reasoning/search or buffered nonstream work can therefore still hit an edge timeout while upstream computation continues. The 23-second incremental stream was exercised; a real >125-second silent request was not. Do not claim that all long streams are unlimited. Keep `main.go` `WriteTimeout: 0`; a proper heartbeat/context-cancellation change requires a separate complete cross-handler implementation, not a partial timer patch.

Only one Render instance/connector is running; four tunnel connections do not provide host-level redundancy. Container deploys/restarts can interrupt active streams. Direct calls to `kiro-go-n4p9.onrender.com` still use Render's own WAF: clients should keep using the two Kiro custom domains.

## Rollback

For an ordinary application rollback while retaining the tunnel, use an image that still contains cloudflared/entrypoint and the same startup wrapper. **Do not blindly deploy the pre-tunnel image while DNS still targets the tunnel**: that removes the connector and causes an outage.

Full return to the pre-tunnel public-ingress arrangement:

1. Keep the connector running initially. Re-add `kiro-go.hermesgate.app` and `kiro.hermesgate.app` to the same Render service with `POST /services/<id>/custom-domains`, verify certificate/domain readiness. This can reclaim traffic through Render again and reintroduce the original WAF error.
2. Restore both DNS CNAME targets to `kiro-go-n4p9.onrender.com`, `proxied=false`, TTL 60; read back both records.
3. Restore Docker Command `sh /etc/secrets/kiro-start.sh`, then deploy previous image `ghcr.io/baoluong1120/kiro-go-render:tokensplit-202610311700` only after the normal Render URL works.
4. Verify admin/auth and a real request. Remove the unused tunnel token/connector only after confirming traffic no longer depends on it.

## References

- https://render.com/docs/ddos-protection
- https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/
- https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/render/
