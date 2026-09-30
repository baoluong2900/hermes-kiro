/**
 * KiroPool Cloudflare Worker Gateway & Web Admin Panel
 * Full edge implementation of kiro-cli-pool-proxy with React Admin UI,
 * KV persistence, multi-account pooling, and Anthropic / OpenAI / native APIs.
 */

const GATEWAY_NAME = "KiroPool";
const VERSION = "1.0.0";
const ACCOUNT_USAGE_SIBLINGS = {
  "testhellobao11@gmail.com": ["acc-1-f399a95d"],
};
const ACCOUNT_USAGE_FLOOR = {
  "testhellobao11@gmail.com": {
    requestCount: 5737,
    totalCredits: 7222.077564,
    totalTokens: 451484886,
  },
};
const DEFAULT_REGION = "us-east-1";
const THINKING_SUFFIX = "-thinking";

const KIRO_USER_AGENT = "aws-sdk-js/1.0.0 ua/2.1 os/macos#15.3.1 lang/js md/nodejs#22.22.0 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-0.11.107";
const KIRO_AMZ_USER_AGENT = "aws-sdk-js/1.0.0 KiroIDE-0.11.107";

// Published catalog. Only Opus 5 / 4.8 / 4.7, Sonnet 5 and the GPT-5.6 tiers are
// offered; Claude 4.6 / 4.5 / 4 / 3.x and the GLM / DeepSeek / Qwen / MiniMax
// entries were retired. Legacy names still resolve through MODEL_ALIASES and
// mapKiroModel so existing clients keep working, they are just not advertised.
const VALID_KIRO_MODELS = new Set([
  "auto",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const DEFAULT_MODEL = "claude-opus-4.8";

const FALLBACK_MODELS = [
  "auto",
  "claude-opus-5.5",
  "claude-opus-5.5-thinking",
  "claude-opus-5",
  "claude-opus-5-thinking",
  "claude-opus-4.8",
  "claude-opus-4.8-thinking",
  "claude-opus-4.7",
  "claude-opus-4.7-thinking",
  "claude-sonnet-5",
  "claude-sonnet-5-thinking",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

// User-selected compatibility override for /v1/models. This advertises the
// nominal 1M Claude context so clients may keep larger histories. It does not
// raise Kiro runtime's own payload threshold; oversized requests can still be
// rejected by upstream and are handled by the existing resilience/fallback path.
const FORCED_CONTEXT_WINDOW = 1_000_000;

function normalizeTokenLimits(modelInfo) {
  const raw = modelInfo && typeof modelInfo === "object" ? modelInfo.tokenLimits : null;
  if (!raw || typeof raw !== "object") return null;

  const positiveInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const maxInputTokens = positiveInt(raw.maxInputTokens);
  const maxOutputTokens = positiveInt(raw.maxOutputTokens);
  if (maxInputTokens === 0 && maxOutputTokens === 0) return null;
  return { maxInputTokens, maxOutputTokens };
}

// Claude/auto use the explicit 1M compatibility override. Non-Claude models
// still publish an upstream-reported limit when one exists, otherwise nothing.
function contextWindowForModel(model, modelInfo = null) {
  const name = String(model || "").toLowerCase();
  if (!name) return null;
  if (name === "auto" || name.includes("claude")) return FORCED_CONTEXT_WINDOW;

  const limits = normalizeTokenLimits(modelInfo);
  if (limits && limits.maxInputTokens > 0) return limits.maxInputTokens;
  return null;
}

// Retired ids and third-party names are folded onto the closest live model.
const MODEL_ALIASES = new Map([
  ["auto", "auto"],
  ["claude-opus-5.5", "claude-opus-5.5"],
  ["claude-opus-5-5", "claude-opus-5.5"],
  ["opus-5.5", "claude-opus-5.5"],
  ["opus 5.5", "claude-opus-5.5"],
  ["opus5.5", "claude-opus-5.5"],
  ["opus-5-5", "claude-opus-5.5"],
  ["claude-opus-5", "claude-opus-5"],
  ["claude-3-5-opus", "claude-opus-5"],
  ["claude-3.5-opus", "claude-opus-5"],
  ["opus-5", "claude-opus-5"],
  ["opus 5", "claude-opus-5"],
  ["opus5", "claude-opus-5"],
  ["claude-opus", "claude-opus-5"],
  ["opus", "claude-opus-5"],
  ["claude-sonnet-4.6", "claude-sonnet-5"],
  ["claude-sonnet-4-6", "claude-sonnet-5"],
  ["claude-sonnet-4.5", "claude-sonnet-5"],
  ["claude-sonnet-4-5", "claude-sonnet-5"],
  ["claude-sonnet-4", "claude-sonnet-5"],
  ["claude-opus-4.6", "claude-opus-4.7"],
  ["claude-opus-4-6", "claude-opus-4.7"],
  ["claude-opus-4.5", "claude-opus-4.7"],
  ["claude-opus-4-5", "claude-opus-4.7"],
  ["claude-haiku-4.5", "claude-sonnet-5"],
  ["claude-haiku-4-5", "claude-sonnet-5"],
  ["claude-3-7-sonnet", "claude-sonnet-5"],
  ["claude-3-7-sonnet-20250219", "claude-sonnet-5"],
  ["claude-3-5-sonnet", "claude-sonnet-5"],
  ["claude-3-5-sonnet-20241022", "claude-sonnet-5"],
  ["claude-3-5-sonnet-20240620", "claude-sonnet-5"],
  ["claude-3-5-haiku", "claude-sonnet-5"],
  ["claude-3-5-haiku-20241022", "claude-sonnet-5"],
  ["claude-3-haiku", "claude-sonnet-5"],
  ["claude-3-opus", "claude-opus-4.7"],
  ["claude-3-opus-20240229", "claude-opus-4.7"],
  ["claude-3-sonnet", "claude-sonnet-5"],
  ["gpt-4o", "claude-sonnet-5"],
  ["gpt-4", "claude-sonnet-5"],
  ["gpt-4-turbo", "claude-sonnet-5"],
  ["gpt-4o-mini", "claude-sonnet-5"],
  ["gpt-3.5-turbo", "claude-sonnet-5"],
]);

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Kiro reports a throttled premium model as 400 ValidationException with
// reason INVALID_MODEL_ID ("Invalid model. Please select a different model to
// continue.") instead of 429 ThrottlingException. The id is provably valid: the
// identical request succeeds on an immediate retry, and under a burst of ten
// concurrent Opus 5 calls roughly a third fail this way while the same burst on
// gpt-5.6-* never does. Spacing the same calls 20s apart never fails either.
//
// Treating it as a permanent 400 is what made Opus unusable — 400 tells clients
// "malformed request, never retry", so one throttle became a hard failure. It is
// safe to read this as throttling because mapKiroModel only ever emits ids from
// VALID_KIRO_MODELS, so a genuinely unknown id cannot reach upstream from here.
const TRANSIENT_MODEL_REJECTION = /INVALID_MODEL_ID|select a different model/i;

// Retry budget for the above.
//
// Sized against a rate limit, not a cooldown. The account is at 6% of its credit
// allowance, so the rejection is not exhaustion; it is a cap on premium-model
// request rate. That makes every retry cost a slot in the same budget it is
// waiting on, so a long ramp of quick attempts spends the recovery it is trying to
// buy. Four total attempts spread over roughly ten seconds beats a busier ramp:
// fewer slots consumed, more wall clock for the window to refill.
const MODEL_REJECTION_BACKOFF_MS = [700, 2000, 4500];

// Full jitter on each step. Every sibling throttled by the same burst is
// retrying on the same schedule, so a fixed ramp marches them into the next
// collision together — which is why a burst of ten still lost one request after
// the ramp alone was added. Spreading the retries lets the queue drain.
function jitteredBackoff(baseMs) {
  return Math.floor(baseMs / 2 + Math.random() * baseMs);
}

// AWS issues IdC / Builder ID access tokens with a one hour lifetime, so a gateway
// that runs longer than an hour crosses an expiry. Renewing slightly early costs
// one refresh and spares every request in the window a wasted upstream round trip.
const TOKEN_REFRESH_SKEW_SECONDS = 300;

// Upstream reports a dead credential as 403 with "The bearer token included in the
// request is invalid" rather than 401, so the status alone cannot identify it.
const REJECTED_TOKEN_UPSTREAM = /bearer token|invalid.{0,10}token|expired.{0,10}token|token.{0,20}(expired|invalid)|unauthorized|accessdenied/i;

function isRejectedTokenResponse(status, text) {
  if (status !== 401 && status !== 403) return false;
  return REJECTED_TOKEN_UPSTREAM.test(String(text || ""));
}

function isApiKeyCredential(acc) {
  if (!acc) return false;
  return String(acc.authMethod || "").toLowerCase() === "api_key" ||
    String(acc.accessToken || "").startsWith("ksk_") ||
    String(acc.kiroApiKey || "").startsWith("ksk_");
}

function extractErrorString(text) {
  if (typeof text === "string") return text;
  if (text instanceof Error) {
    return [text.name, text.message, text.upstreamMessage].filter(Boolean).join(" ");
  }
  if (text && typeof text === "object") {
    try {
      return JSON.stringify(text);
    } catch {
      return String(text);
    }
  }
  return String(text || "");
}

function isTransientModelRejection(status, text) {
  const numStatus = Number(status);
  if (numStatus !== 400 && status !== 400) return false;
  const s = extractErrorString(text);
  return TRANSIENT_MODEL_REJECTION.test(s);
}

const CONTENT_LENGTH_EXCEEDED_PATTERNS = /content_length_exceeds_threshold|input content length exceeds threshold|content length exceeds|content_length_exceeded|input is too long|input too long|payload too large|request entity too large|content too large|exceeds maximum allowed size|exceeds single-turn threshold/i;

const CONTENT_LENGTH_EXCEEDED_MESSAGE =
  "Input content length exceeds Kiro's single-turn threshold (~350k chars). The gateway automatically chunks text, but this request exceeded upstream limits. Please try running /compact or starting a new session.";

function isContentLengthExceeded(status, text) {
  const s = extractErrorString(text);
  if (!s) return false;

  const numStatus = Number(status);
  const isAuthOrThrottle = numStatus === 401 || numStatus === 403 || numStatus === 429;
  if (isAuthOrThrottle) return false;

  // Unambiguous AWS Bedrock / Kiro reason code or exact message (matches regardless of status if not auth/throttle)
  if (/content_length_exceeds_threshold|input content length exceeds threshold/i.test(s)) {
    return true;
  }

  // Generalized content/payload length patterns require 400, 413, or unassigned status
  const isLengthStatus = numStatus === 400 || numStatus === 413 || !status || isNaN(numStatus);
  return isLengthStatus && CONTENT_LENGTH_EXCEEDED_PATTERNS.test(s);
}

// A pool has to keep walking its candidates for anything another credential
// might answer. RETRYABLE_STATUSES covers the honestly-labelled transient
// statuses; an INVALID_MODEL_ID throttle that outlived fetchWithModelRetry's ramp
// is a per-credential rate limit that upstream mislabels as 400, so it belongs
// here too. Without it the dispatch loop treated the mislabel as a permanent
// client error, abandoned every remaining account, and answered 429 while the
// rest of the pool sat idle — the failure the client reports as
// "Retry failed: rate_limit_error".
function shouldTryNextAccount(status, text) {
  return RETRYABLE_STATUSES.has(status) || isTransientModelRejection(status, text);
}

// A throttle that outlived the retry ramp is still a throttle. Passing upstream's
// 400 through tells the client its request was malformed and must never be
// retried, so the client gives up on a model that works seconds later. 429 is the
// status upstream should have sent, and it is the one clients know how to obey.
function normalizeUpstreamFailure(status, text) {
  if (isTransientModelRejection(status, text)) {
    return {
      status: 429,
      message: "Kiro throttled this model (upstream reported INVALID_MODEL_ID). The model id is valid — retry shortly, lower concurrency, or pick a lighter model.",
      // Upstream sends no Retry-After with its 400, and a 429 without one leaves
      // each client to guess. The limit is on concurrent requests and clears as
      // soon as the in-flight ones finish, so a short delay is the right advice.
      headers: { "Retry-After": "3" },
    };
  }
  if (isContentLengthExceeded(status, text)) {
    return {
      status: 400,
      message: CONTENT_LENGTH_EXCEEDED_MESSAGE,
      headers: {},
    };
  }
  const s = (typeof text === "object" && text !== null)
    ? (text.message || JSON.stringify(text))
    : String(text || "");
  return { status: Number(status) || status, message: s.slice(0, 400), headers: {} };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-credential model resilience (Layer 1 gate + Layer 2 fallback).
//
// Production runs exactly one enabled IdC account. Under a burst Kiro mislabels
// a per-credential premium-model throttle as HTTP 400 INVALID_MODEL_ID, and the
// old retry only ever hit the SAME credential, so the client still saw
// rate_limit_error even though the identical call succeeds seconds later. The
// two layers below eliminate the failure instead of relabelling it:
//   Layer 1 — a per-credential, per-model concurrency + start-spacing gate on
//             the existing ApiKeyQuota Durable Object (instance name
//             `model-gate:<account identity>`), holding a permit until the
//             Response body reaches EOF/cancel/error, with stale leases that
//             self-expire so a crashed worker cannot deadlock a slot.
//   Layer 2 — a bounded, de-duped fallback chain plus a per-account+model
//             cooldown recorded in the same DO, triggered ONLY by
//             INVALID_MODEL_ID (never a genuine 4xx).
// ---------------------------------------------------------------------------

// Ordered fallback targets per requested model. The requested model itself is
// always tried first (prepended by resolveFallbackCandidates), so these lists
// only name the alternatives. Every alternative must be a live model id that
// mapKiroModel can emit. Chains are shallow on purpose: one premium demotion to
// Sonnet, then a GPT tier, so a throttled Opus degrades to something that
// answers rather than marching through every model.
const MODEL_FALLBACK_CHAIN = {
  "claude-opus-5.5": ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol"],
  "claude-opus-5": ["claude-sonnet-5", "gpt-5.6-sol"],
  "claude-opus-4.8": ["claude-sonnet-5", "gpt-5.6-sol"],
  "claude-opus-4.7": ["claude-sonnet-5", "gpt-5.6-sol"],
  "claude-sonnet-5": ["gpt-5.6-sol"],
  "auto": ["gpt-5.6-sol", "claude-sonnet-5"],
  "gpt-5.6-sol": ["claude-sonnet-5"],
  "gpt-5.6-terra": ["gpt-5.6-sol", "claude-sonnet-5"],
  "gpt-5.6-luna": ["gpt-5.6-sol", "claude-sonnet-5"],
};

// Requested model first, then its fallbacks, de-duped so no candidate repeats
// and the chain can never cycle back to an already-tried model.
function resolveFallbackCandidates(mappedModel) {
  const requested = String(mappedModel || "auto");
  const chain = [requested, ...(MODEL_FALLBACK_CHAIN[requested] || [])];
  const seen = new Set();
  const out = [];
  for (const m of chain) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// Gate policy. Premium (Opus) is the model Kiro throttles under burst, so it is
// serialized to one in-flight request per credential with a wide start spacing;
// everything else gets a modest two-in-flight with a small spacing that keeps a
// burst from arriving as one simultaneous wave.
const MODEL_GATE = {
  premium: { maxInFlight: 1, spacingMs: 1200 },
  default: { maxInFlight: 2, spacingMs: 300 },
};

function isPremiumModel(model) {
  return /(^|[^a-z])opus/i.test(String(model || ""));
}

function modelGatePolicy(model) {
  return isPremiumModel(model) ? MODEL_GATE.premium : MODEL_GATE.default;
}

// A lease that is never released (crashed worker) must not hold a premium slot
// forever. The client heartbeats the lease while a body is still streaming (see
// withReleaseOnBodyEnd), so this TTL only has to bound crash recovery, not a
// normal long stream. Two minutes is the ceiling the tests pin.
const MODEL_GATE_LEASE_TTL_MS = 2 * 60 * 1000;

// A model that just threw INVALID_MODEL_ID is skipped for this long on the same
// account so a burst stops hammering the throttled model and fans out to the
// fallback chain instead. The throttle clears in seconds, so this is advisory:
// the resilient dispatcher only consults it to pick the first candidate.
const MODEL_COOLDOWN_MS = 30000;

// Overall admission budget for the acquire/poll loop. The gate acquire is
// non-blocking by design, so the client polls on waitMs; without a ceiling a
// sustained burst would merely convert 429s into unbounded waits. Once this
// budget is spent the dispatcher gives up on the gate and returns a normalized
// 429 rather than waiting forever.
const MODEL_GATE_ADMISSION_DEADLINE_MS = 30000;

// Stable Durable Object instance name for a credential's model gate. Must never
// embed a raw access token: prefer the account id, then email, then a coarse
// auth-method+region descriptor. Two calls for the same account resolve to the
// same instance; different accounts never collide.
function modelGateInstanceName(account) {
  const a = account || {};
  let id = a.id || a.email;
  if (!id) {
    const method = String(a.authMethod || "unknown").toLowerCase();
    const region = String(a.region || "global").toLowerCase();
    id = `${method}:${region}`;
  }
  return `model-gate:${id}`;
}

// Resolve the per-account gate Durable Object. The quota DO binding is reused
// with a separate instance name, so no new class, binding or migration is needed.
function modelGateStub(env, account) {
  if (!env?.API_KEY_QUOTA) return null;
  try {
    const id = env.API_KEY_QUOTA.idFromName(modelGateInstanceName(account));
    return env.API_KEY_QUOTA.get(id);
  } catch {
    return null;
  }
}

async function modelGateRequest(env, account, operation, body = {}) {
  const stub = modelGateStub(env, account);
  if (!stub) return null;
  try {
    const response = await stub.fetch(`https://model-gate/model-gate/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch {
    // A gate control-plane failure must not take down inference. The bounded
    // retry/fallback layer still protects the request when the gate is absent.
    return null;
  }
}

async function isModelCooledDown(env, account, model) {
  const state = await modelGateRequest(env, account, "status", { model });
  return Boolean(state?.cooledDown);
}

async function markModelCooldown(env, account, model) {
  await modelGateRequest(env, account, "cooldown", { model });
}

// Poll the non-blocking DO gate. The DO itself never waits (so release requests
// can always run); this caller sleeps for the returned waitMs under a hard
// admission deadline. A successful permit heartbeats until release, which keeps
// a legitimate long stream from being mistaken for a stale crashed lease.
async function acquireModelPermit(env, account, model, opts = {}) {
  const stub = modelGateStub(env, account);
  if (!stub) return { ok: true, release: async () => {} };

  const sleepFn = opts.sleep || sleep;
  const nowFn = opts.now || Date.now;
  const deadlineMs = Number(opts.deadlineMs) || MODEL_GATE_ADMISSION_DEADLINE_MS;
  const deadline = nowFn() + deadlineMs;

  while (true) {
    const result = await modelGateRequest(env, account, "acquire", { model });
    // Fail open only when the DO control plane itself is unavailable. A real
    // gate denial has ok:false and must be observed rather than bypassed.
    if (result === null) return { ok: true, release: async () => {} };
    if (result.ok && result.leaseId) {
      const leaseId = result.leaseId;
      let released = false;
      const heartbeatMs = Math.max(1000, Math.floor(MODEL_GATE_LEASE_TTL_MS / 3));
      const heartbeat = setInterval(() => {
        modelGateRequest(env, account, "renew", { model, leaseId }).catch(() => {});
      }, heartbeatMs);

      return {
        ok: true,
        leaseId,
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await modelGateRequest(env, account, "release", { model, leaseId });
        },
      };
    }

    const remaining = deadline - nowFn();
    if (remaining <= 0) {
      return { ok: false, waitMs: Math.max(0, Number(result.waitMs) || 0) };
    }
    const waitMs = Math.max(1, Math.min(remaining, Number(result.waitMs) || 250));
    await sleepFn(waitMs);
  }
}

// Kiro can carry a modeled exception as the FIRST AWS event-stream frame while
// the HTTP status is 200. If we expose client SSE headers before reading that
// frame, fallback is no longer possible and the client receives an in-stream
// rate_limit_error. Preflight exactly one frame, convert an immediate exception
// into an ordinary error Response for callKiroResilient, and replay every byte
// unchanged when it is a normal event. This never buffers the generated answer.
async function preflightKiroEventStream(response) {
  if (!response?.ok || !response.body) return response;
  // This helper is only used for Kiro GenerateAssistantResponse, whose success
  // contract is AWS event-stream regardless of the Content-Type label. Inspect
  // every 2xx body: production has returned binary event frames under x-amz-json
  // and other generic labels, and skipping those labels leaks an empty stream to
  // the client after SSE headers are already committed.

  const reader = response.body.getReader();
  let prefix = new Uint8Array(0);
  let sourceDone = false;
  let scanOffset = 0;
  let productive = false;
  const maxPreflightBytes = 1024 * 1024;
  const append = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  const readMore = async () => {
    const next = await reader.read();
    if (next.done) {
      sourceDone = true;
      return false;
    }
    prefix = append(prefix, next.value);
    return true;
  };
  const transientEmpty = async (detail) => {
    try { await reader.cancel("preflight transient empty"); } catch {}
    return new Response(JSON.stringify({
      error: "Upstream returned no usable event-stream output",
      detail: String(detail || "empty event stream").slice(0, 300),
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Kiro-Transient-Empty": "1",
        "Retry-After": "1",
      },
    });
  };

  try {
    // Scan only the initial housekeeping frames. As soon as text, reasoning, a
    // tool call, real output tokens or metering appears, replay the exact bytes
    // and let the normal parser stream the rest. The 1 MiB cap prevents an
    // unknown upstream frame sequence from turning preflight into buffering.
    while (!productive && !sourceDone && scanOffset < maxPreflightBytes) {
      while (prefix.length - scanOffset < 12 && !sourceDone) await readMore();
      if (prefix.length - scanOffset < 12) break;

      const view = new DataView(prefix.buffer, prefix.byteOffset + scanOffset, prefix.byteLength - scanOffset);
      const totalLen = view.getUint32(0, false);
      const headersLen = view.getUint32(4, false);
      if (totalLen < 16 || totalLen > 1024 * 1024 || headersLen > totalLen - 16 || headersLen > 8192) {
        return transientEmpty(`invalid AWS event-stream prelude (total=${totalLen}, headers=${headersLen})`);
      }
      while (prefix.length - scanOffset < totalLen && !sourceDone) await readMore();
      if (prefix.length - scanOffset < totalLen) break;

      const frameStart = scanOffset;
      const headersStart = frameStart + 12;
      const headersEnd = headersStart + headersLen;
      const payloadEnd = frameStart + totalLen - 4;
      const frameHeaders = parseFrameHeaders(prefix.subarray(headersStart, headersEnd));
      const eventType = String(frameHeaders[":event-type"] || "");
      const messageType = String(frameHeaders[":message-type"] || "");
      const exceptionType = String(frameHeaders[":exception-type"] || frameHeaders[":error-code"] || "");
      const payloadText = new TextDecoder().decode(prefix.subarray(headersEnd, payloadEnd));
      let payloadJson = null;
      try { payloadJson = payloadText ? JSON.parse(payloadText) : null; } catch {}

      const isException = messageType === "exception" || messageType === "error" ||
        Boolean(exceptionType) || /Exception$/.test(eventType);
      if (isException) {
        const message = (payloadJson && (payloadJson.message || payloadJson.Message || payloadJson.errorMessage || payloadJson.reason)) ||
          frameHeaders[":error-message"] || payloadText || "Upstream event-stream exception";
        const name = exceptionType || eventType || "UpstreamException";
        const diagnostic = `${payloadText} ${message}`;
        const modeled = new KiroUpstreamException(name, message);
        const status = TRANSIENT_MODEL_REJECTION.test(diagnostic) ? 400 : modeled.status;
        try { await reader.cancel("preflight exception"); } catch {}
        return new Response(payloadText || JSON.stringify({ message, type: name }), {
          status,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }

      const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
      if (eventType === "assistantResponseEvent") {
        productive = Boolean(payloadJson && (
          nonEmptyString(payloadJson.content) ||
          nonEmptyString(payloadJson.text) ||
          nonEmptyString(payloadJson.delta?.text)
        ));
      } else if (eventType === "reasoningContentEvent") {
        productive = Boolean(payloadJson && (
          nonEmptyString(payloadJson.text) ||
          nonEmptyString(payloadJson.reasoningContent) ||
          nonEmptyString(payloadJson.content) ||
          nonEmptyString(payloadJson.delta?.text)
        ));
      } else if (eventType === "toolUseEvent") {
        // The normal assembler can flush a name-only tool by generating an ID,
        // but it deliberately ignores an ID-only fragment because no valid tool
        // call can be emitted without a name. Mirror that rule exactly so a
        // broken ID-only stream is retried instead of becoming a late 500/502.
        productive = Boolean(payloadJson && (
          payloadJson.name || payloadJson.toolName || payloadJson.tool_name
        ));
      } else if (eventType === "meteringEvent") {
        const positiveCredit = (value) => typeof value === "number" && value > 0;
        productive = Boolean(payloadJson && (
          positiveCredit(payloadJson.usage) || positiveCredit(payloadJson.credits) ||
          positiveCredit(payloadJson.meteringCredits) || positiveCredit(payloadJson.creditsConsumed) ||
          Number(payloadJson.outputTokenCount) > 0 || Number(payloadJson.outputTokens) > 0 ||
          Number(payloadJson.usage?.outputTokens) > 0 || Number(payloadJson.usage?.completionTokens) > 0
        ));
      } else if (eventType === "metadataEvent") {
        productive = Boolean(payloadJson && (
          Number(payloadJson.outputTokenCount) > 0 || Number(payloadJson.outputTokens) > 0 ||
          Number(payloadJson.usage?.outputTokens) > 0 || Number(payloadJson.usage?.completionTokens) > 0
        ));
      }
      scanOffset += totalLen;
    }
  } catch (err) {
    return transientEmpty(`preflight read failed: ${err && err.message ? err.message : err}`);
  }

  if (!productive) {
    const detail = sourceDone
      ? "event stream reached EOF without content, tool use, output tokens, or metering"
      : `event stream produced no usable output within ${maxPreflightBytes} preflight bytes`;
    return transientEmpty(detail);
  }

  let sentPrefix = false;
  const replay = new ReadableStream({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        if (prefix.length > 0) controller.enqueue(prefix);
        if (sourceDone) { controller.close(); return; }
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
  return new Response(replay, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Production adapter for the dependency-injected resilience core. Token refresh
// stays inside callKiroWithAuth, so proactive and one reactive refresh both run
// under the same model permit and the existing bounded same-model retry ramp.
function callKiroWithAccountResilience(env, account, payload, requestedModel) {
  return callKiroResilient({
    requestedModel,
    payload,
    send: async ({ payload: attemptPayload }) => ({
      response: await callKiroWithAuth(env, account, attemptPayload),
    }),
    acquire: (model) => acquireModelPermit(env, account, model),
    markCooldown: (model) => markModelCooldown(env, account, model),
    isCooledDown: (model) => isModelCooledDown(env, account, model),
  });
}

// Preserve the client-requested model in the JSON body for API compatibility,
// while making a fallback observable on every streaming/non-streaming response.
function addModelRoutingHeaders(response, requestedModel, actualModel, fallbackApplied = false) {
  if (!response || !actualModel) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Kiro-Actual-Model", actualModel);
  if (fallbackApplied) {
    headers.set("X-Kiro-Model-Fallback", `${requestedModel} -> ${actualModel}`);
  }
  const exposed = new Set(
    String(headers.get("Access-Control-Expose-Headers") || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
  );
  exposed.add("X-Kiro-Actual-Model");
  exposed.add("X-Kiro-Model-Fallback");
  headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Wrap a Response so a permit is released exactly once when the body reaches a
// terminal state — EOF, client cancel, or a stream error — and NOT before. The
// permit stays held while bytes remain unread (a slow client keeps the slot).
// Handles both the streamed body.getReader() path and the buffered .text() /
// .json() read path with a single-fire guard.
function withReleaseOnBodyEnd(response, releaseFn) {
  let releasePromise = null;
  const fire = () => {
    if (releasePromise) return releasePromise;
    releasePromise = Promise.resolve()
      .then(() => (releaseFn ? releaseFn() : undefined))
      .catch(() => {}); // release must never throw into the response stream
    return releasePromise;
  };

  // No body (e.g. 204, or an already-drained buffer): nothing to hold, release
  // now so the slot is not leaked.
  if (!response || !response.body) {
    fire();
    return response;
  }

  const source = response.body;
  const reader = source.getReader();
  const wrapped = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await fire();          // release DO slot before exposing EOF
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        await fire();            // upstream stream error
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* ignore */ }
      await fire();              // client disconnected mid-stream
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Deep-clone a Kiro request payload and rewrite every modelId to the target
// model without mutating the original. The current message and every history
// userInputMessage carry a modelId; tools, thinking config, history shape and
// all other fields are preserved verbatim.
function rebuildPayloadWithModel(payload, modelId) {
  const clone = JSON.parse(JSON.stringify(payload || {}));
  const cs = clone.conversationState;
  if (cs && typeof cs === "object") {
    const cur = cs.currentMessage && cs.currentMessage.userInputMessage;
    if (cur && typeof cur === "object" && "modelId" in cur) cur.modelId = modelId;
    if (Array.isArray(cs.history)) {
      for (const turn of cs.history) {
        const uim = turn && turn.userInputMessage;
        if (uim && typeof uim === "object" && "modelId" in uim) uim.modelId = modelId;
      }
    }
  }
  return clone;
}

// Resilient dispatch across the fallback chain. Dependency-injected so it is
// unit-testable without global stubbing:
//   send({ model, payload })      -> { response }         (one upstream attempt)
//   acquire(model)                -> { ok, release, waitMs } (a gate permit)
//   markCooldown(model)           -> record a per-account+model cooldown
//   isCooledDown(model)           -> is the model currently cooled down?
//   sleep(ms)                     -> pollable sleep (injected for tests)
//   onTokenRefresh()              -> reactive 401/403 refresh; returns truthy to
//                                    retry the SAME candidate under the SAME permit
// Returns { response, requestedModel, actualModel, fallbackApplied }.
async function callKiroResilient(opts) {
  const {
    requestedModel,
    payload,
    send,
    acquire,
    markCooldown,
    isCooledDown,
    sleep: sleepFn = sleep,
    onTokenRefresh,
  } = opts;

  const candidates = resolveFallbackCandidates(requestedModel);
  let lastThrottle = null; // { status, text } from the most recent INVALID_MODEL_ID
  let lastEmpty = null;    // internal 503 raised by bounded event-stream preflight

  for (const model of candidates) {
    // Skip a model that is actively cooling down; consult BEFORE any upstream
    // call so a known-throttled model costs nothing.
    if (isCooledDown && (await isCooledDown(model))) continue;

    // One permit per candidate attempt. A reactive token refresh is an inner
    // retry of the SAME attempt and must reuse this single permit.
    const permit = acquire ? await acquire(model) : { ok: true, release: async () => {} };
    if (!permit || !permit.ok) {
      // Local admission pressure is not an upstream INVALID_MODEL_ID signal.
      // Demote this request to a lighter candidate, but do not poison the model
      // cooldown for every later request — only a real upstream rejection may
      // write cooldown state.
      lastThrottle = { status: 400, text: JSON.stringify({ reason: "INVALID_MODEL_ID" }) };
      continue;
    }

    let released = false;
    const releaseOnce = async () => {
      if (released) return;
      released = true;
      if (permit.release) await permit.release();
    };

    try {
      const attemptPayload = rebuildPayloadWithModel(payload, model);
      let { response } = await send({ model, payload: attemptPayload });

      // Reactive credential refresh: same candidate, same permit, one retry.
      if (onTokenRefresh && isRejectedTokenResponse(response.status, await peekBody(response))) {
        const refreshed = await onTokenRefresh();
        if (refreshed) {
          ({ response } = await send({ model, payload: attemptPayload }));
        }
      }

      if (response.status >= 200 && response.status < 300) {
        // Success — the permit is handed to the response body lifecycle by the
        // caller (withReleaseOnBodyEnd). Do NOT release here.
        return {
          response,
          requestedModel,
          actualModel: model,
          fallbackApplied: model !== requestedModel,
          release: releaseOnce,
        };
      }

      const text = await peekBody(response);
      if (response.status === 503 && response.headers.get("X-Kiro-Transient-Empty") === "1") {
        // Empty 200 event streams are a transient capacity symptom seen during
        // live bursts. They are safe to retry on a fallback only because
        // preflight proved there was no content/tool/token/metering to duplicate.
        // Do not write model cooldown: only real INVALID_MODEL_ID may do that.
        lastEmpty = text || "Upstream returned an empty event stream";
        await releaseOnce();
        continue;
      }
      if (isTransientModelRejection(response.status, text)) {
        // Throttle: cool the model down before falling back, release the permit
        // for this failed candidate, and try the next one.
        lastThrottle = { status: response.status, text };
        if (markCooldown) await markCooldown(model);
        await releaseOnce();
        continue;
      }

      // Genuine non-throttle failure (e.g. a real 400): report verbatim, no
      // fallback. Release the permit first so it is never leaked.
      await releaseOnce();
      return { response, requestedModel, actualModel: model, fallbackApplied: model !== requestedModel, release: async () => {} };
    } catch (err) {
      await releaseOnce();
      throw err;
    }
  }

  if (lastEmpty !== null) {
    return {
      response: jsonResponse(
        { error: { message: "Kiro returned empty responses for every model candidate", type: "overloaded_error" } },
        503,
        { "Retry-After": "3" },
      ),
      requestedModel,
      actualModel: null,
      fallbackApplied: true,
      release: async () => {},
    };
  }

  // Every candidate was throttled or skipped: normalize to a 429 the client can
  // obey, never a raw 400.
  const norm = normalizeUpstreamFailure(
    lastThrottle ? lastThrottle.status : 400,
    lastThrottle ? lastThrottle.text : JSON.stringify({ reason: "INVALID_MODEL_ID" }),
  );
  return {
    response: jsonResponse(
      { error: { message: norm.message, type: "rate_limit_error" } },
      norm.status,
      norm.headers,
    ),
    requestedModel,
    actualModel: null,
    fallbackApplied: true,
    release: async () => {},
  };
}

// Read a response body for classification without consuming the stream the
// caller still needs. Clones first; falls back to the original if clone is
// unavailable (already-buffered test responses).
async function peekBody(response) {
  try {
    return await response.clone().text();
  } catch {
    try { return await response.text(); } catch { return ""; }
  }
}

const DEFAULT_CREDIT_RESERVATION = 0.01;
// Upper bound on the per-request quota hold. Streaming clients disconnect all
// the time and their settlement never runs, so a large unbounded hold turned
// every abandoned stream into permanently locked credits. Keeping the hold
// small means a leaked hold can only briefly freeze a sliver of the balance.
const MAX_CREDIT_RESERVATION = 1;

// Workers KV reads are served from an edge cache with a 60s floor, so a key's
// balance read straight from KV can lag several requests behind. The per-key
// Durable Object is strongly consistent, so it doubles as the live counter and
// request-log mirror that /check reads for real-time numbers.
const LIVE_LOG_LIMIT = 200;
// Rows handed to the /check dashboard (20 per page x 10 pages).
const CHECK_LOG_LIMIT = 200;
const LOCAL_CLUSTER = "kirogo";
const PEER_CLUSTER = "kiropool";
const MAX_PEER_LOGS = 500;

// An admission hold is released or settled within the lifetime of one upstream
// call. Anything older than this belongs to a request whose settlement never
// ran (aborted stream, worker eviction) and is reclaimed.
const HOLD_TTL_MS = 5 * 60 * 1000;

// How many recently-settled request ids the quota DO remembers for idempotency.
// A duplicate settlement only ever arrives moments after the original, so this
// only has to outlive one burst of in-flight requests.
const SETTLED_ID_LIMIT = 2000;

export class ApiKeyQuota {
  constructor(state) {
    this.state = state;
  }

  async loadApiKeyCatalog(seed) {
    const initialized = Boolean(await this.state.storage.get("catalogInitialized"));
    let keys = await this.state.storage.get("catalog");
    if (initialized && Array.isArray(keys)) {
      return { keys, initializedNow: false };
    }
    if (!Array.isArray(seed)) return null;
    keys = seed.map((entry) => ({ ...entry }));
    await this.state.storage.put({ catalog: keys, catalogInitialized: true });
    return { keys, initializedNow: true };
  }

  async saveApiKeyCatalog(keys) {
    await this.state.storage.put({ catalog: keys, catalogInitialized: true });
  }

  // Holds are kept as dated entries rather than one running total so a leaked
  // hold expires on its own. The old scalar total could only ever grow.
  async loadHolds() {
    let holds = await this.state.storage.get("holds");
    if (!Array.isArray(holds)) {
      // Migrate a pre-existing scalar total into one undated entry, which is
      // immediately expired — that is what reclaims already-leaked holds.
      const legacy = Number(await this.state.storage.get("reserved")) || 0;
      holds = legacy > 0 ? [{ amount: legacy, atMs: 0 }] : [];
    }
    const now = Date.now();
    return holds.filter((h) => h && Number(h.amount) > 0 && now - (Number(h.atMs) || 0) < HOLD_TTL_MS);
  }

  static sumHolds(holds) {
    return parseFloat(holds.reduce((sum, h) => sum + (Number(h.amount) || 0), 0).toFixed(6));
  }

  // Settlement only knows the hold's amount. A hold always matches exactly
  // because /reserve stores the amount it returned, so a miss means the hold was
  // already reclaimed by the TTL — in that case drop nothing rather than
  // stealing another request's live hold and under-reporting reserved.
  static dropHold(holds, amount) {
    if (!(amount > 0) || holds.length === 0) return holds;
    const idx = holds.findIndex((h) => Math.abs(Number(h.amount) - amount) < 1e-9);
    if (idx < 0) return holds;
    return holds.filter((_, i) => i !== idx);
  }

  async saveHolds(holds, extra = {}) {
    const reserved = ApiKeyQuota.sumHolds(holds);
    await this.state.storage.put({ holds, reserved, ...extra });
    return reserved;
  }

  // Ids of requests whose charge has already been applied to `used`. Bounded
  // ring: a settlement is only ever replayed within seconds of the original
  // (a re-invoked waitUntil task), so a few thousand recent ids is ample and
  // keeps the stored value small. Mirrors the `seen` array the
  // /account-usage handler already uses for the same purpose.
  async loadSettledIds() {
    const stored = await this.state.storage.get("settledIds");
    return new Set(Array.isArray(stored) ? stored : []);
  }

  async markSettled(requestId) {
    const stored = await this.state.storage.get("settledIds");
    const ids = Array.isArray(stored) ? stored : [];
    if (ids.includes(requestId)) return;
    ids.push(requestId);
    if (ids.length > SETTLED_ID_LIMIT) ids.splice(0, ids.length - SETTLED_ID_LIMIT);
    await this.state.storage.put("settledIds", ids);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (url.pathname === "/account-usage") {
      // Serialize each credential's ledger independently of KV snapshots and
      // admin credential refreshes. Keep the seed once; never re-add it.
      const previous = this.accountUsageQueue || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const update = async (storage) => {
          let usage = await storage.get("accountUsage");
          if (!usage) {
            const seed = body.seed && typeof body.seed === "object" ? body.seed : {};
            usage = { ...seed, seen: [] };
          }
          if (!Array.isArray(usage.seen)) usage.seen = [];
          const applyIncrement = (inc) => {
            if (!inc || !inc.id || usage.seen.includes(inc.id)) return false;
            if (usage.totalTokens === null) {
              usage.tokensTrackedSince = Math.floor(Date.now() / 1000);
            }
            usage.requestCount = (Number(usage.requestCount) || 0) + 1;
            usage.totalTokens = (Number(usage.totalTokens) || 0) + (Number(inc.tokens) || 0);
            usage.totalCredits = parseFloat(((Number(usage.totalCredits) || 0) + (Number(inc.credits) || 0)).toFixed(6));
            usage.lastUsedUnix = Math.max(Number(usage.lastUsedUnix) || 0, Math.floor(Date.now() / 1000));
            usage.seen.push(inc.id);
            if (usage.seen.length > 5000) usage.seen = usage.seen.slice(-5000);
            return true;
          };
          applyIncrement(body.increment);
          for (const inc of Array.isArray(body.recover) ? body.recover : []) applyIncrement(inc);
          const inherit = body.inherit;
          if (inherit && typeof inherit === "object") {
            usage.requestCount = Math.max(Number(usage.requestCount) || 0, Number(inherit.requestCount) || 0);
            usage.totalCredits = parseFloat(Math.max(Number(usage.totalCredits) || 0, Number(inherit.totalCredits) || 0).toFixed(6));
            const inheritedTokens = inherit.totalTokens == null ? null : Number(inherit.totalTokens);
            if (inheritedTokens != null && Number.isFinite(inheritedTokens)) {
              usage.totalTokens = Math.max(Number(usage.totalTokens) || 0, inheritedTokens);
            }
            usage.lastUsedUnix = Math.max(Number(usage.lastUsedUnix) || 0, Number(inherit.lastUsedUnix) || 0);
            usage.tokensTrackedSince = Math.min(
              Number(usage.tokensTrackedSince) || Number(inherit.tokensTrackedSince) || 0,
              Number(inherit.tokensTrackedSince) || Number(usage.tokensTrackedSince) || 0,
            ) || (Number(usage.tokensTrackedSince) || Number(inherit.tokensTrackedSince) || 0);
          }
          await storage.put("accountUsage", usage);
          const { seen, ...view } = usage;
          return jsonResponse({ ok: true, usage: view });
        };
        return this.state.storage.transaction
          ? this.state.storage.transaction(update)
          : update(this.state.storage);
      });
      this.accountUsageQueue = task.then(() => {}, () => {});
      return task;
    }

    // Per-credential request health, bucketed by hour. The KV request log is
    // capped at 500 entries, which on a busy gateway is well under a day — far
    // too short to answer "what is this channel's 24h/7d error rate". Hourly
    // counters are tiny, so keep 7 days of them here instead and let the log
    // stay a recent-activity view.
    if (url.pathname === "/account-health") {
      const previous = this.accountHealthQueue || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        let health = await this.state.storage.get("health");
        if (!health || typeof health !== "object") health = { buckets: {}, last: null };
        if (!health.buckets || typeof health.buckets !== "object") health.buckets = {};

        const sample = body.sample && typeof body.sample === "object" ? body.sample : null;
        const nowUnix = Math.floor(Date.now() / 1000);
        if (sample) {
          const atUnix = Number(sample.atUnix) || nowUnix;
          const hour = Math.floor(atUnix / 3600) * 3600;
          const bucket = health.buckets[hour] || { ok: 0, err: 0, latSum: 0, latN: 0, codes: {} };
          const isOk = Boolean(sample.ok);
          if (isOk) bucket.ok += 1;
          else {
            bucket.err += 1;
            const code = String(sample.statusCode || sample.kindLabel || "error");
            bucket.codes[code] = (Number(bucket.codes[code]) || 0) + 1;
          }
          const lat = Number(sample.latencyMs);
          if (Number.isFinite(lat) && lat >= 0) {
            bucket.latSum += lat;
            bucket.latN += 1;
          }
          health.buckets[hour] = bucket;
          health.last = {
            ok: isOk,
            atUnix,
            statusCode: Number(sample.statusCode) || (isOk ? 200 : 0),
            error: isOk ? "" : String(sample.error || "").slice(0, 300),
            model: String(sample.model || ""),
            latencyMs: Number.isFinite(lat) ? Math.max(0, Math.round(lat)) : 0,
            endpoint: String(sample.endpoint || ""),
          };
          if (isOk) health.lastOkUnix = atUnix;
          else health.lastErrUnix = atUnix;
        }

        // Drop anything outside the widest window we report.
        const cutoff = Math.floor((nowUnix - 7 * 86400) / 3600) * 3600;
        for (const key of Object.keys(health.buckets)) {
          if (Number(key) < cutoff) delete health.buckets[key];
        }
        if (sample) await this.state.storage.put("health", health);

        const summarize = (windowSeconds) => {
          const from = nowUnix - windowSeconds;
          let ok = 0, err = 0, latSum = 0, latN = 0;
          const codes = {};
          for (const [hourKey, b] of Object.entries(health.buckets)) {
            // A bucket is included when any part of its hour is in range.
            if (Number(hourKey) + 3600 <= from) continue;
            ok += Number(b.ok) || 0;
            err += Number(b.err) || 0;
            latSum += Number(b.latSum) || 0;
            latN += Number(b.latN) || 0;
            for (const [code, n] of Object.entries(b.codes || {})) {
              codes[code] = (Number(codes[code]) || 0) + (Number(n) || 0);
            }
          }
          const total = ok + err;
          return {
            total,
            ok,
            err,
            errRate: total > 0 ? parseFloat(((err / total) * 100).toFixed(2)) : 0,
            avgLatencyMs: latN > 0 ? Math.round(latSum / latN) : 0,
            codes,
          };
        };

        return jsonResponse({
          ok: true,
          health: {
            last: health.last || null,
            lastOkUnix: Number(health.lastOkUnix) || 0,
            lastErrUnix: Number(health.lastErrUnix) || 0,
            h1: summarize(3600),
            h24: summarize(24 * 3600),
            d7: summarize(7 * 86400),
            serverTime: nowUnix,
          },
        });
      });
      this.accountHealthQueue = task.then(() => {}, () => {});
      return task;
    }

    if (url.pathname.startsWith("/catalog/")) {
      const loaded = await this.loadApiKeyCatalog(body.seed);
      if (!loaded) {
        return jsonResponse({ ok: false, error: "API key catalog is not initialized" }, 409);
      }

      const keys = loaded.keys;
      let changed = false;
      for (let idx = 0; idx < keys.length; idx++) {
        if (!keys[idx].id) {
          keys[idx].id = `key-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`;
          changed = true;
        }
        if (keys[idx].modelUsage === undefined) {
          keys[idx].modelUsage = {};
          changed = true;
        }
      }

      // Environment master keys may be added after the catalog was first
      // initialized. Merge only these explicit entries; never merge the full KV
      // seed again, because an eventually-consistent read could resurrect a key
      // that an admin just deleted.
      if (Array.isArray(body.environmentEntries)) {
        for (const candidate of body.environmentEntries) {
          if (!candidate || !candidate.key || keys.some((entry) => entry.key === candidate.key)) continue;
          keys.push({ ...candidate });
          changed = true;
        }
      }

      const action = url.pathname.slice("/catalog/".length);
      const findIndex = (id) => keys.findIndex((entry) => entry.id === id || entry.key === id);
      let entry = null;
      let removed = null;
      let details = {};

      if (action === "list") {
        if (Array.isArray(body.seed)) {
          for (const s of body.seed) {
            const existing = keys.find((entry) => entry.id === s.id || entry.key === s.key);
            if (existing) {
              if (typeof s.enabled === "boolean" && s.enabled !== existing.enabled) {
                existing.enabled = s.enabled;
                changed = true;
              }
              if (typeof s.creditLimit === "number" && s.creditLimit !== existing.creditLimit) {
                existing.creditLimit = s.creditLimit;
                changed = true;
              }
              if (s.expiresAt !== undefined && s.expiresAt !== existing.expiresAt) {
                existing.expiresAt = s.expiresAt;
                changed = true;
              }
            }
          }
        }
      } else if (action === "create") {
        const candidate = body.entry && typeof body.entry === "object" ? { ...body.entry } : null;
        if (!candidate || !candidate.id || !String(candidate.key || "").trim()) {
          return jsonResponse({ ok: false, error: "Invalid API key entry" }, 400);
        }
        if (keys.some((item) => item.id === candidate.id || item.key === candidate.key)) {
          return jsonResponse({ ok: false, error: "API key already exists" }, 409);
        }
        if (candidate.modelUsage === undefined) candidate.modelUsage = {};
        keys.push(candidate);
        entry = candidate;
        changed = true;
      } else if (action === "update") {
        const idx = findIndex(String(body.id || ""));
        if (idx < 0) return jsonResponse({ ok: false, error: "API Key not found" }, 404);
        entry = keys[idx];
        details = applyApiKeyAdminUpdate(entry, body.patch || {});
        changed = true;
      } else if (action === "reset-usage") {
        const idx = findIndex(String(body.id || ""));
        if (idx < 0) return jsonResponse({ ok: false, error: "API Key not found" }, 404);
        entry = keys[idx];
        entry.credits = 0;
        entry.creditsUsed = 0;
        entry.tokens = 0;
        entry.tokensUsed = 0;
        entry.tokensIn = 0;
        entry.tokensOut = 0;
        entry.requests = 0;
        entry.requestsCount = 0;
        entry.modelUsage = {};
        changed = true;
      } else if (action === "expire") {
        const idx = findIndex(String(body.id || ""));
        if (idx < 0) return jsonResponse({ ok: false, error: "API Key not found" }, 404);
        entry = keys[idx];
        entry.expiresAt = Math.floor(Date.now() / 1000);
        entry.expiryPreset = "manual";
        changed = true;
      } else if (action === "delete") {
        const idx = findIndex(String(body.id || ""));
        if (idx >= 0) {
          removed = keys[idx];
          keys.splice(idx, 1);
          changed = true;
        }
      } else if (action === "usage") {
        const idx = findIndex(String(body.id || ""));
        if (idx >= 0) {
          entry = keys[idx];
          details = applyApiKeyUsage(entry, body.usage || {});
          changed = true;
        }
      } else {
        return jsonResponse({ ok: false, error: "Unknown API key catalog action" }, 404);
      }

      if (changed) await this.saveApiKeyCatalog(keys);
      return jsonResponse({
        ok: true,
        keys,
        entry,
        removed,
        details,
        initialized: loaded.initializedNow,
        changed,
      });
    }

    const storedUsed = Number(await this.state.storage.get("used")) || 0;

    if (url.pathname === "/reserve") {
      const sourceUsed = Math.max(0, Number(body.used) || 0);
      const seeded = Boolean(await this.state.storage.get("seeded"));
      // This DO is the authoritative live balance and KV is a lagging mirror of
      // it. Re-seeding "used" from KV on every reserve discarded every
      // settlement newer than the 60s KV read cache, so usage looked frozen no
      // matter how many requests ran. Seed once, then only ever move forward.
      // Admin edits and resets go through /sync, which sets "used" explicitly.
      const used = seeded ? storedUsed : Math.max(storedUsed, sourceUsed);
      const peerUsed = Math.max(0, Number(body.peerUsed) || 0);
      const billed = parseFloat((used + peerUsed).toFixed(6));
      const limit = Math.max(0, Number(body.limit) || 0);
      const requested = Math.max(0, Number(body.amount) || DEFAULT_CREDIT_RESERVATION);

      const holds = await this.loadHolds();
      const reserved = ApiKeyQuota.sumHolds(holds);

      if (limit > 0 && billed + reserved + requested > limit) {
        await this.saveHolds(holds, { used, limit, seeded: true });
        return jsonResponse({ ok: false, used: billed, reserved, limit }, 402);
      }

      holds.push({ amount: requested, atMs: Date.now() });
      const nextReserved = await this.saveHolds(holds, { used, limit, seeded: true });
      return jsonResponse({ ok: true, reservation: requested, used, reserved: nextReserved, limit });
    }

    if (url.pathname === "/settle") {
      const reservation = Math.max(0, Number(body.reservation) || 0);
      const charge = Math.max(0, Number(body.charge) || 0);
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";

      // Idempotency guard: Cloudflare does not guarantee a ctx.waitUntil
      // callback runs exactly once (isolate eviction/retry can re-invoke it),
      // and /settle's `used = storedUsed + charge` is additive per call — a
      // duplicate call for the same logical request really does double-debit
      // the balance, not just double-log it. When the caller supplies a
      // requestId, skip re-applying a charge already settled under that id
      // and return the current state unchanged instead of adding again.
      if (requestId) {
        const settledIds = await this.loadSettledIds();
        if (settledIds.has(`settle:${requestId}`)) {
          const holds = await this.loadHolds();
          const reserved = ApiKeyQuota.sumHolds(holds);
          return jsonResponse({ ok: true, used: storedUsed, reserved, duplicate: true });
        }
      }

      const limit = Number(await this.state.storage.get("limit")) || 0;
      // The reservation is an admission hold, not a billing cap. Upstream
      // metering reports the true cost, which routinely exceeds the small
      // input-based hold, so capping the debit at the hold silently
      // undercounted usage. Bill the real charge; the hard limit still caps
      // the stored usage so settlement cannot run past the ceiling.
      const raw = storedUsed + charge;
      const used = parseFloat((limit > 0 ? Math.min(limit, raw) : raw).toFixed(6));
      const holds = ApiKeyQuota.dropHold(await this.loadHolds(), reservation);
      const reserved = await this.saveHolds(holds, { used, seeded: true });
      if (requestId) await this.markSettled(`settle:${requestId}`);
      return jsonResponse({ ok: true, used, reserved });
    }

    if (url.pathname === "/release") {
      const reservation = Math.max(0, Number(body.reservation) || 0);
      const holds = ApiKeyQuota.dropHold(await this.loadHolds(), reservation);
      const reserved = await this.saveHolds(holds, { seeded: true });
      return jsonResponse({ ok: true, used: storedUsed, reserved });
    }

    if (url.pathname === "/sync") {
      const used = Math.max(0, Number(body.used) || 0);
      const patch = { used, reserved: 0, holds: [], seeded: true };
      if (body.clearStats) {
        // A reset/delete/create must drop the live mirror too. "stats" is a
        // monotonic running total and /usage treats stats.credits as a floor
        // for "used", so leaving it behind made a reset undo itself on the
        // next request. /check also max()es requests/tokens against it, which
        // resurrected the old counters immediately.
        // settledIds go too: they describe charges against a balance that no
        // longer exists, and keeping them can only suppress a future settle.
        await this.state.storage.delete(["stats", "logs", "settledIds"]);
      } else {
        // Admin edited the balance without asking for a reset: keep the
        // request/token history and logs, but pull the credit floor down to
        // the new value so it cannot climb back on its own.
        const prev = await this.state.storage.get("stats");
        if (prev) {
          const next = { ...prev, credits: used, updatedUnix: Math.floor(Date.now() / 1000) };
          // /check max()es the KV counters against these, so an admin edit that
          // only touched KV would be overwritten by the stale mirror on the very
          // next poll. Follow whichever counters the edit actually supplied.
          const stat = body.stats && typeof body.stats === "object" ? body.stats : null;
          if (stat) {
            if (Number.isFinite(Number(stat.requests))) next.requests = Math.max(0, Number(stat.requests));
            if (Number.isFinite(Number(stat.tokensIn))) next.tokensIn = Math.max(0, Number(stat.tokensIn));
            if (Number.isFinite(Number(stat.tokensOut))) next.tokensOut = Math.max(0, Number(stat.tokensOut));
            next.tokens = (Number(next.tokensIn) || 0) + (Number(next.tokensOut) || 0);
          }
          patch.stats = next;
        }
      }
      await this.state.storage.put(patch);
      return jsonResponse({ ok: true, used, reserved: 0 });
    }

    if (url.pathname === "/usage") {
      // Live usage mirror. KV stays the durable record of truth, but its reads
      // sit behind a 60s edge cache, so /check would otherwise show a stale
      // balance until the cache expired (the "must press F5" symptom).
      const inc = (body && typeof body.inc === "object" && body.inc) || {};
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      // Same replay hazard as /settle: stats.credits is a running total, so a
      // re-invoked waitUntil task would add the charge a second time and the
      // sticky `used = max(storedUsed, stats.credits, ...)` would then pin the
      // balance permanently high. Skip the additive half for a replayed id;
      // the max() correction below is idempotent and still runs.
      const duplicate = requestId ? (await this.loadSettledIds()).has(`usage:${requestId}`) : false;
      const prev = (await this.state.storage.get("stats")) || {};
      const nowUnix = Math.floor(Date.now() / 1000);
      const incCredits = duplicate ? 0 : (Number(inc.credits) || 0);
      const stats = {
        requests: (Number(prev.requests) || 0) + (duplicate ? 0 : (Number(inc.requests) || 0)),
        tokensIn: (Number(prev.tokensIn) || 0) + (duplicate ? 0 : (Number(inc.tokensIn) || 0)),
        tokensOut: (Number(prev.tokensOut) || 0) + (duplicate ? 0 : (Number(inc.tokensOut) || 0)),
        credits: parseFloat(((Number(prev.credits) || 0) + incCredits).toFixed(6)),
        lastUsedUnix: Number(inc.lastUsedUnix) || nowUnix,
        updatedUnix: nowUnix,
      };
      stats.tokens = stats.tokensIn + stats.tokensOut;

      // stats.credits is a pure running total of every metered charge and is
      // never rewritten, which makes it the trustworthy floor for "used".
      // /settle advances "used" by the same charges, so taking the max keeps
      // the two in agreement without double counting, and it heals any usage
      // that an earlier bug discarded. It also covers unlimited keys, which
      // never reserve and therefore never reach /settle at all.
      const limit = Number(await this.state.storage.get("limit")) || 0;
      const rawUsed = Math.max(storedUsed, stats.credits, Math.max(0, Number(body.usedFloor) || 0));
      const used = parseFloat((limit > 0 ? Math.min(limit, rawUsed) : rawUsed).toFixed(6));

      let logs = (await this.state.storage.get("logs")) || [];
      if (!Array.isArray(logs)) logs = [];
      if (!duplicate && body.log && typeof body.log === "object") {
        logs.unshift(body.log);
        if (logs.length > LIVE_LOG_LIMIT) logs.length = LIVE_LOG_LIMIT;
      }

      const patch = { stats, logs };
      if (used !== storedUsed) patch.used = used;
      await this.state.storage.put(patch);
      if (requestId && !duplicate) await this.markSettled(`usage:${requestId}`);
      const reserved = ApiKeyQuota.sumHolds(await this.loadHolds());
      return jsonResponse({ ok: true, used, reserved, stats, duplicate });
    }

    if (url.pathname === "/state") {
      const stats = (await this.state.storage.get("stats")) || null;
      let logs = (await this.state.storage.get("logs")) || [];
      if (!Array.isArray(logs)) logs = [];
      const limit = Number(await this.state.storage.get("limit")) || 0;
      const holds = await this.loadHolds();
      // Reclaim expired holds on read too, so an idle key does not keep
      // reporting balance that is locked by requests that ended long ago.
      const reserved = await this.saveHolds(holds);
      return jsonResponse({ ok: true, used: storedUsed, reserved, limit, stats, logs });
    }

    if (url.pathname === "/reset") {
      await this.state.storage.deleteAll();
      return jsonResponse({ ok: true, used: 0, reserved: 0 });
    }

    // ----------------------------------------------------------------- gate
    // Per-model concurrency + start-spacing gate and per-model cooldown, all
    // keyed inside this per-account DO. State lives under `mg:<model>`:
    //   { leases: [{ id, atMs }], lastGrantMs, cooldownUntilMs }
    // Stale leases (older than MODEL_GATE_LEASE_TTL_MS) are reclaimed on read so
    // a crashed worker cannot deadlock a slot.
    if (url.pathname.startsWith("/model-gate/")) {
      const model = String(body.model || "");
      const key = `mg:${model}`;
      const now = Date.now();
      const raw = (await this.state.storage.get(key)) || {};
      const gate = {
        leases: Array.isArray(raw.leases) ? raw.leases : [],
        lastGrantMs: Number(raw.lastGrantMs) || 0,
        cooldownUntilMs: Number(raw.cooldownUntilMs) || 0,
      };
      // Reclaim expired leases.
      gate.leases = gate.leases.filter(
        (l) => l && now - (Number(l.atMs) || 0) < MODEL_GATE_LEASE_TTL_MS,
      );

      const policy = modelGatePolicy(model);

      if (url.pathname === "/model-gate/acquire") {
        // Concurrency and request-start rate are separate upstream limits. A
        // free slot is not enough: every grant must also respect start spacing,
        // otherwise two non-premium slots open in the same millisecond and
        // recreate the burst this gate exists to absorb.
        if (gate.leases.length >= policy.maxInFlight) {
          await this.state.storage.put(key, gate);
          const oldest = gate.leases.reduce((m, l) => Math.min(m, Number(l.atMs) || now), now);
          const untilExpiry = Math.max(1, MODEL_GATE_LEASE_TTL_MS - (now - oldest));
          return jsonResponse({ ok: false, waitMs: Math.min(untilExpiry, Math.max(policy.spacingMs, 250)) });
        }
        const sinceGrant = now - gate.lastGrantMs;
        if (gate.lastGrantMs > 0 && sinceGrant < policy.spacingMs) {
          await this.state.storage.put(key, gate);
          return jsonResponse({ ok: false, waitMs: policy.spacingMs - sinceGrant });
        }
        const leaseId = crypto.randomUUID();
        gate.leases.push({ id: leaseId, atMs: now });
        gate.lastGrantMs = now;
        await this.state.storage.put(key, gate);
        return jsonResponse({ ok: true, leaseId });
      }

      if (url.pathname === "/model-gate/renew") {
        // Heartbeat: refresh the lease timestamp so a long legitimate stream
        // does not let the TTL reclaim a slot that is still in use.
        const leaseId = String(body.leaseId || "");
        const lease = gate.leases.find((l) => l.id === leaseId);
        if (lease) lease.atMs = now;
        await this.state.storage.put(key, gate);
        return jsonResponse({ ok: Boolean(lease) });
      }

      if (url.pathname === "/model-gate/release") {
        const leaseId = String(body.leaseId || "");
        gate.leases = gate.leases.filter((l) => l.id !== leaseId);
        await this.state.storage.put(key, gate);
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/model-gate/cooldown") {
        gate.cooldownUntilMs = now + MODEL_COOLDOWN_MS;
        await this.state.storage.put(key, gate);
        return jsonResponse({ ok: true, cooldownMs: MODEL_COOLDOWN_MS });
      }

      if (url.pathname === "/model-gate/status") {
        const cooledDown = gate.cooldownUntilMs > now;
        await this.state.storage.put(key, gate);
        return jsonResponse({
          ok: true,
          cooledDown,
          cooldownMs: cooledDown ? gate.cooldownUntilMs - now : 0,
          inFlight: gate.leases.length,
        });
      }

      return jsonResponse({ ok: false, error: "unknown model-gate op" }, 404);
    }

    return jsonResponse({ ok: true, used: storedUsed, reserved: ApiKeyQuota.sumHolds(await this.loadHolds()) });
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    // 1. Static Assets & Admin UI
    if (path === "/admin" || path === "/admin/") {
      return serveAdminIndex(request, env);
    }

    if (path.startsWith("/admin/") && !path.startsWith("/admin/api")) {
      return serveAdminAsset(request, env, path.slice("/admin".length));
    }

    if (path.startsWith("/assets/") || path === "/kiro.svg" || path === "/favicon.ico") {
      return serveAdminAsset(request, env, path);
    }

    // 2. Health check
    if (path === "/health") {
      return jsonResponse({
        status: "ok",
        version: VERSION,
        service: GATEWAY_NAME,
        protocol: "Kiro CLI API key runtime",
      }, 200, cors);
    }

    // 3. Client setup scripts
    if (path === "/setup-client.sh") {
      return serveSetupClientScript(url.origin);
    }
    if (path === "/set-endpoints.sh") {
      return serveSetEndpointsScript(url.origin);
    }
    if (path === "/setup-client.ps1") {
      return serveSetupClientPs1(url.origin);
    }

    // 4. Public Key & Quota Checker (/, /check, /quota, /v1/check, /key, /keys, /v1/key, /v1/quota, /check-key)
    if (
      (request.method === "GET" && path === "/") ||
      path === "/check" ||
      path === "/quota" ||
      path === "/v1/check" ||
      path === "/key" ||
      path === "/keys" ||
      path === "/v1/key" ||
      path === "/v1/keys" ||
      path === "/v1/quota" ||
      path === "/check-key" ||
      path.startsWith("/check/") ||
      path.startsWith("/key/") ||
      path.startsWith("/quota/")
    ) {
      return handleQuotaCheck(request, env, cors);
    }

    // 5. Admin API (/admin/api/*) — always JSON, never SPA HTML.
    if (path === "/admin/api" || path.startsWith("/admin/api/")) {
      try {
        const subpath = path === "/admin/api" ? "/" : path.slice("/admin/api".length);
        const resp = await handleAdminAPI(request, env, ctx, subpath, cors);
        const ctype = (resp.headers.get("Content-Type") || "").toLowerCase();
        if (ctype.includes("text/html")) {
          return jsonResponse({ ok: false, success: false, error: "Admin API returned HTML instead of JSON" }, 502, cors);
        }
        return resp;
      } catch (e) {
        return jsonResponse({ ok: false, success: false, error: e && e.message ? e.message : "admin api failed" }, 500, cors);
      }
    }

    // 6. Telemetry mock
    if (path === "/api/event_logging/batch") {
      return jsonResponse({ status: "ok" }, 200, cors);
    }

    // 7. Public Inference Endpoints
    if (path === "/v1/models" || path === "/models" || path === "/openai/v1/models") {
      const auth = await authorizeClient(request, env);
      if (!auth.ok) return handleAuthFailure(auth, "openai", cors);
      return handleModels(env, cors);
    }

    if (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens" || path === "/anthropic/v1/messages/count_tokens") {
      const auth = await authorizeClient(request, env);
      if (!auth.ok) return handleAuthFailure(auth, "claude", cors);
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      return jsonResponse({ input_tokens: estimateInputTokens(body) }, 200, cors);
    }

    if (path === "/v1/messages" || path === "/messages" || path === "/anthropic/v1/messages") {
      const auth = await authorizeClient(request, env);
      if (!auth.ok) return handleAuthFailure(auth, "claude", cors);
      return handleClaudeMessages(request, env, ctx, cors, auth.keyId);
    }

    if (path === "/v1/chat/completions" || path === "/chat/completions" || path === "/v1/responses" || path === "/openai/v1/chat/completions") {
      const auth = await authorizeClient(request, env);
      if (!auth.ok) return handleAuthFailure(auth, "openai", cors);
      return handleOpenAIChat(request, env, ctx, cors, auth.keyId);
    }

    // 8. Direct Kiro CLI Proxying (GenerateAssistantResponse or data plane requests)
    if (request.method === "POST" && (path === "/" || path === "/generateAssistantResponse" || path.startsWith("/generateAssistantResponse"))) {
      const auth = await authorizeClient(request, env, true);
      if (!auth.ok) return handleAuthFailure(auth, "openai", cors);
      return handleDirectKiroProxy(request, env, ctx, cors, auth.keyId);
    }

    // 9. Fallback: try static assets or SPA index
    if (path.startsWith("/admin/api") || path.startsWith("/v1/") || path === "/v1") {
      return jsonResponse({ error: "Not Found" }, 404, cors);
    }
    if (env.ASSETS) {
      try {
        const assetResp = await env.ASSETS.fetch(request);
        if (assetResp.status < 400) return assetResp;
      } catch {}
      return serveAdminIndex(request, env);
    }

    return jsonResponse({ error: "Not Found" }, 404, cors);
  },
};

// ==================== Helpers & Common ====================

function normalizePath(path) {
  if (!path) return "/";
  let p = path.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  // Collapse a doubled API prefix.
  //
  // The base URL published for this gateway ends in /v1, which is what
  // OpenAI-style clients need. Anthropic clients append /v1/messages themselves,
  // so configuring them with that same published URL produces /v1/v1/messages.
  // That answered 404 "Not Found" with nothing to indicate the prefix was the
  // problem, which is a hard error to read from the client side — Claude Code
  // reports it as a plain connection failure.
  //
  // There is no endpoint for which a repeated /v1 is meaningful, so treating it
  // as the single prefix it was meant to be costs nothing and makes the same base
  // URL work for both client families.
  while (p.startsWith("/v1/v1/")) {
    p = p.slice("/v1".length);
  }
  return p;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Admin-Password, anthropic-version, anthropic-beta, x-api-key, X-Pool-Key, x-pool-key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
    "Access-Control-Expose-Headers": "X-Request-Id, X-Gateway, Retry-After, Set-Cookie",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Gateway": GATEWAY_NAME,
      "X-Request-Id": `kiro-${crypto.randomUUID()}`,
      ...extraHeaders,
    },
  });
}

function unauthorized(cors) {
  return jsonResponse({ ok: false, error: "unauthorized" }, 401, cors);
}

// ==================== Static Asset Serving ====================

async function serveAdminIndex(request, env) {
  if (!env.ASSETS) {
    return new Response("KiroPool Admin UI: Static assets not bound (ASSETS missing).", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const rootUrl = new URL("/", request.url);
  const rootReq = new Request(rootUrl.toString(), request);
  const resp = await env.ASSETS.fetch(rootReq);
  const headers = new Headers(resp.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(resp.body, { status: 200, headers });
}

async function serveAdminAsset(request, env, subpath) {
  if (!env.ASSETS) {
    return new Response("Not Found", { status: 404 });
  }
  const cleanPath = subpath.startsWith("/") ? subpath : `/${subpath}`;
  const assetUrl = new URL(cleanPath, request.url);
  const assetReq = new Request(assetUrl.toString(), request);
  const resp = await env.ASSETS.fetch(assetReq);
  if (resp.status >= 400) {
    return serveAdminIndex(request, env);
  }
  const headers = new Headers(resp.headers);
  if (cleanPath.endsWith(".html")) {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(resp.body, { status: resp.status, headers });
}

// ==================== KV Storage & Persistence ====================

// Multi-source KV routing:
//  - source "kirogo"   -> env.KIRO_KV      (Kiro-Go Gateway, this worker)
//  - source "kiropool" -> env.KIROPOOL_KV  (kiro-pool-proxy worker, managed remotely)
// The active source is passed via `?source=` / `X-Kiro-Source` on admin API
// requests and stored client-side; the inference paths always use "kirogo".
const KV_SOURCES = {
  kirogo: (env) => env.KIRO_KV || null,
  kiropool: (env) => env.KIROPOOL_KV || null,
};

function resolveKvBinding(env, request) {
  let source = "";
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("source") || "").toLowerCase();
    if (q && KV_SOURCES[q]) source = q;
  } catch {}
  if (!source && request?.headers) {
    const hdr = (request.headers.get("X-Kiro-Source") || "").toLowerCase();
    if (hdr && KV_SOURCES[hdr]) source = hdr;
  }
  if (!source) source = "kirogo";
  return { source, ns: KV_SOURCES[source](env) };
}

async function getKV(env, key, fallback = null, request = null) {
  const ns = request ? resolveKvBinding(env, request).ns : KV_SOURCES.kirogo(env);
  if (!ns) return fallback;
  try {
    const raw = await ns.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function setKV(env, key, value, request = null) {
  const resolved = request ? resolveKvBinding(env, request) : { source: "kirogo", ns: KV_SOURCES.kirogo(env) };
  if (!resolved.ns) {
    throw new Error(`KV storage binding for ${resolved.source} is not configured; cannot persist ${key}`);
  }
  try {
    await resolved.ns.put(key, JSON.stringify(value));
  } catch (err) {
    console.error(`Failed to set KV key ${key}:`, err);
    throw new Error(`Failed to persist ${key} to KV storage`);
  }
}

function clusterOverlayKey(cluster, keyId) {
  return `overlay:${cluster}:key:${keyId}`;
}

function clusterLogsKey(cluster) {
  return `overlay:${cluster}:logs`;
}

function sanitizePeerLog(entry, cluster) {
  if (!entry || typeof entry !== "object") return null;
  const copy = { ...entry };
  delete copy.rawKey;
  copy.cluster = cluster;
  copy.id = copy.id || crypto.randomUUID();
  copy.timeUnix = Number(copy.timeUnix || copy.time || 0) || Math.floor(Date.now() / 1000);
  return copy;
}

function overlayUsageView(k) {
  return {
    creditsUsed: Number(k?.creditsUsed ?? k?.credits) || 0,
    requests: Number(k?.requestsCount ?? k?.requests) || 0,
    tokensIn: Number(k?.tokensIn) || 0,
    tokensOut: Number(k?.tokensOut) || 0,
    tokensUsed: Number(k?.tokensUsed ?? k?.tokens) || 0,
    lastUsedUnix: Number(k?.lastUsedUnix || k?.lastUsedAt) || 0,
    modelUsage: k?.modelUsage && typeof k.modelUsage === "object" ? k.modelUsage : {},
  };
}

async function getPeerKeyOverlay(env, keyId) {
  if (!keyId) return null;
  const stored = await getKV(env, clusterOverlayKey(PEER_CLUSTER, keyId), null);
  return stored && typeof stored === "object" ? stored : null;
}

async function getPeerLogs(env) {
  const stored = await getKV(env, clusterLogsKey(PEER_CLUSTER), []);
  return Array.isArray(stored) ? stored : [];
}

function peerDelta(overlay) {
  // Lifetime snapshots from the other worker MUST NOT be added to this
  // cluster's catalog. That double-counted historical spend (Pter 2650+2269
  // = 4920 against a 3000 limit) and locked keys that still had headroom.
  // Only post-cutover increments (mode === "delta") count.
  if (!overlay || overlay.mode !== "delta") {
    return { creditsUsed: 0, requests: 0, tokensIn: 0, tokensOut: 0, tokensUsed: 0, lastUsedUnix: 0 };
  }
  return overlay;
}

function combinedCreditsUsed(localUsed, peerOverlay) {
  return parseFloat(((Number(localUsed) || 0) + (Number(peerDelta(peerOverlay).creditsUsed) || 0)).toFixed(6));
}

async function incrementPeerOverlay(env, keyId, inc, logEntry = null) {
  if (!keyId || ["unrestricted", "admin-key", "env-master-key", "direct_cli"].includes(keyId) || String(keyId).startsWith("acc-")) {
    return;
  }
  const key = clusterOverlayKey(LOCAL_CLUSTER, keyId);
  const prev = await getKV(env, key, null);
  const base = prev && prev.mode === "delta" ? prev : {};
  const tokensIn = Number(inc?.tokensIn) || 0;
  const tokensOut = Number(inc?.tokensOut) || 0;
  const next = {
    mode: "delta",
    creditsUsed: parseFloat(((Number(base.creditsUsed) || 0) + (Number(inc?.credits) || 0)).toFixed(6)),
    requests: (Number(base.requests) || 0) + (Number(inc?.requests) || 1),
    tokensIn: (Number(base.tokensIn) || 0) + tokensIn,
    tokensOut: (Number(base.tokensOut) || 0) + tokensOut,
    tokensUsed: (Number(base.tokensUsed) || 0) + tokensIn + tokensOut,
    lastUsedUnix: Math.floor(Date.now() / 1000),
    updatedUnix: Math.floor(Date.now() / 1000),
  };
  await setKV(env, key, next);
  if (!logEntry) return;
  const sanitized = sanitizePeerLog(logEntry, LOCAL_CLUSTER);
  if (!sanitized) return;
  const logs = await getKV(env, clusterLogsKey(LOCAL_CLUSTER), []);
  const list = Array.isArray(logs) ? logs : [];
  list.unshift(sanitized);
  if (list.length > MAX_PEER_LOGS) list.length = MAX_PEER_LOGS;
  await setKV(env, clusterLogsKey(LOCAL_CLUSTER), list);
}

async function clearClusterOverlays(env, keyId) {
  if (!keyId || !env.KIRO_KV) return;
  try {
    await env.KIRO_KV.delete(clusterOverlayKey(LOCAL_CLUSTER, keyId));
    await env.KIRO_KV.delete(clusterOverlayKey(PEER_CLUSTER, keyId));
  } catch (err) {
    console.error("Failed to clear cluster overlays:", err);
  }
}

// Cloudflare KV deliberately trades consistency for global read throughput. It
// cannot safely be the read-after-write source for a mutable JSON catalog: a
// cached pre-write value may be returned for about a minute, and a request-usage
// writer can overwrite a newly-created key with its stale whole-array snapshot.
// Reuse the existing Durable Object namespace for one strongly-consistent local
// catalog. KiroPool remains a direct KV view because that namespace is managed by
// another Worker and must continue reflecting its out-of-band changes.
function apiKeyCatalogBinding(env, request = null) {
  const resolved = request ? resolveKvBinding(env, request) : { source: "kirogo", ns: KV_SOURCES.kirogo(env) };
  if (resolved.source !== "kirogo" || !env.API_KEY_QUOTA) return null;
  const id = env.API_KEY_QUOTA.idFromName("api-key-catalog:kirogo:v1");
  return { ...resolved, stub: env.API_KEY_QUOTA.get(id) };
}

async function callApiKeyCatalog(env, request, action, payload = {}) {
  const binding = apiKeyCatalogBinding(env, request);
  if (!binding) return null;
  const response = await binding.stub.fetch(`https://catalog/catalog/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const err = new Error(data.error || `API key catalog ${action} failed`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function mirrorApiKeyCatalog(env, request, keys) {
  try {
    await setKV(env, "config:api_keys", keys, request);
  } catch (err) {
    // The Durable Object is already durable and remains authoritative. Keep the
    // admin operation successful, but surface the lagging compatibility mirror.
    console.error("Failed to mirror API key catalog to KV:", err);
  }
}

async function mutateApiKeyCatalog(env, request, action, payload, seed, options = {}) {
  const data = await callApiKeyCatalog(env, request, action, {
    ...payload,
    seed: Array.isArray(seed) ? seed : undefined,
  });
  if (!data) return null;
  if (options.mirror !== false && Array.isArray(data.keys)) {
    await mirrorApiKeyCatalog(env, request, data.keys);
  }
  return data;
}

async function getSettings(env) {
  const defaults = {
    strategy: "smart",
    adminPassword: true,
    listenAddr: "0.0.0.0:5000",
    password: env.ADMIN_PASSWORD || "changeme",
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const stored = await getKV(env, "config:settings", {});
  return { ...defaults, ...stored };
}

async function getAccounts(env, request = null) {
  const { source, ns } = request ? resolveKvBinding(env, request) : { source: "kirogo", ns: KV_SOURCES.kirogo(env) };
  if (!ns) return [];
  const stored = await getKV(env, "config:accounts", null, request);
  if (Array.isArray(stored)) return stored;

  // Only seed local environment secrets for the local 'kirogo' namespace
  if (source !== "kirogo") return [];

  // Seed from environment secrets if KV has no accounts yet
  const envRaw = String(env.KIRO_API_KEYS || "").trim();
  if (!envRaw) return [];
  const seeded = envRaw.split(/[\n,]+/).map((entry, idx) => {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const sep = trimmed.lastIndexOf("|");
    let key = trimmed;
    let region = DEFAULT_REGION;
    if (sep > 0) {
      key = trimmed.slice(0, sep).trim();
      region = trimmed.slice(sep + 1).trim().toLowerCase();
    }
    return {
      id: `acc-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`,
      email: `kiro-key-${idx + 1}`,
      authMethod: "api_key",
      region,
      kiroApiKey: key,
      accessToken: key,
      enabled: true,
      credits: 0,
      requests: 0,
      lastUsedUnix: 0,
      usageLimit: 0,
      usageCurrent: 0,
      nextResetUnix: 0,
      hasProfileArn: false,
      tokenExpires: 0,
      plan: "KIRO PRO",
    };
  }).filter(Boolean);

  if (seeded.length > 0) {
    await setKV(env, "config:accounts", seeded, request);
  }
  return seeded;
}

async function getApiKeys(env, request = null) {
  const resolved = request ? resolveKvBinding(env, request) : { source: "kirogo", ns: KV_SOURCES.kirogo(env) };
  const catalog = apiKeyCatalogBinding(env, request);
  if (!resolved.ns && !catalog) return [];

  let stored = resolved.ns ? await getKV(env, "config:api_keys", null, request) : null;
  if (!Array.isArray(stored)) stored = [];
  let needSave = false;

  for (let idx = 0; idx < stored.length; idx++) {
    if (!stored[idx].id) {
      stored[idx].id = `key-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`;
      needSave = true;
    }
    if (stored[idx].modelUsage === undefined) {
      stored[idx].modelUsage = {};
      needSave = true;
    }
  }

  const environmentEntries = [];
  // Only seed local master environment keys for the local 'kirogo' namespace.
  if (resolved.source === "kirogo") {
    const envRaw = String(env.CLIENT_API_KEYS || env.CLIENT_API_KEY || "").trim();
    if (envRaw) {
      const values = envRaw.split(/[\n,]+/).map((key) => key.trim()).filter(Boolean);
      for (let idx = 0; idx < values.length; idx++) {
        const key = values[idx];
        const existing = stored.find((item) => item.key === key);
        const candidate = existing || {
          id: `key-env-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`,
          name: `Master Key ${idx + 1}`,
          key,
          enabled: true,
          creditLimit: 0,
          requests: 0,
          credits: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokens: 0,
          createdUnix: Math.floor(Date.now() / 1000),
          lastUsedUnix: 0,
          modelUsage: {},
        };
        environmentEntries.push(candidate);
        if (!existing) {
          stored.push(candidate);
          needSave = true;
        }
      }
    }
  }

  if (catalog) {
    const data = await callApiKeyCatalog(env, request, "list", {
      seed: stored,
      environmentEntries,
    });
    if ((data.initialized || data.changed) && resolved.ns) {
      await mirrorApiKeyCatalog(env, request, data.keys);
    }
    return Array.isArray(data.keys) ? data.keys : [];
  }

  if (needSave) await setKV(env, "config:api_keys", stored, request);
  return stored;
}

async function getStats(env, request = null) {
  const defaults = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    totalTokens: 0,
    totalCredits: 0,
    startTime: Math.floor(Date.now() / 1000),
  };
  const stored = await getKV(env, "config:stats", {}, request);
  return { ...defaults, ...stored };
}

async function getLogs(env, request = null) {
  const stored = await getKV(env, "config:logs", [], request);
  if (!Array.isArray(stored)) return [];
  return stored.map((l) => {
    if (!l || typeof l !== "object") return l;
    const rawDur = l.duration ?? l.latencyMs ?? l.durationMs ?? l.latency;
    const dur = (rawDur !== undefined && rawDur !== null && rawDur !== "" && !isNaN(Number(rawDur)))
      ? Math.max(0, Math.round(Number(rawDur)))
      : 0;
    return {
      ...l,
      duration: dur,
      latencyMs: dur,
      durationMs: dur,
    };
  });
}

function calculateCredits(tokensIn = 0, tokensOut = 0, model = "") {
  // Matching Kiro-Go Go backend: Credits are primarily reported directly by upstream Kiro meteringEvent.
  // We do not inject inflated retail prices when upstream does not meter.
  return 0;
}

// Rough token cost of an image block. Anthropic charges for images by their
// pixel area (~(w*h)/750 tokens), but count_tokens only receives base64/URL
// source data, not dimensions. A base64 payload is ~4/3 the raw byte size, and
// tiles land around this order of magnitude, so a flat per-image estimate keeps
// long multimodal turns from being counted as free. It is deliberately a floor,
// not a precise figure — the client only needs to know the turn is non-trivial.
const IMAGE_TOKEN_ESTIMATE = 1600;

// Walks a content block, appending any character-costing text into `acc.parts`
// and counting image blocks into `acc.images`. Handles the block shapes Claude
// Code sends: text, thinking, tool_use (input object), tool_result (string or
// nested block array), and image blocks — recursing into tool_result content.
function collectBlockText(part, acc) {
  if (!part || typeof part !== "object") {
    if (typeof part === "string") acc.parts.push(part);
    return;
  }
  if (typeof part.text === "string") acc.parts.push(part.text);
  if (typeof part.thinking === "string") acc.parts.push(part.thinking);
  // tool_use carries its arguments as a structured object.
  if (part.input && typeof part.input === "object") {
    try { acc.parts.push(JSON.stringify(part.input)); } catch (_) {}
  }
  // tool_result content is either a plain string or an array of nested blocks.
  if (part.type === "tool_result" && part.content != null) {
    if (typeof part.content === "string") acc.parts.push(part.content);
    else if (Array.isArray(part.content)) {
      for (const inner of part.content) collectBlockText(inner, acc);
    }
  }
  if (part.type === "image") acc.images += 1;
}

function estimateInputTokens(input) {
  if (!input) return 20;
  const acc = { parts: [], images: 0 };
  if (typeof input.system === "string") acc.parts.push(input.system);
  else if (Array.isArray(input.system)) {
    for (const s of input.system) if (s?.text) acc.parts.push(s.text);
  }
  if (Array.isArray(input.messages)) {
    for (const msg of input.messages) {
      if (typeof msg?.content === "string") acc.parts.push(msg.content);
      else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) collectBlockText(part, acc);
      }
    }
  }
  if (Array.isArray(input.tools)) {
    try { acc.parts.push(JSON.stringify(input.tools)); } catch (_) {}
  }
  const text = acc.parts.join("");
  const estimated = Math.ceil(text.length / 3.8) + acc.images * IMAGE_TOKEN_ESTIMATE;
  return Math.max(10, estimated);
}

function estimateCreditReservation(body) {
  const inputTokens = estimateInputTokens(body);
  // Reserve by request size rather than a whole credit. A one-credit floor made
  // every key with <1 remaining unusable even for an 8-token completion.
  // max_tokens is deliberately NOT part of the estimate: clients send huge
  // values (200000 on 1M-context models) but buildClaudeKiroPayload never
  // forwards max_tokens upstream, so Kiro caps output on its own — the client
  // value says nothing about the real charge. Upstream metering still settles
  // the actual cost after the response; the hold only guards the race window.
  const estimatedInputCredits = inputTokens / 20000;
  return Math.min(MAX_CREDIT_RESERVATION, Math.max(DEFAULT_CREDIT_RESERVATION, estimatedInputCredits));
}

function quotaStub(env, keyId) {
  if (!env.API_KEY_QUOTA || !keyId || ["unrestricted", "admin-key", "env-master-key", "direct_cli"].includes(keyId) || keyId.startsWith("acc-")) return null;
  return env.API_KEY_QUOTA.get(env.API_KEY_QUOTA.idFromName(keyId));
}

async function reserveApiKeyQuota(env, keyObj, amount) {
  if (!keyObj || !(Number(keyObj.creditLimit) > 0)) return { ok: true, reservation: 0 };
  const stub = quotaStub(env, keyObj.id);
  if (!stub) return { ok: true, reservation: 0 };
  // Only used the first time this DO ever sees traffic, to seed its balance from
  // KV. After that the DO owns "used" and ignores this value.
  const used = Math.max(
    Number(keyObj.creditsUsed ?? keyObj.credits ?? 0) || 0,
    sumModelUsageCredits(keyObj.modelUsage),
  );
  const peer = await getPeerKeyOverlay(env, keyObj.id);
  const peerUsed = Number(peerDelta(peer).creditsUsed) || 0;
  const resp = await stub.fetch("https://quota/reserve", {
    method: "POST",
    body: JSON.stringify({
      used,
      peerUsed,
      limit: Number(keyObj.creditLimit),
      amount,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  return resp.ok ? data : { ok: false, ...data };
}

// requestId makes settlement idempotent. It must identify the LOGICAL client
// request (created once, before the account/model retry loop) rather than an
// individual upstream attempt: retry costs are already folded into one final
// charge by totalChargeFor(), so exactly one settle happens per logical
// request and any second call for the same id is a duplicate to be ignored.
async function settleApiKeyQuota(env, keyId, reservation, charge, requestId = "") {
  const stub = quotaStub(env, keyId);
  if (!stub || !reservation) return null;
  const resp = await stub.fetch("https://quota/settle", {
    method: "POST",
    body: JSON.stringify({
      reservation,
      charge: Math.max(0, Number(charge) || 0),
      requestId: String(requestId || ""),
    }),
  });
  return resp.json().catch(() => null);
}

async function releaseApiKeyQuota(env, keyId, reservation) {
  const stub = quotaStub(env, keyId);
  if (!stub || !reservation) return;
  await stub.fetch("https://quota/release", {
    method: "POST",
    body: JSON.stringify({ reservation }),
  });
}

async function resetApiKeyQuota(env, keyId, used = 0, clearStats = false, stats = null) {
  const stub = quotaStub(env, keyId);
  if (!stub) return;
  await stub.fetch("https://quota/sync", {
    method: "POST",
    body: JSON.stringify({
      used: Math.max(0, Number(used) || 0),
      clearStats: Boolean(clearStats),
      ...(stats ? { stats } : {}),
    }),
  });
}

// Mirrors a just-finished request into the key's Durable Object so /check can
// report it immediately instead of waiting out the KV edge cache. usedFloor
// carries the independently accumulated metered total so the DO can correct a
// balance that drifted low.
async function pushApiKeyLiveUsage(env, keyId, inc, log = null, usedFloor = 0, requestId = "") {
  const stub = quotaStub(env, keyId);
  if (!stub) return null;
  try {
    const resp = await stub.fetch("https://quota/usage", {
      method: "POST",
      body: JSON.stringify({
        inc: inc || {},
        log,
        usedFloor: Math.max(0, Number(usedFloor) || 0),
        requestId: String(requestId || ""),
      }),
    });
    return await resp.json().catch(() => null);
  } catch {
    return null;
  }
}

// Per-model credits are only ever incremented, so their sum is an unrewritten
// record of everything upstream metered for this key.
// Decides whether a finished stream owes money. Upstream meters what it actually
// generated, so a stream the client aborted mid-answer still owes for the tokens
// already produced; only a request that produced nothing gets its hold returned
// in full. Treating every non-success as a full release made cancelling streams
// free usage, which a cancel-heavy client (Claude Code interrupts constantly)
// turns into unlimited unbilled traffic.
//
// Named and exported-for-test on purpose: when this lived inline at the two call
// sites the regression suite could only re-implement it, so reverting the fix left
// the suite green.
function shouldSettleStream(isSuccess, meteredCredits) {
  return Boolean(isSuccess) || (Number(meteredCredits) || 0) > 0;
}

function sumModelUsageCredits(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return 0;
  let total = 0;
  for (const entry of Object.values(modelUsage)) {
    total += Number(entry?.credits) || 0;
  }
  return parseFloat(total.toFixed(6));
}

async function getApiKeyLiveState(env, keyId) {  const stub = quotaStub(env, keyId);
  if (!stub) return null;
  try {
    const resp = await stub.fetch("https://quota/state");
    const data = await resp.json().catch(() => null);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

function formatRelativeTime(unixSeconds) {
  if (!unixSeconds || unixSeconds <= 0) return "Never";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function formatDateTime(unixSeconds) {
  if (!unixSeconds || unixSeconds <= 0) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  });
}

function formatTokenExpiry(ts) {
  if (!ts || ts <= 0) return "Vĩnh viễn";
  const now = Math.floor(Date.now() / 1000);
  const diff = ts - now;
  if (diff <= 0) return "🔴 Đã hết hạn";
  if (diff < 3600) return "Còn " + Math.floor(diff / 60) + " phút";
  if (diff < 86400) return "Còn " + Math.floor(diff / 3600) + " giờ";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  return "Còn " + days + " ngày" + (hours > 0 ? (" " + hours + "h") : "");
}

function maskApiKey(key) {
  if (!key) return "";
  const str = String(key).trim();
  if (str.length <= 10) return str.slice(0, 3) + "••••" + str.slice(-2);
  const prefix = str.startsWith("ksk_") ? str.slice(0, 8) : (str.startsWith("kpp_") ? str.slice(0, 8) : (str.startsWith("sk-") ? str.slice(0, 7) : str.slice(0, 4)));
  const suffix = str.slice(-4);
  const dotsCount = Math.min(24, Math.max(8, str.length - prefix.length - suffix.length));
  return `${prefix}${"•".repeat(dotsCount)}${suffix}`;
}

function getKeyPrefix(key) {
  if (!key) return "";
  const str = String(key).trim();
  if (str.startsWith("ksk_") || str.startsWith("kpp_") || str.startsWith("sk-")) return str.slice(0, Math.min(10, str.length));
  return str.slice(0, Math.min(7, str.length));
}

function escapeHtmlVal(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrVal(str) {
  return escapeHtmlVal(str).replace(/"/g, "&quot;");
}

// Resolve an API key expiry. Returns epoch seconds, or 0 = never expires.
//  - epoch number  -> used as-is (fixed date/time)
//  - "8h"          -> now + 8 hours
//  - "1d" / "24h"  -> now + 1 day
//  - "eom"         -> last second of the current calendar month (server tz = UTC)
//  - "never"/""/0  -> 0
function resolveExpiry(expiresAt, preset) {
  const explicit = Number(expiresAt);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit > 1e12 ? explicit / 1000 : explicit);
  }
  if (preset) {
    const p = String(preset).trim().toLowerCase();
    const now = Date.now();
    if (p === "8h") return Math.floor((now + 8 * 3600 * 1000) / 1000);
    if (p === "1d" || p === "24h" || p === "1day") return Math.floor((now + 24 * 3600 * 1000) / 1000);
    if (p === "eom" || p === "endofmonth" || p === "end_of_month") {
      const d = new Date();
      const eom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
      return Math.floor(eom.getTime() / 1000);
    }
    if (p === "never" || p === "none" || p === "0") return 0;
  }
  return 0;
}

function applyApiKeyAdminUpdate(key, body) {
  if (typeof body.enabled === "boolean") key.enabled = body.enabled;
  if (typeof body.creditLimit === "number") key.creditLimit = body.creditLimit;

  let syncUsed = null;
  if (typeof body.creditsUsed === "number") {
    key.creditsUsed = body.creditsUsed;
    key.credits = body.creditsUsed;
    syncUsed = body.creditsUsed;
  } else if (typeof body.credits === "number") {
    key.credits = body.credits;
    key.creditsUsed = body.credits;
    syncUsed = body.credits;
  }

  if (typeof body.tokenLimit === "number") key.tokenLimit = body.tokenLimit;
  const editedTokens = typeof body.tokensUsed === "number"
    ? body.tokensUsed
    : (typeof body.tokens === "number" ? body.tokens : null);
  if (editedTokens !== null) {
    key.tokensUsed = editedTokens;
    key.tokens = editedTokens;
    const previousInput = Number(key.tokensIn) || 0;
    const previousOutput = Number(key.tokensOut) || 0;
    const previousTotal = previousInput + previousOutput;
    if (editedTokens <= 0) {
      key.tokensIn = 0;
      key.tokensOut = 0;
    } else if (previousTotal > 0) {
      key.tokensIn = Math.round(editedTokens * (previousInput / previousTotal));
      key.tokensOut = Math.max(0, editedTokens - key.tokensIn);
    } else {
      key.tokensIn = 0;
      key.tokensOut = editedTokens;
    }
  }

  const editedRequests = typeof body.requestsCount === "number"
    ? body.requestsCount
    : (typeof body.requests === "number" ? body.requests : null);
  if (editedRequests !== null) {
    key.requestsCount = editedRequests;
    key.requests = editedRequests;
  }
  if (body.name) key.name = body.name;
  if (body.expiryPreset !== undefined || body.expiresAt !== undefined) {
    if (body.expiryPreset === "never" || (Number(body.expiresAt) === 0 && !body.expiryPreset)) {
      key.expiresAt = 0;
      key.expiryPreset = "";
    } else {
      key.expiresAt = resolveExpiry(body.expiresAt, body.expiryPreset);
      key.expiryPreset = body.expiryPreset || "";
    }
  }

  return { syncUsed, editedTokens, editedRequests };
}

function applyApiKeyUsage(key, usage) {
  const tokensIn = Number(usage.tokensIn) || 0;
  const tokensOut = Number(usage.tokensOut) || 0;
  const credits = Number(usage.credits) || 0;
  const totalTokens = tokensIn + tokensOut;

  key.requests = (Number(key.requests ?? key.requestsCount) || 0) + 1;
  key.requestsCount = key.requests;
  key.tokensIn = (Number(key.tokensIn) || 0) + tokensIn;
  key.tokensOut = (Number(key.tokensOut) || 0) + tokensOut;
  key.tokens = (Number(key.tokens ?? key.tokensUsed) || 0) + totalTokens;
  key.tokensUsed = key.tokens;
  const incrementedCredits = parseFloat(((Number(key.creditsUsed ?? key.credits ?? 0) || 0) + credits).toFixed(6));
  const settledCredits = usage.quotaUsed == null ? incrementedCredits : (Number(usage.quotaUsed) || 0);
  key.lastUsedUnix = Math.floor(Date.now() / 1000);
  key.lastUsedAt = key.lastUsedUnix;

  if (!key.modelUsage || typeof key.modelUsage !== "object") key.modelUsage = {};
  const model = usage.model || "auto";
  if (!key.modelUsage[model]) {
    key.modelUsage[model] = {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      credits: 0,
      lastUsedUnix: 0,
    };
  }
  const modelUsage = key.modelUsage[model];
  modelUsage.requests = (Number(modelUsage.requests) || 0) + 1;
  modelUsage.tokensIn = (Number(modelUsage.tokensIn) || 0) + tokensIn;
  modelUsage.tokensOut = (Number(modelUsage.tokensOut) || 0) + tokensOut;
  modelUsage.tokensTotal = (Number(modelUsage.tokensTotal) || 0) + totalTokens;
  modelUsage.credits = parseFloat(((Number(modelUsage.credits) || 0) + credits).toFixed(6));
  modelUsage.lastUsedUnix = key.lastUsedUnix;

  const meteredTotal = sumModelUsageCredits(key.modelUsage);
  key.credits = parseFloat(Math.max(settledCredits, meteredTotal).toFixed(6));
  key.creditsUsed = key.credits;
  return { settledCredits, creditsUsed: key.credits };
}

async function recordRequestStats(env, ctx, isSuccess, tokensIn = 0, tokensOut = 0, credits = 0, logEntry = null, apiKeyId = "", accountId = "", model = "", quotaUsed = null, requestId = "") {
  // Normalized once, up front: the same entry object is written to the key's
  // Durable Object (live view) and to KV (durable view), and the shared id lets
  // /check merge the two lists without duplicating rows.
  let normalizedLogEntry = null;
  if (logEntry) {
    const rawDur = logEntry.duration ?? logEntry.latencyMs ?? logEntry.durationMs ?? logEntry.latency;
    const dur = (rawDur !== undefined && rawDur !== null && rawDur !== "" && !isNaN(Number(rawDur)))
      ? Math.max(0, Math.round(Number(rawDur)))
      : 0;
    normalizedLogEntry = {
      ...logEntry,
      // Prefer the caller's request id over a fresh random one: a replayed
      // settlement must produce the SAME row identity, otherwise /check's
      // signature-based dedup cannot collapse the two copies into one row.
      id: logEntry.id || requestId || crypto.randomUUID(),
      duration: dur,
      latencyMs: dur,
      durationMs: dur,
    };
  }

  const task = async () => {
    try {
      const totalTokens = (Number(tokensIn) || 0) + (Number(tokensOut) || 0);

      // Record account usage first, independently of KV/global/API-key mirrors.
      // Usage writers must never rewrite the credential catalogue.
      if (accountId && env.API_KEY_QUOTA) {
        const account = (await getAccounts(env)).find(a => a.id === accountId);
        if (account) await accountUsage(env, account, null, {
          id: normalizedLogEntry?.id || crypto.randomUUID(),
          tokens: totalTokens, credits: Number(credits) || 0,
        });
      }

      // Per-channel health. Written for every attributed request, including the
      // failures that never reach the usage ledger, because the Channel Status
      // view exists precisely to surface those.
      if (accountId) {
        await pushAccountHealthSample(env, accountId, {
          ok: Boolean(isSuccess),
          atUnix: Number(normalizedLogEntry?.timeUnix) || Math.floor(Date.now() / 1000),
          statusCode: Number(normalizedLogEntry?.statusCode) || (isSuccess ? 200 : 0),
          error: normalizedLogEntry?.error || "",
          model: model || normalizedLogEntry?.model || "",
          endpoint: normalizedLogEntry?.endpoint || "",
          latencyMs: Number(normalizedLogEntry?.duration) || 0,
        });
      }

      // 0. Mirror into the key's Durable Object first. This is the strongly
      // consistent copy /check reads, so the dashboard reflects the request
      // within a poll instead of after the KV edge cache expires.
      if (apiKeyId) {
        await pushApiKeyLiveUsage(
          env,
          apiKeyId,
          {
            requests: 1,
            tokensIn: Number(tokensIn) || 0,
            tokensOut: Number(tokensOut) || 0,
            credits: Number(credits) || 0,
            lastUsedUnix: Math.floor(Date.now() / 1000),
          },
          normalizedLogEntry,
          0,
          requestId,
        );
      }

      // 1. Update Global Stats
      const stats = await getStats(env);
      stats.totalRequests = (Number(stats.totalRequests) || 0) + 1;
      if (isSuccess) {
        stats.successRequests = (Number(stats.successRequests) || 0) + 1;
      } else {
        stats.failedRequests = (Number(stats.failedRequests) || 0) + 1;
      }
      stats.totalTokens = (Number(stats.totalTokens) || 0) + totalTokens;
      stats.totalTokensIn = (Number(stats.totalTokensIn) || 0) + (Number(tokensIn) || 0);
      stats.totalTokensOut = (Number(stats.totalTokensOut) || 0) + (Number(tokensOut) || 0);
      stats.totalCredits = parseFloat(((Number(stats.totalCredits) || 0) + credits).toFixed(6));
      await setKV(env, "config:stats", stats);

      // 2. Update API Key usage. The local catalog mutation is serialized by a
      // Durable Object and never rewrites KV from a stale request snapshot.
      if (apiKeyId) {
        const keys = await getApiKeys(env);
        const current = keys.find((item) => item.id === apiKeyId || item.key === apiKeyId);
        if (current) {
          const usage = {
            tokensIn: Number(tokensIn) || 0,
            tokensOut: Number(tokensOut) || 0,
            credits: Number(credits) || 0,
            quotaUsed,
            model: model || "auto",
          };
          const catalogMutation = await mutateApiKeyCatalog(
            env,
            null,
            "usage",
            { id: current.id, usage },
            keys,
            { mirror: false },
          );

          let updated = null;
          let usageDetails = null;
          if (catalogMutation) {
            updated = catalogMutation.entry;
            usageDetails = catalogMutation.details;
          } else {
            usageDetails = applyApiKeyUsage(current, usage);
            updated = current;
            await setKV(env, "config:api_keys", keys);
          }

          // Push the reconciled total back so admission control enforces the
          // real balance rather than a lower settlement snapshot.
          if (updated && usageDetails && Number(updated.creditsUsed) > Number(usageDetails.settledCredits)) {
            await pushApiKeyLiveUsage(env, apiKeyId, {}, null, Number(updated.creditsUsed) || 0);
          }
          if (updated) {
            await incrementPeerOverlay(env, current.id, {
              credits: Number(credits) || 0,
              requests: 1,
              tokensIn: Number(tokensIn) || 0,
              tokensOut: Number(tokensOut) || 0,
            }, normalizedLogEntry);
          }
        }
      }

      // 3. Compatibility usage writer for runtimes without Durable Objects.
      if (accountId && !env.API_KEY_QUOTA) {
        const accounts = await getAccounts(env);
        const a = accounts.find((item) => item.id === accountId);
        if (a) {
          const previous = toAccountView(a);
          // Older Worker accounts never accumulated tokens. Preserve that gap
          // instead of presenting the new counter as a complete lifetime total.
          if (previous.totalTokens === null) {
            a.tokensTrackedSince = Math.floor(Date.now() / 1000);
          }
          a.requests = previous.requestCount + 1;
          a.requestCount = a.requests;
          a.totalTokens = (previous.totalTokens || 0) + totalTokens;
          a.credits = parseFloat((previous.totalCredits + (Number(credits) || 0)).toFixed(6));
          a.totalCredits = a.credits;
          a.lastUsedUnix = Math.floor(Date.now() / 1000);
          await setKV(env, "config:accounts", accounts);
        }
      }

      // 4. Record Log
      if (normalizedLogEntry) {
        const logs = await getLogs(env);
        logs.unshift(normalizedLogEntry);
        if (logs.length > 500) logs.length = 500;
        await setKV(env, "config:logs", logs);
      }
    } catch (e) {
      console.error("Failed to record stats in background:", e);
    }
  };

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task());
    return;
  }
  // Returned so callers already inside a waitUntil-tracked promise (the stream
  // pump) can await it instead of orphaning the work.
  return task();
}

// ==================== Client Auth & Quota ====================

async function authorizeClient(request, env, isDirectProxy = false) {
  const keys = await getApiKeys(env, request);
  const accounts = await getAccounts(env, request);
  const settings = await getSettings(env, request);
  const managedKeyRequired = settings.requireApiKey !== false && keys.length > 0;

  // If no keys are registered and no env keys, allow requests if accounts exist
  if (keys.length === 0 && !env.CLIENT_API_KEYS && !env.CLIENT_API_KEY) {
    return { ok: true, keyId: "unrestricted", role: "admin" };
  }

  const authHeader = request.headers.get("Authorization") || "";
  const xApiKey = request.headers.get("x-api-key") || request.headers.get("X-Api-Key") || "";
  const poolKeyHeader = request.headers.get("X-Pool-Key") || request.headers.get("x-pool-key") || "";

  let bearerToken = "";
  if (authHeader.startsWith("Bearer ")) {
    bearerToken = authHeader.slice("Bearer ".length).trim();
  } else if (authHeader.startsWith("bearer ")) {
    bearerToken = authHeader.slice("bearer ".length).trim();
  } else if (authHeader) {
    bearerToken = authHeader.trim();
  }

  const presentedKey = bearerToken || xApiKey || poolKeyHeader;

  if (!presentedKey) {
    // For direct Kiro CLI calls without key, allow if pool has accounts and no poolKey configured
    if (isDirectProxy && keys.length === 0) {
      return { ok: true, keyId: "direct_cli", role: "client" };
    }
    return { ok: false, status: 401, error: "Missing API Key" };
  }

  const cleanPres = String(presentedKey || "").trim();

  // Match against client keys in KV
  const matchedKey = keys.find((k) => {
    const kVal = String(k.key || "").trim();
    const kId = String(k.id || "").trim();
    return kVal === cleanPres || kId === cleanPres;
  });
  if (matchedKey) {
    if (!matchedKey.enabled) {
      return { ok: false, status: 403, error: "API Key is disabled" };
    }
    if (matchedKey.expiresAt && Math.floor(Date.now() / 1000) >= matchedKey.expiresAt) {
      return { ok: false, status: 403, error: "API Key expired" };
    }
    const creditsUsed = Math.max(
      Number(matchedKey.creditsUsed ?? matchedKey.credits ?? 0) || 0,
      sumModelUsageCredits(matchedKey.modelUsage),
    );
    const peer = await getPeerKeyOverlay(env, matchedKey.id);
    if (matchedKey.creditLimit > 0 && combinedCreditsUsed(creditsUsed, peer) >= Number(matchedKey.creditLimit)) {
      return { ok: false, status: 402, error: "API Key credit limit exceeded" };
    }
    return { ok: true, keyId: matchedKey.id, keyObj: matchedKey, role: "client" };
  }

  // Once managed-key authentication is enabled, inference must be attributed to
  // one of those keys. Do not let admin passwords, environment master keys, or
  // provider account tokens bypass per-key credit/expiry controls.
  if (managedKeyRequired) {
    return { ok: false, status: 401, error: "Invalid API Key" };
  }

  // Match against environment secrets
  const envKeysRaw = String(env.CLIENT_API_KEYS || env.CLIENT_API_KEY || "").trim();
  if (envKeysRaw) {
    const validKeys = envKeysRaw.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
    if (validKeys.includes(presentedKey)) {
      return { ok: true, keyId: "env-master-key", role: "master" };
    }
  }

  // Match against admin password as fallback key
  if (presentedKey === settings.password || presentedKey === env.ADMIN_PASSWORD) {
    return { ok: true, keyId: "admin-key", role: "admin" };
  }

  // Also check if the client passed a valid Kiro account token directly
  const matchedAccount = accounts.find((a) => a.accessToken === presentedKey || a.kiroApiKey === presentedKey);
  if (matchedAccount) {
    return { ok: true, keyId: `acc-${matchedAccount.id}`, role: "account_pass_through" };
  }

  return { ok: false, status: 401, error: "Invalid API Key" };
}

function handleAuthFailure(auth, dialect = "openai", cors = {}) {
  const status = auth.status || 401;
  const msg = auth.error || "Unauthorized";
  if (dialect === "claude") {
    return jsonResponse({
      type: "error",
      error: {
        type: status === 402 ? "invalid_request_error" : "authentication_error",
        message: msg,
      },
    }, status, cors);
  }
  return jsonResponse({
    error: {
      type: status === 402 ? "insufficient_quota" : "invalid_request_error",
      message: msg,
      code: status === 402 ? "quota_exceeded" : "invalid_api_key",
      param: null,
    },
  }, status, cors);
}

// ==================== Session Auth & Admin API ====================

async function getAdminSession(request, env) {
  const settings = await getSettings(env);
  const expectedPwd = settings.password || settings.adminPassword || env.ADMIN_PASSWORD;

  // 1. Check direct password headers
  const suppliedPwd = request.headers.get("X-Admin-Password") || "";
  if (suppliedPwd && expectedPwd && (suppliedPwd === expectedPwd || suppliedPwd === env.ADMIN_PASSWORD)) {
    return { ok: true, type: "password" };
  }

  // 2. Check Authorization Bearer header
  const authHeader = request.headers.get("Authorization") || "";
  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
    if (expectedPwd && (token === expectedPwd || token === env.ADMIN_PASSWORD)) {
      return { ok: true, type: "bearer_password" };
    }
  }

  // 3. Check Cookie session
  const cookieTok = getCookie(request, "kpp_admin") || getCookie(request, "admin_session") || getCookie(request, "admin_password");
  if (cookieTok && expectedPwd && (cookieTok === expectedPwd || cookieTok === env.ADMIN_PASSWORD)) {
    return { ok: true, type: "cookie_password" };
  }

  const checkToken = token || cookieTok;
  if (checkToken) {
    const sessions = await getKV(env, "config:sessions", {});
    const session = sessions[checkToken];
    if (session && session.expiresAt > Date.now()) {
      return { ok: true, type: "session", token: checkToken };
    }
  }

  return { ok: false };
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (const part of parts) {
    const [k, v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v || "");
  }
  return null;
}

function toAccountView(a) {
  const usageLimit = Number(a.usageLimit) || 0;
  const usageCurrent = Number(a.usageCurrent) || 0;
  const trialUsageLimit = Number(a.trialUsageLimit) || 0;
  const trialUsageCurrent = Number(a.trialUsageCurrent) || 0;
  const requestCount = Math.max(Number(a.requestCount) || 0, Number(a.requests) || 0);
  const totalCredits = Math.max(Number(a.totalCredits) || 0, Number(a.credits) || 0);
  const storedTokens = a.totalTokens ?? a.tokens;
  const totalTokens = storedTokens != null && Number.isFinite(Number(storedTokens))
    ? Math.max(0, Number(storedTokens))
    : (requestCount > 0 ? null : 0);
  return {
    id: a.id,
    email: a.email || a.id,
    authMethod: a.authMethod || "api_key",
    region: a.region || DEFAULT_REGION,
    enabled: a.enabled !== false,
    hasToken: Boolean(a.accessToken || a.kiroApiKey),
    credits: totalCredits,
    totalCredits,
    totalTokens,
    tokensTrackedSince: Number(a.tokensTrackedSince) || 0,
    requests: requestCount,
    requestCount,
    lastUsedUnix: a.lastUsedUnix || 0,
    usageLimit,
    usageCurrent,
    usagePercent: usageLimit > 0 ? usageCurrent / usageLimit : 0,
    trialUsageLimit,
    trialUsageCurrent,
    trialUsagePercent: trialUsageLimit > 0 ? trialUsageCurrent / trialUsageLimit : 0,
    nextResetUnix: a.nextResetUnix || 0,
    hasProfileArn: Boolean(a.profileArn || a.hasProfileArn),
    tokenExpires: a.expiresAt || a.tokenExpires || 0,
    expiresAt: a.expiresAt || a.tokenExpires || 0,
    subscriptionType: a.subscriptionType || a.plan || (a.authMethod === "api_key" ? "KIRO PRO" : ""),
    plan: a.plan || (a.authMethod === "api_key" ? "KIRO PRO" : ""),
  };
}

function accountUsageIncrementFromLog(log) {
  if (!log || typeof log !== "object") return null;
  const id = String(log.id || "").trim();
  if (!id) return null;
  const tokens = Number(log.totalTokens ?? log.tokens ?? ((Number(log.inputTokens) || 0) + (Number(log.outputTokens) || 0))) || 0;
  return { id, tokens, credits: Number(log.credits) || 0 };
}

function logBelongsToAccount(log, account, siblingIds = []) {
  if (!log || !account) return false;
  const accountId = String(account.id || "");
  const email = String(account.email || "").trim().toLowerCase();
  const logAccount = String(log.account || "").trim().toLowerCase();
  const logAccountId = String(log.accountId || "");
  if (logAccountId === accountId) return true;
  if (email && logAccount === email) return true;
  return Boolean(logAccountId) && siblingIds.includes(logAccountId);
}

async function collectAccountRecoveryIncrements(env, account, request = null, siblingIds = []) {
  const recovered = [];
  const seen = new Set();
  const add = (log) => {
    if (!logBelongsToAccount(log, account, siblingIds)) return;
    const increment = accountUsageIncrementFromLog(log);
    if (!increment || seen.has(increment.id)) return;
    seen.add(increment.id);
    recovered.push(increment);
  };

  const keys = await getApiKeys(env, request);
  for (const key of keys) {
    const live = await getApiKeyLiveState(env, key.id);
    for (const log of Array.isArray(live?.logs) ? live.logs : []) add(log);
  }
  for (const log of await getLogs(env, request)) add(log);
  return recovered;
}

function accountEmailKey(account) {
  const email = String(account?.email || "").trim().toLowerCase();
  return /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email) ? email : "";
}

async function loadAccountUsageSnapshot(env, accountId) {
  if (!env.API_KEY_QUOTA || !accountId) return null;
  const id = env.API_KEY_QUOTA.idFromName(`account-usage:kirogo:v1:${accountId}`);
  const response = await env.API_KEY_QUOTA.get(id).fetch("https://account/account-usage", {
    method: "POST", body: JSON.stringify({ seed: { requestCount: 0, totalTokens: 0, totalCredits: 0, tokensTrackedSince: 0, lastUsedUnix: 0 } }),
  });
  const data = await response.json().catch(() => null);
  return data && data.ok ? data.usage : null;
}

async function saveAccountEmailUsage(env, email, usage) {
  if (!env.API_KEY_QUOTA || !email || !usage) return;
  const id = env.API_KEY_QUOTA.idFromName(`account-usage-email:kirogo:v1:${email}`);
  await env.API_KEY_QUOTA.get(id).fetch("https://account/account-usage", {
    method: "POST",
    body: JSON.stringify({
      seed: {
        requestCount: 0, totalTokens: 0, totalCredits: 0, tokensTrackedSince: 0, lastUsedUnix: 0,
      },
      inherit: usage,
    }),
  });
}

async function loadAccountEmailUsage(env, email) {
  if (!env.API_KEY_QUOTA || !email) return null;
  const id = env.API_KEY_QUOTA.idFromName(`account-usage-email:kirogo:v1:${email}`);
  const response = await env.API_KEY_QUOTA.get(id).fetch("https://account/account-usage", {
    method: "POST",
    body: JSON.stringify({ seed: { requestCount: 0, totalTokens: 0, totalCredits: 0, tokensTrackedSince: 0, lastUsedUnix: 0 } }),
  });
  const data = await response.json().catch(() => null);
  return data && data.ok ? data.usage : null;
}

// Records one request's outcome into the account's health ledger (Durable
// Object, hourly buckets) so the Channel Status admin view can show 1h/24h/7d
// error rates and the last ping without depending on the 500-entry log cap.
async function pushAccountHealthSample(env, accountId, sample) {
  if (!env.API_KEY_QUOTA || !accountId) return;
  try {
    const id = env.API_KEY_QUOTA.idFromName(`account-usage:kirogo:v1:${accountId}`);
    await env.API_KEY_QUOTA.get(id).fetch("https://account/account-health", {
      method: "POST",
      body: JSON.stringify({ sample }),
    });
  } catch (e) {
    console.error("Failed to push account health sample:", e);
  }
}

async function getAccountHealthState(env, accountId) {
  if (!env.API_KEY_QUOTA || !accountId) return null;
  try {
    const id = env.API_KEY_QUOTA.idFromName(`account-usage:kirogo:v1:${accountId}`);
    const response = await env.API_KEY_QUOTA.get(id).fetch("https://account/account-health", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => null);
    return data && data.ok ? data.health : null;
  } catch {
    return null;
  }
}

async function accountUsage(env, account, request = null, increment = null, recover = null, inherit = null) {
  const view = toAccountView(account);
  const seed = {
    requestCount: view.requestCount, totalTokens: view.totalTokens,
    totalCredits: view.totalCredits, tokensTrackedSince: view.tokensTrackedSince,
    lastUsedUnix: view.lastUsedUnix,
  };
  const source = request ? resolveKvBinding(env, request).source : "kirogo";
  if (!env.API_KEY_QUOTA || source !== "kirogo") return seed;
  const recovered = Array.isArray(recover) ? recover : [];
  const id = env.API_KEY_QUOTA.idFromName(`account-usage:kirogo:v1:${account.id}`);
  const response = await env.API_KEY_QUOTA.get(id).fetch("https://account/account-usage", {
    method: "POST", body: JSON.stringify({ seed, increment, recover: recovered, inherit }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Account usage ledger unavailable");
  const email = accountEmailKey(account);
  if (email) await saveAccountEmailUsage(env, email, data.usage);
  return data.usage;
}

async function accountListViews(env, accounts, request = null) {
  const knownEmails = new Set(accounts.map(accountEmailKey).filter(Boolean));
  // One-time repair: a deleted OAuth credential still has its Durable Object
  // ledger. Promote that snapshot into the email ledger so remaining API-key
  // rows for the same mailbox show the account total, not a partial row.
  if (env.API_KEY_QUOTA && knownEmails.has("testhellobao11@gmail.com")) {
    const previous = await loadAccountUsageSnapshot(env, "acc-1-f399a95d");
    const current = await loadAccountEmailUsage(env, "testhellobao11@gmail.com");
    if (previous && Number(previous.totalCredits) > Number(current?.totalCredits || 0)) {
      await saveAccountEmailUsage(env, "testhellobao11@gmail.com", previous);
    }
  }
  const views = await Promise.all(accounts.map(async (a) => {
    const email = accountEmailKey(a);
    const siblingIds = ACCOUNT_USAGE_SIBLINGS[email] || [];
    const recovered = await collectAccountRecoveryIncrements(env, a, request, siblingIds);
    const inherit = email ? await loadAccountEmailUsage(env, email) : null;
    const floor = ACCOUNT_USAGE_FLOOR[email] || null;
    const mergedInherit = {
      requestCount: Math.max(Number(inherit?.requestCount) || 0, Number(floor?.requestCount) || 0),
      totalCredits: Math.max(Number(inherit?.totalCredits) || 0, Number(floor?.totalCredits) || 0),
      totalTokens: Math.max(Number(inherit?.totalTokens) || 0, Number(floor?.totalTokens) || 0),
      lastUsedUnix: Number(inherit?.lastUsedUnix) || 0,
      tokensTrackedSince: Number(inherit?.tokensTrackedSince) || 0,
    };
    return {
      ...toAccountView(a),
      ...await accountUsage(env, a, request, null, recovered, mergedInherit),
    };
  }));
  // Email is shared across OAuth/API-key credentials. Never group masked
  // display labels or generated nicknames. Conflicting upstream user IDs win.
  const groups = new Map();
  accounts.forEach((a, i) => {
    const email = String(a.email || "").trim().toLowerCase();
    const validEmail = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email);
    const peers = validEmail ? accounts.filter(b => String(b.email || "").trim().toLowerCase() === email) : [];
    const userIds = new Set(peers.map(b => String(b.userId || "").trim()).filter(Boolean));
    const key = validEmail && userIds.size <= 1 ? `email:${email}` : (a.userId ? `user:${a.userId}` : `row:${a.id}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const indexes of groups.values()) {
    const rows = indexes.map(i => views[i]);
    const totalTokens = rows.some(a => a.totalTokens != null && a.totalTokens > 0)
      ? rows.reduce((sum, a) => sum + (a.totalTokens || 0), 0)
      : (rows.some(a => a.totalTokens === null) ? null : 0);
    const starts = rows.map(a => a.tokensTrackedSince).filter(n => n > 0);
    const totals = {
      requestCount: rows.reduce((sum, a) => sum + a.requestCount, 0),
      totalCredits: parseFloat(rows.reduce((sum, a) => sum + a.totalCredits, 0).toFixed(6)),
      totalTokens,
      tokensTrackedSince: starts.length ? Math.min(...starts) : 0,
      tokensIncomplete: starts.length > 0 || rows.some(a => a.totalTokens === null),
      usageScope: "account", linkedCredentialCount: indexes.length,
    };
    for (const i of indexes) Object.assign(views[i], totals, {
      requests: totals.requestCount, credits: totals.totalCredits,
    });
  }
  return views;
}

async function handleAdminAPI(request, env, ctx, path, cors) {
  const method = request.method;

  // 1. Unauthenticated routes: login & auth check
  if (path === "/auth" && method === "GET") {
    const session = await getAdminSession(request, env);
    return jsonResponse({
      authRequired: true,
      authed: session.ok,
    }, 200, cors);
  }

  if ((path === "/login" || path === "/auth/login") && method === "POST") {
    try {
      const body = await request.json();
      const settings = await getSettings(env);
      const expectedPwd = settings.password || settings.adminPassword || env.ADMIN_PASSWORD;
      const pwd = String(body.password || "").trim();

      if (!expectedPwd || (pwd !== expectedPwd && pwd !== env.ADMIN_PASSWORD)) {
        return jsonResponse({ ok: false, success: false, error: "Invalid password" }, 401, cors);
      }

      // Generate 32-byte hex session token
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      const token = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");

      const sessions = await getKV(env, "config:sessions", {});
      sessions[token] = {
        created: Date.now(),
        expiresAt: Date.now() + 12 * 3600 * 1000, // 12 hours
      };
      await setKV(env, "config:sessions", sessions);

      const cookieHeader = `kpp_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`;
      return jsonResponse({ ok: true, success: true, token }, 200, {
        ...cors,
        "Set-Cookie": cookieHeader,
      });
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  // 2. All other routes require admin session
  const session = await getAdminSession(request, env);
  if (!session.ok) {
    return unauthorized(cors);
  }

  if (path === "/logout" && method === "POST") {
    if (session.token) {
      const sessions = await getKV(env, "config:sessions", {});
      delete sessions[session.token];
      await setKV(env, "config:sessions", sessions);
    }
    const cookieHeader = "kpp_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
    return jsonResponse({ ok: true }, 200, {
      ...cors,
      "Set-Cookie": cookieHeader,
    });
  }

  // 3. Status & Overview stats (for both Kiro-Go and KiroPool UI)
  if ((path === "/status" || path === "/overview") && method === "GET") {
    const accounts = await getAccounts(env, request);
    const settings = await getSettings(env);
    const stats = await getStats(env, request);
    const enabledCount = accounts.filter((a) => a.enabled !== false).length;
    const availableCount = accounts.filter((a) => a.enabled !== false && (a.usageLimit <= 0 || a.usageCurrent < a.usageLimit)).length;
    const totalCredits = accounts.reduce((sum, a) => sum + (a.credits || 0), 0);
    const totalRequests = accounts.reduce((sum, a) => sum + (a.requests || 0), 0);
    const quotaUsed = accounts.reduce((sum, a) => sum + (a.usageCurrent || 0), 0);
    const quotaLimit = accounts.reduce((sum, a) => sum + (a.usageLimit || 0), 0);

    return jsonResponse({
      ok: true,
      success: true,
      accounts: accounts.length,
      totalAccounts: accounts.length,
      enabled: enabledCount,
      available: availableCount,
      totalRequests: stats.totalRequests || totalRequests,
      successRequests: stats.successRequests || 0,
      failedRequests: stats.failedRequests || 0,
      totalTokens: stats.totalTokens || 0,
      totalCredits: parseFloat((stats.totalCredits || totalCredits).toFixed(4)),
      quotaUsed: parseFloat(quotaUsed.toFixed(2)),
      quotaLimit: parseFloat(quotaLimit.toFixed(2)),
      strategy: settings.strategy || "smart",
      uptime: Math.floor(Date.now() / 1000) - (stats.startTime || Math.floor(Date.now() / 1000)),
    }, 200, cors);
  }

  // 4. Accounts CRUD & Actions
  if (path === "/accounts" && method === "GET") {
    const accounts = await getAccounts(env, request);
    return jsonResponse(await accountListViews(env, accounts, request), 200, cors);
  }

  // Channel Status: per-account ping health (last result, 1h/24h/7d error
  // rate, average latency) so an operator can see which credential is
  // actually failing without opening the raw request log.
  if (path === "/channels" && method === "GET") {
    const accounts = await getAccounts(env, request);
    const channels = await Promise.all(accounts.map(async (a) => {
      const health = await getAccountHealthState(env, a.id);
      return {
        id: a.id,
        email: a.email || a.id,
        authMethod: a.authMethod || "api_key",
        region: a.region || DEFAULT_REGION,
        enabled: a.enabled !== false,
        banStatus: a.banStatus || "ACTIVE",
        health: health || {
          last: null, lastOkUnix: 0, lastErrUnix: 0,
          h1: { total: 0, ok: 0, err: 0, errRate: 0, avgLatencyMs: 0, codes: {} },
          h24: { total: 0, ok: 0, err: 0, errRate: 0, avgLatencyMs: 0, codes: {} },
          d7: { total: 0, ok: 0, err: 0, errRate: 0, avgLatencyMs: 0, codes: {} },
          serverTime: Math.floor(Date.now() / 1000),
        },
      };
    }));
    return jsonResponse({ ok: true, success: true, channels }, 200, cors);
  }

  if (path === "/accounts" && method === "POST") {
    try {
      const body = await request.json();
      const accounts = await getAccounts(env, request);
      const id = body.id || `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`;
      const newAcc = {
        ...body,
        id,
        email: body.email || id,
        authMethod: body.authMethod || "api_key",
        region: body.region || DEFAULT_REGION,
        accessToken: body.accessToken || body.kiroApiKey || "",
        enabled: body.enabled !== false,
        credits: body.credits || 0,
        requests: body.requests || 0,
        lastUsedUnix: 0,
        usageLimit: body.usageLimit || 0,
        usageCurrent: body.usageCurrent || 0,
        nextResetUnix: body.nextResetUnix || 0,
        hasProfileArn: Boolean(body.profileArn),
        plan: body.plan || "",
      };
      accounts.push(newAcc);
      await setKV(env, "config:accounts", accounts, request);
      return jsonResponse({ ok: true, account: toAccountView(newAcc) }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  if (path.startsWith("/accounts/") && !path.includes("/test") && !path.includes("/refresh") && !path.includes("/full") && !path.includes("/models")) {
    const id = path.slice("/accounts/".length);
    if (method === "PATCH" || method === "PUT") {
      try {
        const body = await request.json();
        const accounts = await getAccounts(env, request);
        const acc = accounts.find((a) => a.id === id);
        if (!acc) return jsonResponse({ ok: false, success: false, error: "Account not found" }, 404, cors);
        if (typeof body.enabled === "boolean") acc.enabled = body.enabled;
        if (body.email) acc.email = body.email;
        if (body.region) acc.region = body.region;
        if (body.machineId) acc.machineId = body.machineId;
        if (typeof body.weight === "number") acc.weight = body.weight;
        if (body.proxyURL !== undefined) acc.proxyURL = body.proxyURL;
        await setKV(env, "config:accounts", accounts, request);
        return jsonResponse({ ok: true, success: true, account: toAccountView(acc) }, 200, cors);
      } catch (e) {
        return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
      }
    }
    if (method === "DELETE") {
      let accounts = await getAccounts(env, request);
      const removed = accounts.find((a) => a.id === id);
      if (removed) {
        const email = accountEmailKey(removed);
        const snapshot = await loadAccountUsageSnapshot(env, removed.id);
        if (email && snapshot) await saveAccountEmailUsage(env, email, snapshot);
      }
      accounts = accounts.filter((a) => a.id !== id);
      await setKV(env, "config:accounts", accounts, request);
      return jsonResponse({ ok: true, success: true }, 200, cors);
    }
  }

  // Account Full Info: GET /accounts/:id/full
  if (path.startsWith("/accounts/") && path.endsWith("/full") && method === "GET") {
    const id = path.slice("/accounts/".length, -"/full".length);
    const accounts = await getAccounts(env, request);
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return jsonResponse({ ok: false, error: "Account not found" }, 404, cors);
    return jsonResponse(acc, 200, cors);
  }

  // Account Models: cached IDs for the test dropdown, full metadata for detail views.
  if (path.startsWith("/accounts/") && path.endsWith("/models/cached") && method === "GET") {
    const stored = await getKV(env, "config:models", null, request);
    const source = Array.isArray(stored) && stored.length > 0 ? stored : FALLBACK_MODELS;
    const models = [...new Set(source.map((model) => {
      if (typeof model === "string") return model;
      return model && (model.modelId || model.id || model.modelName || model.name);
    }).filter(Boolean))].sort();
    return jsonResponse({ success: true, models }, 200, cors);
  }

  // Account Models: GET /accounts/:id/models & POST /accounts/:id/models/refresh
  if (path.startsWith("/accounts/") && path.endsWith("/models") && method === "GET") {
    const stored = await getKV(env, "config:models", null, request);
    const list = Array.isArray(stored) && stored.length > 0 ? stored : FALLBACK_MODELS.map((m) => ({ modelId: m, modelName: m }));
    return jsonResponse({ success: true, models: list }, 200, cors);
  }

  if (path.includes("/models/refresh") && method === "POST") {
    const synced = await syncKiroModels(env, request);
    return jsonResponse({ success: true, ok: true, synced }, 200, cors);
  }

  // Account Batch: POST /accounts/batch
  if (path === "/accounts/batch" && method === "POST") {
    try {
      const body = await request.json();
      const { ids, action } = body || {};
      const accounts = await getAccounts(env, request);
      if (Array.isArray(ids)) {
        if (action === "enable" || action === "disable") {
          const val = action === "enable";
          for (const a of accounts) {
            if (ids.includes(a.id)) a.enabled = val;
          }
          await setKV(env, "config:accounts", accounts, request);
        }
      }
      return jsonResponse({ success: true, ok: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  // Account Test: POST /accounts/:id/test
  if (path.startsWith("/accounts/") && path.endsWith("/test") && method === "POST") {
    const id = path.slice("/accounts/".length, -"/test".length);
    const accounts = await getAccounts(env, request);
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return jsonResponse({ ok: false, error: "Account not found" }, 404, cors);

    const body = await request.json().catch(() => ({}));
    const modelId = body.model || "auto";
    const testRes = await probeAccount(acc, modelId);
    return jsonResponse({
      ok: testRes.ok,
      success: testRes.ok,
      email: acc.email,
      model: modelId,
      hasProfileArn: Boolean(acc.profileArn),
      reply: testRes.reply,
      error: testRes.error,
    }, 200, cors);
  }

  // Account Refresh Quota: POST /accounts/:id/refresh or /accounts/:id/refresh-quota
  if (path.startsWith("/accounts/") && (path.endsWith("/refresh") || path.endsWith("/refresh-quota")) && method === "POST") {
    const suffix = path.endsWith("/refresh-quota") ? "/refresh-quota" : "/refresh";
    const id = path.slice("/accounts/".length, -suffix.length);
    const accounts = await getAccounts(env, request);
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return jsonResponse({ ok: false, success: false, error: "Account not found" }, 404, cors);

    try {
      const quota = await fetchAccountUsageLimits(acc);
      if (quota.ok) {
        acc.usageCurrent = quota.usageCurrent;
        acc.usageLimit = quota.usageLimit;
        acc.nextResetUnix = quota.nextResetUnix;
        if (quota.plan) acc.plan = quota.plan;
        if (quota.email) acc.email = quota.email;
        await setKV(env, "config:accounts", accounts, request);
        return jsonResponse({ ok: true, success: true, account: toAccountView(acc) }, 200, cors);
      }
      return jsonResponse({ ok: false, success: false, error: quota.error || "Failed to fetch quota" }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 200, cors);
    }
  }

  // Account Test Model: POST /accounts/:id/test-model
  if (path.startsWith("/accounts/") && path.endsWith("/test-model") && method === "POST") {
    const id = path.slice("/accounts/".length, -"/test-model".length);
    const accounts = await getAccounts(env, request);
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return jsonResponse({ ok: false, error: "Account not found" }, 404, cors);

    try {
      const body = await request.json();
      const modelId = body.model || "auto";
      const start = Date.now();
      const testRes = await probeAccount(acc, modelId);
      const elapsed = Date.now() - start;

      return jsonResponse({
        ok: testRes.ok,
        model: modelId,
        reply: testRes.reply,
        error: testRes.error,
        latencyMs: elapsed,
        duration: elapsed,
        durationMs: elapsed,
      }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 200, cors);
    }
  }

  // Account Import Local: POST /accounts/import-local
  if (path === "/accounts/import-local" && method === "POST") {
    try {
      const body = await request.json();
      return jsonResponse({ ok: true, message: "Local import received" }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  // 5. Settings API
  if (path === "/settings" && method === "GET") {
    const settings = await getSettings(env);
    return jsonResponse({
      apiKey: "",
      requireApiKey: settings.requireApiKey !== false,
      allowOverUsage: Boolean(settings.allowOverUsage),
      port: 5000,
      host: "0.0.0.0",
      strategy: settings.strategy || "smart",
      listenAddr: "0.0.0.0:5000",
      endpointMode: settings.endpointMode || "kiro_cli",
      sendTelemetry: Boolean(settings.sendTelemetry),
      adminPassword: Boolean(settings.password || env.ADMIN_PASSWORD),
      passwordEnv: Boolean(env.ADMIN_PASSWORD),
    }, 200, cors);
  }

  if (path === "/settings" && (method === "PATCH" || method === "POST")) {
    try {
      const body = await request.json();
      const settings = await getSettings(env);
      if (body.strategy) settings.strategy = body.strategy;
      if (typeof body.requireApiKey === "boolean") settings.requireApiKey = body.requireApiKey;
      if (typeof body.allowOverUsage === "boolean") settings.allowOverUsage = body.allowOverUsage;
      if (body.endpointMode) settings.endpointMode = body.endpointMode;
      if (typeof body.sendTelemetry === "boolean") settings.sendTelemetry = body.sendTelemetry;
      settings.updatedAt = Math.floor(Date.now() / 1000);
      await setKV(env, "config:settings", settings);
      return jsonResponse({ ok: true, success: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/prompt-filter" && method === "GET") {
    const pf = await getKV(env, "config:prompt_filters", { filterClaudeCode: false, filterEnvNoise: false, filterStripBoundaries: true, rules: [] });
    return jsonResponse(pf, 200, cors);
  }
  if (path === "/prompt-filter" && method === "POST") {
    try {
      const body = await request.json();
      await setKV(env, "config:prompt_filters", body);
      return jsonResponse({ success: true, ok: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/thinking-config" && method === "GET") {
    const settings = await getSettings(env);
    return jsonResponse({ mode: settings.nativeThinkingMode || "auto", display: settings.nativeThinkingDisplay || "summarized" }, 200, cors);
  }
  if (path === "/thinking-config" && method === "POST") {
    try {
      const body = await request.json();
      const settings = await getSettings(env);
      if (body.mode) settings.nativeThinkingMode = body.mode;
      if (body.display) settings.nativeThinkingDisplay = body.display;
      await setKV(env, "config:settings", settings);
      return jsonResponse({ success: true, ok: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/endpoint-config" && method === "GET") {
    const settings = await getSettings(env);
    return jsonResponse({ mode: settings.endpointMode || "kiro_cli" }, 200, cors);
  }
  if (path === "/endpoint-config" && method === "POST") {
    try {
      const body = await request.json();
      const settings = await getSettings(env);
      if (body.mode) settings.endpointMode = body.mode;
      await setKV(env, "config:settings", settings);
      return jsonResponse({ success: true, ok: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  // Proxy inventory is operator-managed metadata. Workers fetch() cannot use
  // arbitrary HTTP/SOCKS egress; never claim these entries are active routes.
  if (path === "/proxy-list" && method === "GET") {
    const entries = await getKV(env, "config:proxy_list", [], request);
    return jsonResponse({ success: true, active: false, proxies: Array.isArray(entries) ? entries.map(({ id, country, host, port, scheme, enabled, username }) => ({
      id, country, host, port, scheme, enabled, username,
    })) : [] }, 200, cors);
  }
  if (path === "/proxy-list" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const country = String(body.country || "").toUpperCase();
    const host = String(body.host || "").trim();
    const port = Number(body.port);
    const scheme = String(body.scheme || "http").toLowerCase();
    if (!["ID", "VN"].includes(country) || !/^[a-z0-9.-]+$/i.test(host) ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        !["http", "https", "socks5", "socks5h"].includes(scheme) ||
        String(body.username || "").length > 256 || String(body.password || "").length > 256) {
      return jsonResponse({ success: false, error: "Invalid proxy country, host, port or credentials" }, 400, cors);
    }
    const entries = await getKV(env, "config:proxy_list", [], request);
    if (!Array.isArray(entries) || entries.length >= 200) {
      return jsonResponse({ success: false, error: "Proxy list limit reached" }, 400, cors);
    }
    const entry = { id: crypto.randomUUID(), country, host, port, scheme,
      username: String(body.username || ""), password: String(body.password || ""), enabled: true };
    entries.push(entry);
    await setKV(env, "config:proxy_list", entries, request);
    return jsonResponse({ success: true, id: entry.id, active: false }, 200, cors);
  }
  if (path.startsWith("/proxy-list/") && (method === "PATCH" || method === "DELETE")) {
    const id = path.slice("/proxy-list/".length);
    const entries = await getKV(env, "config:proxy_list", [], request);
    const index = Array.isArray(entries) ? entries.findIndex((item) => item.id === id) : -1;
    if (index < 0) return jsonResponse({ success: false, error: "Proxy not found" }, 404, cors);
    if (method === "DELETE") entries.splice(index, 1);
    else {
      const body = await request.json().catch(() => ({}));
      if (typeof body.enabled !== "boolean") return jsonResponse({ success: false, error: "enabled must be boolean" }, 400, cors);
      entries[index].enabled = body.enabled;
    }
    await setKV(env, "config:proxy_list", entries, request);
    return jsonResponse({ success: true, active: false }, 200, cors);
  }
  if (path === "/proxy-config" && method === "GET") {
    return jsonResponse({ type: "none", host: "" }, 200, cors);
  }
  if (path === "/external-api-config" && method === "GET") {
    return jsonResponse({ openaiEnabled: false, claudeEnabled: false }, 200, cors);
  }

  if (path === "/generate-machine-id" && method === "GET") {
    return jsonResponse({ machineId: crypto.randomUUID() }, 200, cors);
  }

  // 6. API Keys API
  if ((path === "/api-keys" || path === "/keys") && method === "GET") {
    const keys = await getApiKeys(env, request);
    // The catalog is durable but its KV mirror sits behind a 60s edge cache, so
    // reading it alone made the admin list show a balance frozen since the last
    // cache expiry — the "numbers only move after F5 (or not at all)" symptom.
    // The per-key Durable Object is strongly consistent and is where every
    // finished request is mirrored, so overlay it exactly like /check does.
    const list = await Promise.all(keys.map(async (k) => {
      const live = await getApiKeyLiveState(env, k.id);
      const liveStats = live && live.stats ? live.stats : null;
      const kvTokensIn = Number(k.tokensIn) || 0;
      const kvTokensOut = Number(k.tokensOut) || Number(k.tokens) || 0;
      const kvRequests = Number(k.requestsCount) || Number(k.requests) || 0;
      const kvCreditsUsed = Number(k.creditsUsed) || Number(k.credits) || 0;

      const tokensIn = Math.max(kvTokensIn, liveStats ? Number(liveStats.tokensIn) || 0 : 0);
      const tokensOut = Math.max(kvTokensOut, liveStats ? Number(liveStats.tokensOut) || 0 : 0);
      const tokensUsed = Math.max(Number(k.tokensUsed) || 0, tokensIn + tokensOut);
      const requestsCount = Math.max(kvRequests, liveStats ? Number(liveStats.requests) || 0 : 0);
      // modelUsage is the unrewritten metered record, so it is the floor that
      // exposes credits an earlier settle bug dropped from the running total.
      const meteredCredits = sumModelUsageCredits(k.modelUsage);
      const liveUsed = live && Number.isFinite(Number(live.used)) ? Number(live.used) : 0;
      const creditsUsed = Math.max(kvCreditsUsed, liveUsed, meteredCredits);
      const lastUsedUnix = Math.max(
        Number(k.lastUsedUnix || k.lastUsedAt || 0) || 0,
        liveStats ? Number(liveStats.lastUsedUnix) || 0 : 0,
      );

      return {
        id: k.id,
        name: k.name || k.id,
        // Admin-only endpoint: expose the plaintext key so the row Copy action
        // copies a usable API key rather than the masked display value.
        key: k.key,
        keyMasked: maskApiKey(k.key),
        enabled: k.enabled !== false,
        tokenLimit: k.tokenLimit || 0,
        creditLimit: k.creditLimit || 0,
        tokensIn,
        tokensOut,
        tokens: tokensIn + tokensOut,
        tokensUsed,
        creditsUsed,
        credits: creditsUsed,
        reserved: live ? Number(live.reserved) || 0 : 0,
        requestsCount,
        requests: requestsCount,
        createdUnix: k.createdUnix || k.createdAt || Math.floor(Date.now() / 1000),
        createdAt: k.createdAt || k.createdUnix || Math.floor(Date.now() / 1000),
        expiresAt: k.expiresAt || 0,
        expiryPreset: k.expiryPreset || "",
        expired: !!(k.expiresAt && Math.floor(Date.now() / 1000) >= k.expiresAt),
        lastUsedUnix,
        lastUsedAt: lastUsedUnix,
        modelUsage: k.modelUsage || {},
        live: Boolean(live),
      };
    }));
    return jsonResponse({ ok: true, success: true, apiKeys: list, keys: list }, 200, cors);
  }

  if ((path === "/api-keys" || path === "/keys") && method === "POST") {
    try {
      const body = await request.json();
      const keys = await getApiKeys(env, request);
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
      const keyVal = body.key ? String(body.key).trim() : `ksk_${hex}`;
      const id = `key-${keys.length + 1}-${hex.slice(0, 8)}`;
      // Expiry: 0/absent = never. epoch = fixed timestamp. presets: 8h, 1d, eom (end of month).
      const expiresAt = resolveExpiry(body.expiresAt, body.expiryPreset);
      let newKey = {
        id,
        name: body.name || `API Key ${keys.length + 1}`,
        key: keyVal,
        enabled: body.enabled !== false,
        tokenLimit: typeof body.tokenLimit === "number" ? body.tokenLimit : 0,
        creditLimit: typeof body.creditLimit === "number" ? body.creditLimit : 0,
        tokensUsed: typeof body.tokensUsed === "number" ? body.tokensUsed : 0,
        creditsUsed: typeof body.creditsUsed === "number" ? body.creditsUsed : 0,
        requestsCount: typeof body.requestsCount === "number" ? body.requestsCount : 0,
        requests: typeof body.requestsCount === "number" ? body.requestsCount : 0,
        credits: typeof body.creditsUsed === "number" ? body.creditsUsed : 0,
        tokens: typeof body.tokensUsed === "number" ? body.tokensUsed : 0,
        expiresAt,
        expiryPreset: body.expiryPreset || "",
        createdUnix: Math.floor(Date.now() / 1000),
        createdAt: Math.floor(Date.now() / 1000),
        lastUsedUnix: 0,
        lastUsedAt: 0,
        modelUsage: {},
      };
      const catalogMutation = await mutateApiKeyCatalog(
        env,
        request,
        "create",
        { entry: newKey },
        keys,
      );
      if (catalogMutation) {
        newKey = catalogMutation.entry;
      } else {
        keys.push(newKey);
        await setKV(env, "config:api_keys", keys, request);
      }
      await resetApiKeyQuota(env, id, Number(newKey.creditsUsed) || 0, true);
      // Contract (mirrors the Go admin API): `key` is the plaintext string,
      // `apiKey` is the full entry object. Do not swap them — the admin UI
      // reads `d.key` as a string to show/copy the new key.
      return jsonResponse({ success: true, ok: true, id, key: keyVal, apiKey: newKey }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  // Reset usage
  if ((path.startsWith("/api-keys/") || path.startsWith("/keys/")) && (path.endsWith("/reset-usage") || path.endsWith("/reset")) && method === "POST") {
    const rawId = path.startsWith("/api-keys/") ? path.slice("/api-keys/".length) : path.slice("/keys/".length);
    const id = decodeURIComponent(rawId.replace(/\/reset-usage$|\/reset$/, ""));
    const keys = await getApiKeys(env, request);
    const k = keys.find((item) => item.id === id || item.key === id);
    if (!k) return jsonResponse({ ok: false, success: false, error: "API Key not found" }, 404, cors);
    const catalogMutation = await mutateApiKeyCatalog(
      env,
      request,
      "reset-usage",
      { id: k.id },
      keys,
    );
    if (!catalogMutation) {
      k.credits = 0;
      k.creditsUsed = 0;
      k.tokens = 0;
      k.tokensUsed = 0;
      k.tokensIn = 0;
      k.tokensOut = 0;
      k.requests = 0;
      k.requestsCount = 0;
      k.modelUsage = {};
      await setKV(env, "config:api_keys", keys, request);
    }
    await resetApiKeyQuota(env, k.id, 0, true);
    await clearClusterOverlays(env, k.id);
    return jsonResponse({ ok: true, success: true }, 200, cors);
  }

  // Expire immediately. Authentication rejects keys whose expiresAt is in the past.
  if ((path.startsWith("/api-keys/") || path.startsWith("/keys/")) && (path.endsWith("/expire") || path.endsWith("/quota-exceeded")) && method === "POST") {
    const rawId = path.startsWith("/api-keys/") ? path.slice("/api-keys/".length) : path.slice("/keys/".length);
    const id = decodeURIComponent(rawId.replace(/\/expire$|\/quota-exceeded$/, ""));
    const keys = await getApiKeys(env, request);
    const k = keys.find((item) => item.id === id || item.key === id);
    if (!k) return jsonResponse({ ok: false, success: false, error: "API Key not found" }, 404, cors);
    const catalogMutation = await mutateApiKeyCatalog(
      env,
      request,
      "expire",
      { id: k.id },
      keys,
    );
    if (!catalogMutation) {
      k.expiresAt = Math.floor(Date.now() / 1000);
      k.expiryPreset = "manual";
      await setKV(env, "config:api_keys", keys, request);
    }
    return jsonResponse({ ok: true, success: true }, 200, cors);
  }

  if ((path.startsWith("/api-keys/") || path.startsWith("/keys/")) && (method === "PATCH" || method === "PUT")) {
    try {
      const rawId = path.startsWith("/api-keys/") ? path.slice("/api-keys/".length) : path.slice("/keys/".length);
      const id = decodeURIComponent(rawId);
      const body = await request.json();
      const keys = await getApiKeys(env, request);
      const k = keys.find((item) => item.id === id || item.key === id);
      if (!k) return jsonResponse({ ok: false, success: false, error: "API Key not found" }, 404, cors);

      const catalogMutation = await mutateApiKeyCatalog(
        env,
        request,
        "update",
        { id: k.id, patch: body },
        keys,
      );
      if (catalogMutation) {
        const updated = catalogMutation.entry;
        const sync = catalogMutation.details || {};
        if (sync.syncUsed != null || sync.editedTokens != null || sync.editedRequests != null) {
          const mirrored = {};
          if (sync.editedRequests != null) mirrored.requests = sync.editedRequests;
          if (sync.editedTokens != null) {
            mirrored.tokensIn = Number(updated.tokensIn) || 0;
            mirrored.tokensOut = Number(updated.tokensOut) || 0;
          }
          await resetApiKeyQuota(
            env,
            updated.id,
            sync.syncUsed != null ? sync.syncUsed : (Number(updated.creditsUsed) || 0),
            false,
            Object.keys(mirrored).length ? mirrored : null,
          );
        }
        return jsonResponse({ ok: true, success: true }, 200, cors);
      }

      if (typeof body.enabled === "boolean") k.enabled = body.enabled;
      if (typeof body.creditLimit === "number") k.creditLimit = body.creditLimit;
      // Collect every edited counter first and mirror them into the Durable
      // Object once at the end. /check reports max(KV, DO stats), so syncing
      // mid-way (or not at all) let the stale live mirror undo the edit.
      let syncUsed = null;
      if (typeof body.creditsUsed === "number") {
        k.creditsUsed = body.creditsUsed;
        k.credits = body.creditsUsed;
        syncUsed = body.creditsUsed;
      } else if (typeof body.credits === "number") {
        k.credits = body.credits;
        k.creditsUsed = body.credits;
        syncUsed = body.credits;
      }
      if (typeof body.tokenLimit === "number") k.tokenLimit = body.tokenLimit;
      const editedTokens = typeof body.tokensUsed === "number"
        ? body.tokensUsed
        : (typeof body.tokens === "number" ? body.tokens : null);
      if (editedTokens !== null) {
        k.tokensUsed = editedTokens;
        k.tokens = editedTokens;
        // tokensIn/tokensOut are the authoritative split and /check derives
        // tokensUsed as max(tokensUsed, in + out). Leaving the old split intact
        // would make the edited total spring straight back to the old value, so
        // rescale it to match the new total.
        const prevIn = Number(k.tokensIn) || 0;
        const prevOut = Number(k.tokensOut) || 0;
        const prevTotal = prevIn + prevOut;
        if (editedTokens <= 0) {
          k.tokensIn = 0;
          k.tokensOut = 0;
        } else if (prevTotal > 0) {
          k.tokensIn = Math.round(editedTokens * (prevIn / prevTotal));
          k.tokensOut = Math.max(0, editedTokens - k.tokensIn);
        } else {
          k.tokensIn = 0;
          k.tokensOut = editedTokens;
        }
      }
      const editedRequests = typeof body.requestsCount === "number"
        ? body.requestsCount
        : (typeof body.requests === "number" ? body.requests : null);
      if (editedRequests !== null) {
        k.requestsCount = editedRequests;
        k.requests = editedRequests;
      }
      if (body.name) k.name = body.name;
      if (body.expiryPreset !== undefined || body.expiresAt !== undefined) {
        if (body.expiryPreset === "never" || Number(body.expiresAt) === 0 && !body.expiryPreset) {
          k.expiresAt = 0;
          k.expiryPreset = "";
        } else {
          k.expiresAt = resolveExpiry(body.expiresAt, body.expiryPreset);
          k.expiryPreset = body.expiryPreset || "";
        }
      }
      await setKV(env, "config:api_keys", keys, request);
      if (syncUsed !== null || editedTokens !== null || editedRequests !== null) {
        const mirrored = {};
        if (editedRequests !== null) mirrored.requests = editedRequests;
        if (editedTokens !== null) {
          mirrored.tokensIn = Number(k.tokensIn) || 0;
          mirrored.tokensOut = Number(k.tokensOut) || 0;
        }
        await resetApiKeyQuota(
          env,
          k.id,
          syncUsed !== null ? syncUsed : (Number(k.creditsUsed) || 0),
          false,
          Object.keys(mirrored).length ? mirrored : null,
        );
      }
      return jsonResponse({ ok: true, success: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  if ((path.startsWith("/api-keys/") || path.startsWith("/keys/")) && method === "DELETE") {
    const rawId = path.startsWith("/api-keys/") ? path.slice("/api-keys/".length) : path.slice("/keys/".length);
    const id = decodeURIComponent(rawId);
    let keys = await getApiKeys(env, request);
    const removed = keys.find((item) => item.id === id || item.key === id);
    const catalogMutation = await mutateApiKeyCatalog(
      env,
      request,
      "delete",
      { id: removed ? removed.id : id },
      keys,
    );
    if (!catalogMutation) {
      keys = keys.filter((item) => item.id !== id && item.key !== id);
      await setKV(env, "config:api_keys", keys, request);
    }
    if (removed) await resetApiKeyQuota(env, removed.id, 0, true);
    return jsonResponse({ ok: true, success: true }, 200, cors);
  }

  // 7. Logs API
  if (path === "/logs" && method === "GET") {
    const logs = await getLogs(env, request);
    return jsonResponse({ ok: true, success: true, logs, data: logs }, 200, cors);
  }

  if (path === "/logs" && method === "DELETE") {
    await setKV(env, "config:logs", [], request);
    return jsonResponse({ ok: true, success: true }, 200, cors);
  }

  // 8. Models API
  if (path === "/models" && method === "GET") {
    const cached = await getKV(env, "config:models", null);
    const list = Array.isArray(cached) && cached.length > 0 ? cached : FALLBACK_MODELS.map((m) => ({ modelId: m, modelName: m }));
    return jsonResponse(list, 200, cors);
  }

  if (path === "/models/sync" && method === "POST") {
    const synced = await syncKiroModels(env, request);
    return jsonResponse(synced, 200, cors);
  }

  // 9. Realtime Events SSE: GET /events
  if (path === "/events" && method === "GET") {
    return handleEventsStream(request, env);
  }

  // 10. Login & Credential Import Flows (API Key, Credentials, IAM SSO, Builder ID, Microsoft SSO, Token)
  if ((path === "/auth/api-key" || path === "/auth/credentials" || path === "/accounts/credentials" || path === "/auth/import") && method === "POST") {
    try {
      const body = await request.json();
      const apiKey = String(body.kiroApiKey || body.apiKey || body.key || "").trim();
      const accessToken = String(body.accessToken || "").trim();
      const refreshToken = String(body.refreshToken || "").trim();
      const preferredRegion = String(body.region || DEFAULT_REGION).trim() || DEFAULT_REGION;
      const nickname = String(body.nickname || body.name || "").trim();
      const authMethodHint = String(body.authMethod || "").trim().toLowerCase();
      const isApiKey = Boolean(apiKey) || authMethodHint === "api_key" || authMethodHint === "apikey" ||
        (!refreshToken && accessToken.startsWith("ksk_"));

      if (!isApiKey) {
        if (!accessToken && !refreshToken) {
          return jsonResponse({ success: false, ok: false, error: "accessToken or refreshToken is required" }, 400, cors);
        }

        const accounts = await getAccounts(env, request);
        const suppliedId = String(body.id || "").trim();
        const existingIdx = accounts.findIndex((account) =>
          (refreshToken && account.refreshToken === refreshToken) ||
          (suppliedId && account.id === suppliedId));
        const id = existingIdx >= 0
          ? accounts[existingIdx].id
          : (suppliedId || `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`);
        const expiresRaw = Number(body.expiresAt || 0);
        const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0
          ? Math.floor(expiresRaw > 1e12 ? expiresRaw / 1000 : expiresRaw)
          : 0;
        const newAcc = {
          ...(existingIdx >= 0 ? accounts[existingIdx] : {}),
          id,
          email: String(body.email || nickname || (existingIdx >= 0 ? accounts[existingIdx].email : "") || id).trim(),
          userId: String(body.userId || "").trim(),
          nickname,
          authMethod: authMethodHint === "idc" ? "idc" : "social",
          provider: String(body.provider || "").trim(),
          region: preferredRegion,
          accessToken,
          refreshToken,
          clientId: String(body.clientId || "").trim(),
          clientSecret: String(body.clientSecret || "").trim(),
          profileArn: String(body.profileArn || "").trim(),
          expiresAt,
          enabled: body.enabled !== false,
          credits: Number(body.credits || 0) || 0,
          requests: Number(body.requests || 0) || 0,
          lastUsedUnix: Number(body.lastUsedUnix || 0) || 0,
          usageLimit: Number(body.usageLimit || 0) || 0,
          usageCurrent: Number(body.usageCurrent || 0) || 0,
          nextResetUnix: Number(body.nextResetUnix || 0) || 0,
          hasProfileArn: Boolean(body.profileArn),
          plan: String(body.plan || body.subscriptionTitle || body.subscriptionType || "").trim(),
        };

        if (existingIdx >= 0) accounts[existingIdx] = newAcc;
        else accounts.push(newAcc);
        await setKV(env, "config:accounts", accounts, request);

        return jsonResponse({
          success: true,
          ok: true,
          account: { id: newAcc.id, email: newAcc.email, region: newAcc.region, plan: newAcc.plan },
        }, 200, cors);
      }

      const credential = apiKey || accessToken;
      if (!credential) {
        return jsonResponse({ success: false, ok: false, error: "API Key is required" }, 400, cors);
      }

      const probeRes = await probeKiroApiKey(credential, preferredRegion);
      if (!probeRes.ok) {
        return jsonResponse({ success: false, ok: false, error: `Upstream validation failed: ${probeRes.error}` }, 400, cors);
      }

      const accounts = await getAccounts(env, request);
      const id = `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`;
      const newAcc = {
        id,
        email: nickname || probeRes.email || `kiro-key-${accounts.length + 1}`,
        userId: probeRes.userId || "",
        authMethod: "api_key",
        region: probeRes.region || DEFAULT_REGION,
        kiroApiKey: credential,
        accessToken: credential,
        enabled: true,
        credits: 0,
        requests: 0,
        lastUsedUnix: 0,
        usageLimit: probeRes.usageLimit || 0,
        usageCurrent: probeRes.usageCurrent || 0,
        nextResetUnix: probeRes.nextResetUnix || 0,
        hasProfileArn: false,
        plan: probeRes.plan || "KIRO PRO",
      };

      // If account already exists with same key, update it instead of creating duplicate
      const existingIdx = accounts.findIndex(a => (a.kiroApiKey && a.kiroApiKey === credential) || (a.accessToken && a.accessToken === credential));
      if (existingIdx >= 0) {
        accounts[existingIdx] = { ...accounts[existingIdx], ...newAcc, id: accounts[existingIdx].id };
      } else {
        accounts.push(newAcc);
      }

      await setKV(env, "config:accounts", accounts, request);

      const savedAccount = existingIdx >= 0 ? accounts[existingIdx] : newAcc;
      return jsonResponse({
        success: true,
        ok: true,
        account: { id: savedAccount.id, email: savedAccount.email, region: savedAccount.region, plan: savedAccount.plan },
        data: {
          success: true,
          account: { id: savedAccount.id, email: savedAccount.email, region: savedAccount.region, plan: savedAccount.plan },
        },
      }, 200, cors);
    } catch (e) {
      return jsonResponse({ success: false, ok: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/sso-token" && method === "POST") {
    try {
      const body = await request.json();
      const bearerToken = String(body.bearerToken || "").trim();
      const region = String(body.region || DEFAULT_REGION).trim();
      if (!bearerToken) return jsonResponse({ ok: false, error: "bearerToken required" }, 400, cors);

      const accounts = await getAccounts(env, request);
      const id = `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`;
      const newAcc = {
        id,
        email: `sso-user-${accounts.length + 1}`,
        authMethod: "social",
        region,
        accessToken: bearerToken,
        enabled: true,
        credits: 0,
        requests: 0,
        lastUsedUnix: 0,
        usageLimit: 0,
        usageCurrent: 0,
        nextResetUnix: 0,
        hasProfileArn: false,
        plan: "KIRO PRO",
      };
      accounts.push(newAcc);
      await setKV(env, "config:accounts", accounts, request);

      return jsonResponse({
        ok: true,
        data: {
          success: true,
          accounts: [{ id: newAcc.id, email: newAcc.email }],
          errors: [],
        },
      }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/builderid/start" && method === "POST") {
    try {
      const body = await request.json().catch(() => ({}));
      const region = body.region || DEFAULT_REGION;
      const res = await startBuilderIdLogin(region, env, request);
      return jsonResponse({ ok: true, data: res }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/builderid/poll" && method === "POST") {
    try {
      const body = await request.json();
      const res = await pollBuilderIdLogin(body.sessionId, env, request);
      return jsonResponse({ ok: true, data: res }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/iam-sso/start" && method === "POST") {
    try {
      const body = await request.json();
      const res = await startIamSsoLogin(body.startUrl, body.region || DEFAULT_REGION, env, request);
      return jsonResponse({ ok: true, success: true, ...res, data: res }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, success: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/iam-sso/poll" && method === "POST") {
    try {
      const body = await request.json();
      const res = await pollIamSsoLogin(body.sessionId, env, request);
      return jsonResponse({ ok: true, ...res, data: res }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  if (path === "/auth/iam-sso/complete" && method === "POST") {
    try {
      const body = await request.json();
      const res = await pollIamSsoLogin(body.sessionId, env, request);
      return jsonResponse({ ok: true, ...res, data: res }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 400, cors);
    }
  }

  return jsonResponse({ ok: false, error: "Not Found" }, 404, cors);
}

// ==================== SSE Realtime Stream ====================

function handleEventsStream(request, env) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));

      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(timer);
        }
      }, 20000);

      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
}

// ==================== Model Discovery & Probes ====================

async function syncKiroModels(env, request = null) {
  const accounts = await getAccounts(env, request);
  const active = accounts.filter((a) => a.enabled !== false && a.accessToken);
  if (active.length === 0) {
    return { ok: false, error: "No active accounts configured to sync models" };
  }

  for (const acc of active) {
    try {
      const region = acc.region || DEFAULT_REGION;
      const host = `management.${region}.kiro.dev`;
      const payload = { origin: "KIRO_CLI" };
      if (acc.profileArn) payload.profileArn = acc.profileArn;

      const resp = await fetch(`https://${host}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
          "Authorization": `Bearer ${acc.accessToken}`,
          ...(acc.authMethod === "api_key" ? { TokenType: "API_KEY" } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.models) && data.models.length > 0) {
          // Upstream reports base ids only, and it still lists generations we no
          // longer publish. Keep the published catalog authoritative: accept a
          // synced model only if it is in FALLBACK_MODELS, and always keep the
          // "-thinking" variants that upstream never reports.
          const upstreamById = new Map();
          for (const m of data.models) {
            const id = m.modelId || m.id;
            if (id) upstreamById.set(id, m);
          }
          const models = FALLBACK_MODELS
            .filter((id) => {
              const base = id.endsWith(THINKING_SUFFIX) ? id.slice(0, -THINKING_SUFFIX.length) : id;
              // "auto" and the thinking variants are gateway-side concepts.
              return id === "auto" || upstreamById.has(id) || upstreamById.has(base);
            })
            .map((id) => {
              const base = id.endsWith(THINKING_SUFFIX) ? id.slice(0, -THINKING_SUFFIX.length) : id;
              const upstream = upstreamById.get(id) || upstreamById.get(base) || null;
              const model = {
                modelId: id,
                modelName: upstream?.modelName || upstream?.name || id,
              };
              const tokenLimits = normalizeTokenLimits(upstream);
              if (tokenLimits) model.tokenLimits = tokenLimits;
              return model;
            });
          const synced = models.length > 0
            ? models
            : FALLBACK_MODELS.map((m) => ({ modelId: m, modelName: m }));
          await setKV(env, "config:models", synced, request);
          return { ok: true, models: synced };
        }
      }
    } catch {}
  }

  const defaults = FALLBACK_MODELS.map((m) => ({ modelId: m, modelName: m }));
  await setKV(env, "config:models", defaults, request);
  return { ok: true, models: defaults };
}

async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const resp = await fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

async function probeAccount(acc, modelId = "auto") {
  try {
    const region = acc.region || DEFAULT_REGION;
    const isApiKey = acc.authMethod === "api_key" || String(acc.accessToken || "").startsWith("ksk_");

    if (!isApiKey && !acc.profileArn && acc.accessToken) {
      acc.profileArn = await fetchKiroProfileArn(acc.accessToken);
      if (acc.profileArn) acc.hasProfileArn = true;
    }

    let url = "";
    let host = "";
    if (isApiKey) {
      host = `runtime.${region}.kiro.dev`;
      url = `https://${host}/`;
    } else {
      url = region === "us-east-1"
        ? "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse"
        : `https://q.${region}.amazonaws.com/generateAssistantResponse`;
      host = new URL(url).host;
    }

    const convState = {
      conversationId: crypto.randomUUID(),
      history: [],
      currentMessage: {
        userInputMessage: {
          content: "Reply with the single word: ok",
          origin: isApiKey ? "KIRO_CLI" : "AI_EDITOR",
          modelId: modelId || "auto",
          userInputMessageContext: {},
        },
      },
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
    };

    const top = { conversationState: convState };
    if (!isApiKey && acc.profileArn) {
      top.profileArn = acc.profileArn;
    }

    const headers = {
      "Content-Type": isApiKey ? "application/x-amz-json-1.0" : "application/json",
      "User-Agent": KIRO_USER_AGENT,
      "X-Amz-User-Agent": KIRO_AMZ_USER_AGENT,
      "x-amzn-codewhisperer-optout": isApiKey ? "false" : "true",
      "Amz-Sdk-Invocation-Id": crypto.randomUUID(),
      "Amz-Sdk-Request": "attempt=1; max=1",
      "Accept": "*/*",
      "Authorization": `Bearer ${acc.accessToken}`,
      "Host": host,
    };
    if (isApiKey) {
      headers["X-Amz-Target"] = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
      headers["TokenType"] = "API_KEY";
      headers["tokentype"] = "API_KEY";
    } else {
      headers["x-amzn-kiro-agent-mode"] = "vibe";
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(top),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }

    let textContent = "";
    await parseAwsEventStream(resp.body, {
      onAssistantChunk(txt) { textContent += txt; },
    });

    const reply = textContent.trim() || "ok";
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// refreshOidcAccountCredential renews an IdC / Builder ID credential against the
// SSO OIDC token endpoint.
//
// This path did not exist. The only refresh here was the Kiro desktop endpoint,
// which serves "social" credentials, and it was reachable only from the usage-limit
// probe when a profileArn was missing — never from the request path. An "idc"
// account therefore had no way to renew at all: AWS issues its access token with a
// one hour lifetime, so every hour the gateway started answering 403 "The bearer
// token included in the request is invalid" for every model until someone
// re-imported the credential by hand.
async function refreshOidcAccountCredential(acc) {
  const refreshToken = String(acc.refreshToken || "").trim();
  const clientId = String(acc.clientId || "").trim();
  const clientSecret = String(acc.clientSecret || "").trim();

  if (!refreshToken) {
    return { ok: false, error: "IdC credential has no refreshToken; sign in to Kiro again and export a new JSON file" };
  }
  if (!clientId || !clientSecret) {
    return { ok: false, error: "IdC refresh requires clientId and clientSecret; re-import the credential to capture them" };
  }

  const region = String(acc.region || DEFAULT_REGION).trim() || DEFAULT_REGION;

  try {
    const resp = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `IdC token refresh failed (HTTP ${resp.status}): ${text.slice(0, 200)}` };
    }

    const data = await resp.json();
    const accessToken = String(data.accessToken || "").trim();
    if (!accessToken) return { ok: false, error: "IdC token refresh returned no accessToken" };

    acc.accessToken = accessToken;
    // The endpoint may or may not rotate the refresh token, and omits profileArn
    // entirely, so neither is overwritten unless it actually came back.
    if (data.refreshToken) acc.refreshToken = String(data.refreshToken).trim();
    if (data.profileArn) acc.profileArn = String(data.profileArn).trim();
    const ttlSeconds = Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 3600;
    acc.expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    acc.tokenExpires = acc.expiresAt;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `IdC token refresh failed: ${e.message}` };
  }
}

// refreshAccountCredential routes a credential to the endpoint that can renew it.
async function refreshAccountCredential(acc) {
  if (isApiKeyCredential(acc)) {
    return { ok: false, error: "API Key credentials do not support token refresh" };
  }
  if (String(acc.authMethod || "").toLowerCase() === "social") {
    return refreshSocialAccountCredential(acc);
  }
  return refreshOidcAccountCredential(acc);
}

// persistAccountCredential writes a renewed token back to KV. Without this the
// renewal dies with the request: the next one renews again, and the expiry is never
// recorded, so the proactive check can never engage.
async function persistAccountCredential(env, acc) {
  try {
    const accounts = await getAccounts(env);
    const idx = accounts.findIndex((a) => a.id === acc.id);
    if (idx < 0) return;
    accounts[idx] = {
      ...accounts[idx],
      accessToken: acc.accessToken,
      refreshToken: acc.refreshToken,
      profileArn: acc.profileArn,
      expiresAt: acc.expiresAt,
      tokenExpires: acc.tokenExpires,
    };
    await setKV(env, "config:accounts", accounts);
  } catch (_) {
    // A failed write costs an extra refresh on the next request, which is
    // recoverable. Failing the user's request over it is not.
  }
}

// renewAccountToken renews a credential and persists the result.
//
// Concurrent requests all hit the same expiry at the same moment, so the stored
// credential is re-read first: whichever request renewed already published its
// token, and the rest can adopt it instead of each minting another. This narrows
// the herd rather than eliminating it — Workers are distributed and KV reads lag,
// so a true single-flight guarantee would need a Durable Object. It is tolerable
// here because the endpoint returns the same refresh token rather than rotating it,
// so a duplicate renewal is wasteful but not destructive.
async function renewAccountToken(env, acc) {
  const usedToken = String(acc.accessToken || "");

  const stored = await getAccounts(env);
  const fresh = stored.find((a) => a.id === acc.id);
  if (fresh && String(fresh.accessToken || "") && String(fresh.accessToken) !== usedToken) {
    acc.accessToken = fresh.accessToken;
    if (fresh.refreshToken) acc.refreshToken = fresh.refreshToken;
    if (fresh.profileArn) acc.profileArn = fresh.profileArn;
    acc.expiresAt = fresh.expiresAt;
    acc.tokenExpires = fresh.tokenExpires;
    return { ok: true, reused: true };
  }

  const refreshed = await refreshAccountCredential(acc);
  if (!refreshed.ok) return refreshed;

  await persistAccountCredential(env, acc);
  return { ok: true };
}

// ensureFreshAccountToken renews before dispatch when the token is inside the
// expiry skew. Returns ok for credentials with no known expiry; those are covered
// reactively by callKiroWithAuth.
async function ensureFreshAccountToken(env, acc) {
  if (isApiKeyCredential(acc)) return { ok: true };

  const expiresAt = Number(acc.expiresAt || acc.tokenExpires || 0);
  if (!expiresAt) return { ok: true };
  if (Math.floor(Date.now() / 1000) < expiresAt - TOKEN_REFRESH_SKEW_SECONDS) return { ok: true };

  return renewAccountToken(env, acc);
}

async function refreshSocialAccountCredential(acc) {
  const refreshToken = String(acc.refreshToken || "").trim();
  if (!refreshToken) {
    return { ok: false, error: "OAuth credential has no refreshToken; sign in to Kiro again and export a new JSON file" };
  }

  try {
    const resp = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `OAuth token refresh failed (HTTP ${resp.status}): ${text.slice(0, 200)}` };
    }

    const data = await resp.json();
    const accessToken = String(data.accessToken || "").trim();
    if (!accessToken) return { ok: false, error: "OAuth token refresh returned no accessToken" };
    acc.accessToken = accessToken;
    if (data.refreshToken) acc.refreshToken = String(data.refreshToken).trim();
    if (data.profileArn) acc.profileArn = String(data.profileArn).trim();
    if (Number(data.expiresIn) > 0) {
      acc.expiresAt = Math.floor(Date.now() / 1000) + Number(data.expiresIn);
      // Mirrored because callers and the admin view read either field.
      acc.tokenExpires = acc.expiresAt;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `OAuth token refresh failed: ${e.message}` };
  }
}

async function fetchAccountUsageLimits(acc) {
  const isApiKey = acc.authMethod === "api_key" || String(acc.accessToken || "").startsWith("ksk_");
  const region = acc.region || DEFAULT_REGION;

  if (isApiKey) {
    return probeKiroApiKey(acc.accessToken, region);
  }

  if (!String(acc.profileArn || "").trim()) {
    if (String(acc.authMethod || "").toLowerCase() === "social") {
      const refreshed = await refreshSocialAccountCredential(acc);
      if (!refreshed.ok) return refreshed;
    }
    if (!String(acc.profileArn || "").trim()) {
      return { ok: false, error: "OAuth account is missing profileArn; sign in to Kiro again and export a fresh JSON file" };
    }
  }

  try {
    const host = `management.${region}.kiro.dev`;
    const resp = await fetch(`https://${host}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
        "Authorization": `Bearer ${acc.accessToken}`,
      },
      body: JSON.stringify({ origin: "KIRO_CLI", profileArn: acc.profileArn }),
    });

    if (!resp.ok) {
      const errTxt = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${errTxt.slice(0, 200)}` };
    }

    const data = await resp.json();
    let usageCurrent = 0;
    let usageLimit = 0;
    if (Array.isArray(data.usageBreakdownList)) {
      const breakdown = data.usageBreakdownList.find((b) => b.resourceType === "AGENTIC_REQUEST") || data.usageBreakdownList[0];
      if (breakdown) {
        usageCurrent = breakdown.currentUsage || 0;
        usageLimit = breakdown.usageLimit || 0;
      }
    }
    const nextResetUnix = Number(data.nextDateReset || 0);
    const plan = data.subscriptionInfo ? (data.subscriptionInfo.subscriptionTitle || data.subscriptionInfo.type || "") : "";
    const email = data.userInfo ? data.userInfo.email : "";

    return {
      ok: true,
      usageCurrent,
      usageLimit,
      nextResetUnix,
      plan,
      email,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function probeKiroApiKey(apiKey, preferredRegion = "auto") {
  const candidateRegions = ["us-east-1", "eu-central-1"];
  const cleanPref = String(preferredRegion || "").trim().toLowerCase();
  if (cleanPref && cleanPref !== "auto") {
    if (candidateRegions.includes(cleanPref)) {
      const idx = candidateRegions.indexOf(cleanPref);
      if (idx > 0) {
        candidateRegions.splice(idx, 1);
        candidateRegions.unshift(cleanPref);
      }
    } else {
      candidateRegions.unshift(cleanPref);
    }
  }

  let lastError = "Validation failed";
  for (const region of candidateRegions) {
    try {
      const url = `https://management.${region}.kiro.dev/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`;
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "TokenType": "API_KEY",
          "tokentype": "API_KEY",
          "User-Agent": "aws-sdk-js/1.0.34 ua/2.1 os/other lang/js md/nodejs#20.0.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-0.1.0",
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        let usageCurrent = 0;
        let usageLimit = 0;
        if (Array.isArray(data.usageBreakdownList)) {
          const breakdown = data.usageBreakdownList.find((b) => b.resourceType === "AGENTIC_REQUEST") || data.usageBreakdownList[0];
          if (breakdown) {
            usageCurrent = breakdown.currentUsage || 0;
            usageLimit = breakdown.usageLimit || 0;
          }
        }
        const nextResetUnix = Number(data.nextDateReset || 0);
        const plan = data.subscriptionInfo ? (data.subscriptionInfo.subscriptionTitle || data.subscriptionInfo.type || "KIRO PRO") : "KIRO PRO";
        const email = data.userInfo && data.userInfo.email ? data.userInfo.email : "";
        const userId = data.userInfo && data.userInfo.userId ? data.userInfo.userId : "";

        return {
          ok: true,
          region,
          email,
          userId,
          usageCurrent,
          usageLimit,
          nextResetUnix,
          plan,
        };
      }
      lastError = `HTTP ${resp.status} in ${region}`;
    } catch (e) {
      lastError = e.message;
    }
  }

  return { ok: false, error: lastError };
}

// ==================== Login Auth Flows (BuilderID, IAM SSO) ====================

async function startBuilderIdLogin(region = DEFAULT_REGION, env) {
  const oidcBase = `https://oidc.${region}.amazonaws.com`;
  const startUrl = "https://view.awsapps.com/start";
  const scopes = [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
    "codewhisperer:transformations",
    "codewhisperer:taskassist",
  ];

  // 1. Register client
  const regResp = await fetch(`${oidcBase}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "Kiro",
      clientType: "public",
      scopes,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      issuerUrl: startUrl,
    }),
  });
  if (!regResp.ok) {
    throw new Error(`Register client failed: ${regResp.status} ${await regResp.text()}`);
  }
  const regData = await regResp.json();

  // 2. Device authorization
  const authResp = await fetch(`${oidcBase}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: regData.clientId,
      clientSecret: regData.clientSecret,
      startUrl,
    }),
  });
  if (!authResp.ok) {
    throw new Error(`Device auth failed: ${authResp.status} ${await authResp.text()}`);
  }
  const authData = await authResp.json();

  const sessionId = crypto.randomUUID();
  const session = {
    clientId: regData.clientId,
    clientSecret: regData.clientSecret,
    deviceCode: authData.deviceCode,
    userCode: authData.userCode,
    verificationUri: authData.verificationUriComplete || authData.verificationUri,
    interval: authData.interval || 5,
    expiresAt: Date.now() + (authData.expiresIn || 600) * 1000,
    region,
  };

  const loginSessions = await getKV(env, "auth:builderid_sessions", {});
  loginSessions[sessionId] = session;
  await setKV(env, "auth:builderid_sessions", loginSessions);

  return {
    sessionId,
    userCode: authData.userCode,
    verificationUri: authData.verificationUriComplete || authData.verificationUri,
    interval: authData.interval || 5,
    expiresIn: authData.expiresIn || 600,
  };
}

async function pollBuilderIdLogin(sessionId, env, request = null) {
  const loginSessions = await getKV(env, "auth:builderid_sessions", {});
  const session = loginSessions[sessionId];
  if (!session) throw new Error("Invalid or expired session");

  const oidcBase = `https://oidc.${session.region}.amazonaws.com`;
  const resp = await fetch(`${oidcBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: session.deviceCode,
    }),
  });

  if (resp.status === 400) {
    const err = await resp.json().catch(() => ({ error: "authorization_pending" }));
    if (err.error === "authorization_pending") {
      return { success: false, completed: false, status: "authorization_pending", interval: session.interval };
    }
    if (err.error === "slow_down") {
      return { success: false, completed: false, status: "slow_down", interval: session.interval + 5 };
    }
    throw new Error(err.error_description || err.error || "Login failed");
  }

  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status}`);
  }

  const tokenData = await resp.json();
  const accounts = await getAccounts(env, request);
  const id = `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `builderid-${id.slice(4, 10)}`;

  const newAcc = {
    id,
    email,
    authMethod: "builderid",
    region: session.region,
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken || "",
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    expiresAt: Math.floor(Date.now() / 1000) + (tokenData.expiresIn || 3600),
    enabled: true,
    credits: 0,
    requests: 0,
    lastUsedUnix: 0,
    usageLimit: 0,
    usageCurrent: 0,
    nextResetUnix: 0,
    hasProfileArn: false,
    plan: "AWS Builder ID",
  };

  accounts.push(newAcc);
  await setKV(env, "config:accounts", accounts, request);
  delete loginSessions[sessionId];
  await setKV(env, "auth:builderid_sessions", loginSessions);

  return {
    success: true,
    completed: true,
    account: { id: newAcc.id, email: newAcc.email },
  };
}

async function startIamSsoLogin(startUrl, region = DEFAULT_REGION, env, request = null) {
  // Sanitize startUrl: extract valid URL if user pasted a multiline block, strip trailing slash
  const urlMatch = String(startUrl || "").match(/https?:\/\/[^\s"']+/);
  const cleanStartUrl = (urlMatch ? urlMatch[0] : String(startUrl || "")).trim().replace(/\/+$/, "");
  if (!cleanStartUrl) throw new Error("Invalid start URL");

  const oidcBase = `https://oidc.${region}.amazonaws.com`;
  const scopes = [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
    "codewhisperer:transformations",
    "codewhisperer:taskassist",
  ];

  // 1. Register device client
  const regResp = await fetch(`${oidcBase}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "Kiro",
      clientType: "public",
      scopes,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      issuerUrl: cleanStartUrl,
    }),
  });
  if (!regResp.ok) {
    throw new Error(`Register IAM client failed: ${regResp.status} ${await regResp.text()}`);
  }
  const regData = await regResp.json();

  // 2. Device authorization
  const authResp = await fetch(`${oidcBase}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: regData.clientId,
      clientSecret: regData.clientSecret,
      startUrl: cleanStartUrl,
    }),
  });
  if (!authResp.ok) {
    throw new Error(`Device auth failed: ${authResp.status} ${await authResp.text()}`);
  }
  const authData = await authResp.json();

  const sessionId = crypto.randomUUID();
  const verificationUri = authData.verificationUriComplete || authData.verificationUri;
  const session = {
    clientId: regData.clientId,
    clientSecret: regData.clientSecret,
    deviceCode: authData.deviceCode,
    userCode: authData.userCode,
    verificationUri,
    interval: authData.interval || 3,
    expiresAt: Date.now() + (authData.expiresIn || 600) * 1000,
    region,
    startUrl: cleanStartUrl,
  };

  const sessions = await getKV(env, "auth:iam_sessions", {});
  sessions[sessionId] = session;
  await setKV(env, "auth:iam_sessions", sessions);

  return {
    sessionId,
    userCode: authData.userCode,
    verificationUri,
    authorizeUrl: verificationUri,
    interval: authData.interval || 3,
    expiresIn: authData.expiresIn || 600,
  };
}

async function pollIamSsoLogin(sessionId, env, request = null) {
  const sessions = await getKV(env, "auth:iam_sessions", {});
  const session = sessions[sessionId];
  if (!session) throw new Error("Invalid or expired session");

  const oidcBase = `https://oidc.${session.region}.amazonaws.com`;
  const resp = await fetch(`${oidcBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: session.deviceCode,
    }),
  });

  if (resp.status === 400) {
    const err = await resp.json().catch(() => ({ error: "authorization_pending" }));
    if (err.error === "authorization_pending") {
      return { success: false, completed: false, status: "authorization_pending", interval: session.interval || 3 };
    }
    if (err.error === "slow_down") {
      return { success: false, completed: false, status: "slow_down", interval: (session.interval || 3) + 5 };
    }
    throw new Error(err.error_description || err.error || "Login failed");
  }

  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status}`);
  }

  const tokenData = await resp.json();
  const accounts = await getAccounts(env, request);
  const id = `acc-${accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}`;
  let email = `idc-${id.slice(4, 10)}`;
  try {
    const parsedStart = new URL(session.startUrl);
    email = `${parsedStart.hostname.split(".")[0]}-${id.slice(4, 10)}`;
  } catch (_) {}

  const profileArn = await fetchKiroProfileArn(tokenData.accessToken);

  const newAcc = {
    id,
    email,
    authMethod: "idc",
    region: session.region,
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken || "",
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    startUrl: session.startUrl,
    profileArn: profileArn || null,
    expiresAt: Math.floor(Date.now() / 1000) + (tokenData.expiresIn || 3600),
    enabled: true,
    credits: 0,
    requests: 0,
    lastUsedUnix: 0,
    usageLimit: 0,
    usageCurrent: 0,
    nextResetUnix: 0,
    hasProfileArn: Boolean(profileArn),
    plan: "AWS IAM Identity Center",
  };

  accounts.push(newAcc);
  await setKV(env, "config:accounts", accounts, request);
  delete sessions[sessionId];
  await setKV(env, "auth:iam_sessions", sessions);

  return {
    success: true,
    completed: true,
    account: { id: newAcc.id, email: newAcc.email },
  };
}

function generateRandomString(len = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ==================== OpenAI Chat Completions & Translation ====================

function mapKiroModel(rawModel) {
  if (!rawModel) return "auto";
  let m = String(rawModel).trim();
  if (m.endsWith("-thinking")) m = m.slice(0, -"-thinking".length);

  // 1. Direct Kiro model IDs — pass through
  if (VALID_KIRO_MODELS.has(m)) return m;

  // 2. Direct alias mapping
  if (MODEL_ALIASES.has(m)) return MODEL_ALIASES.get(m);

  // 3. Fallbacks by prefix/substring
  const lm = m.toLowerCase();
  if (MODEL_ALIASES.has(lm)) return MODEL_ALIASES.get(lm);

  if (lm.includes("opus-5.5") || lm.includes("opus 5.5") || lm.includes("opus5.5") || lm.includes("opus-5-5")) return "claude-opus-5.5";
  if (lm.includes("opus-5") || lm.includes("opus 5") || lm.includes("opus5")) return "claude-opus-5";
  if (lm.includes("opus-4.8") || lm.includes("opus-4-8")) return "claude-opus-4.8";
  if (lm.includes("opus-4.7") || lm.includes("opus-4-7")) return "claude-opus-4.7";
  // Opus 4.6 / 4.5 are retired; fold them onto the oldest Opus still served.
  if (lm.includes("opus-4.6") || lm.includes("opus-4-6")) return "claude-opus-4.7";
  if (lm.includes("opus-4.5") || lm.includes("opus-4-5")) return "claude-opus-4.7";
  if (lm.includes("opus")) return "claude-opus-5";

  // Every retired Sonnet / Haiku generation resolves to Sonnet 5.
  if (lm.includes("sonnet")) return "claude-sonnet-5";
  if (lm.includes("haiku")) return "claude-sonnet-5";

  if (lm.startsWith("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (lm.startsWith("gpt-5.6-terra")) return "gpt-5.6-terra";
  if (lm.startsWith("gpt-5.6-luna")) return "gpt-5.6-luna";
  if (lm.startsWith("gpt") || lm.startsWith("o1") || lm.startsWith("o3") || lm.startsWith("o4")) return "claude-sonnet-5";

  return "auto";
}

function getClientIp(request) {
  if (!request || !request.headers) return "—";
  return request.headers.get("cf-connecting-ip") ||
         request.headers.get("x-real-ip") ||
         request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
         "—";
}

async function handleOpenAIChat(request, env, ctx, cors, apiKeyId) {
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "Method Not Allowed", type: "invalid_request_error" } }, 405, cors);
  }

  const startTime = Date.now();
  const clientIp = getClientIp(request);
  const allKeys = await getApiKeys(env);
  const matchedKeyObj = allKeys.find((k) => k.id === apiKeyId || k.key === apiKeyId);
  const keyDisplayName = matchedKeyObj ? (matchedKeyObj.name ? `${matchedKeyObj.name} (${maskApiKey(matchedKeyObj.key)})` : maskApiKey(matchedKeyObj.key)) : (apiKeyId ? maskApiKey(apiKeyId) : "—");

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400, cors);
  }

  const rawModel = body.model || "auto";
  const { model, thinking } = normalizeModel(rawModel);
  const isStream = Boolean(body.stream);
  const quota = await reserveApiKeyQuota(env, matchedKeyObj, estimateCreditReservation(body));
  if (!quota.ok) return handleAuthFailure({ status: 402, error: "API Key credit limit exceeded" }, "openai", cors);
  const reservation = Number(quota.reservation) || 0;
  // Identifies this logical request for settlement idempotency. Created once
  // here so every retry/fallback attempt and the single final settle share it.
  const requestId = crypto.randomUUID();

  const accounts = await getAccounts(env);
  const candidates = pickCandidates(accounts, env);
  if (candidates.length === 0) {
    // See handleClaudeMessages: free, but it still has to be visible.
    await finishFailedRequest(env, ctx, {
      apiKeyId, reservation, requestId, owedCredits: 0, status: 503,
      message: "No active Kiro accounts available in pool",
      endpoint: "/v1/chat/completions", kind: "openai", model: rawModel,
      account: "", accountId: "", apiKey: keyDisplayName, ip: clientIp,
      startTime, inputTokens: estimateInputTokens(body),
    });
    return jsonResponse({ error: { message: "No active Kiro accounts available in pool", type: "service_unavailable" } }, 503, cors);
  }

  let lastError = null;
  // Set only for an INVALID_MODEL_ID throttle, so the exhaustion path can answer
  // with the normalized 429 + Retry-After instead of upstream's misleading 400.
  let lastFailure = null;
  // Credits upstream already metered on attempts that then failed. Owed even
  // though no response reached the client.
  let owedCredits = 0;
  let lastAccount = null;
  for (const account of candidates) {
    lastAccount = account;
    try {
      const payload = buildOpenAIKiroPayload(body, model, thinking);
      const requestedKiroModel = mapKiroModel(model);
      let routing = await callKiroWithAccountResilience(env, account, payload, requestedKiroModel);
      // Keep the model permit until the upstream event stream is fully consumed
      // (or cancelled/errors), not merely until response headers arrive.
      let upstreamResp = withReleaseOnBodyEnd(routing.response, routing.release);

      if (!upstreamResp.ok) {
        let errText = await upstreamResp.text();
        lastError = new Error(`HTTP ${upstreamResp.status}: ${errText.slice(0, 300)}`);

        if (isContentLengthExceeded(upstreamResp.status, errText) && !payload.__contentLengthRetried) {
          payload.__contentLengthRetried = true;
          compactPayloadOnContentLengthOverflow(payload);
          routing = await callKiroWithAccountResilience(env, account, payload, requestedKiroModel);
          upstreamResp = withReleaseOnBodyEnd(routing.response, routing.release);
          if (!upstreamResp.ok) {
            errText = await upstreamResp.text();
            lastError = new Error(`HTTP ${upstreamResp.status}: ${errText.slice(0, 300)}`);
          }
        }

        if (!upstreamResp.ok) {
          if (shouldTryNextAccount(upstreamResp.status, errText)) {
            // Carry the normalized throttle forward so the exhaustion path can
            // answer with 429 + Retry-After instead of upstream's misleading 400.
            if (isTransientModelRejection(upstreamResp.status, errText)) {
              lastFailure = normalizeUpstreamFailure(upstreamResp.status, errText);
            } else if (upstreamResp.status === 429 && routing.actualModel === null) {
              // callKiroResilient already exhausted every model candidate for this
              // credential. Preserve its normalized semantics while still letting
              // the outer loop try another account when the pool has one.
              lastFailure = normalizeUpstreamFailure(400, errText);
            } else if (upstreamResp.status === 503 && routing.actualModel === null) {
              lastFailure = {
                status: 503,
                message: "Kiro returned empty responses for every model candidate",
                headers: { "Retry-After": "3" },
              };
            }
            continue;
          }
          const failure = normalizeUpstreamFailure(upstreamResp.status, errText);
          await finishFailedRequest(env, ctx, {
            apiKeyId, reservation, requestId, owedCredits, status: failure.status,
            message: failure.message,
            endpoint: "/v1/chat/completions", kind: "openai", model: rawModel,
            account: account.email || account.id, accountId: account.id,
            apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
          });
          return addModelRoutingHeaders(
            jsonResponse({ error: { message: failure.message, type: openaiErrorType(failure.status) } }, failure.status, { ...cors, ...failure.headers }),
            rawModel,
            routing.actualModel,
            routing.fallbackApplied,
          );
        }
      }

      const estInTokens = estimateInputTokens(body);
      if (isStream) {
        const clientResponse = streamOpenAIResponse(upstreamResp, rawModel, cors, async (credits, tokens, isSuccess, inTokens = 0) => {
          // Upstream counts when it reported them. The local estimate is kept
          // but flagged, so the dashboard never presents a guess as a
          // measurement. `finalOut` used to fall back to a hardcoded 30, which
          // made every empty response look like it had generated 30 tokens.
          const tokensEstimated = !(inTokens > 0) || !(tokens > 0);
          const finalIn = inTokens > 0 ? inTokens : estInTokens;
          const finalOut = tokens > 0 ? tokens : 0;
          // owedCredits covers upstream work on earlier failed attempts.
          const finalCredits = totalChargeFor(credits > 0 ? credits : calculateCredits(finalIn, finalOut, routing.actualModel || rawModel), owedCredits);
          // Upstream meters what it actually generated, so a stream the client
          // aborted mid-way still owes for the tokens already produced. Settle
          // whatever was metered and only fully release a request that produced
          // nothing, otherwise cancelling streams is free usage.
          const settled = shouldSettleStream(isSuccess, finalCredits)
            ? await settleApiKeyQuota(env, apiKeyId, reservation, finalCredits, requestId)
            : (await releaseApiKeyQuota(env, apiKeyId, reservation), null);
          await recordRequestStats(env, null, isSuccess, finalIn, finalOut, finalCredits, {
            time: Math.floor(Date.now() / 1000),
            timeUnix: Math.floor(Date.now() / 1000),
            account: account.email || account.id,
            accountId: account.id,
            apiKeyId: apiKeyId || "",
            apiKey: keyDisplayName,
            ip: clientIp,
            endpoint: "/v1/chat/completions",
            model: rawModel,
            status: isSuccess ? "success" : "error",
            statusCode: isSuccess ? 200 : 500,
            credits: finalCredits,
            metered: finalCredits > 0,
            tokensEstimated,
            inputTokens: finalIn,
            outputTokens: finalOut,
            totalTokens: finalIn + finalOut,
            tokens: finalIn + finalOut,
            duration: Date.now() - startTime,
            latencyMs: Date.now() - startTime,
            durationMs: Date.now() - startTime,
            kind: "openai",
          }, apiKeyId, account.id, rawModel, settled?.used, requestId);
        }, ctx);
        return addModelRoutingHeaders(clientResponse, rawModel, routing.actualModel, routing.fallbackApplied);
      }

      const nonStreamRes = await nonStreamOpenAIResponse(upstreamResp, rawModel, cors);
      const tokensEstimated = !(nonStreamRes.inputTokens > 0);
      const finalIn = nonStreamRes.inputTokens > 0 ? nonStreamRes.inputTokens : estInTokens;
      const finalOut = nonStreamRes.outputTokens > 0 ? nonStreamRes.outputTokens : (nonStreamRes.tokens || 0);
      const ownCredits = nonStreamRes.credits > 0 ? nonStreamRes.credits : calculateCredits(finalIn, finalOut, routing.actualModel || rawModel);
      // owedCredits is what earlier attempts already cost us upstream. It has to
      // ride along on the settlement or a retried request underpays.
      const finalCredits = totalChargeFor(ownCredits, owedCredits);
      const settled = await settleApiKeyQuota(env, apiKeyId, reservation, finalCredits, requestId);
      recordRequestStats(env, ctx, true, finalIn, finalOut, finalCredits, {
        time: Math.floor(Date.now() / 1000),
        timeUnix: Math.floor(Date.now() / 1000),
        account: account.email || account.id,
        accountId: account.id,
        apiKeyId: apiKeyId || "",
        apiKey: keyDisplayName,
        ip: clientIp,
        endpoint: "/v1/chat/completions",
        model: rawModel,
        status: "success",
        statusCode: 200,
        credits: finalCredits,
        metered: finalCredits > 0,
        tokensEstimated,
        inputTokens: finalIn,
        outputTokens: finalOut,
        totalTokens: finalIn + finalOut,
        tokens: finalIn + finalOut,
        duration: Date.now() - startTime,
        latencyMs: Date.now() - startTime,
        durationMs: Date.now() - startTime,
        kind: "openai",
      }, apiKeyId, account.id, rawModel, settled?.used, requestId);

      return addModelRoutingHeaders(nonStreamRes.response, rawModel, routing.actualModel, routing.fallbackApplied);
    } catch (err) {
      lastError = err;
      // Whatever upstream metered before it failed is already owed.
      owedCredits += partialCreditsOf(err);
      // See handleClaudeMessages: a self-inflicted rejection is not worth
      // retrying across the pool, and 502 invites another client retry.
      if (err instanceof KiroUpstreamException && !err.retryable) {
        const status = err.status;
        await finishFailedRequest(env, ctx, {
          apiKeyId, reservation, requestId, owedCredits, status,
          message: upstreamErrorMessage(err),
          endpoint: "/v1/chat/completions", kind: "openai", model: rawModel,
          account: account.email || account.id, accountId: account.id,
          apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
        });
        return jsonResponse({ error: { message: upstreamErrorMessage(err), type: openaiErrorType(status) } }, status, cors);
      }
    }
  }

  const failStatus = lastFailure ? lastFailure.status : (lastError ? upstreamErrorStatus(lastError) : 502);
  const failMessage = lastFailure ? lastFailure.message : (lastError ? upstreamErrorMessage(lastError) : "All accounts failed");
  const failHeaders = lastFailure ? lastFailure.headers : {};
  await finishFailedRequest(env, ctx, {
    apiKeyId, reservation, requestId, owedCredits, status: failStatus, message: failMessage,
    endpoint: "/v1/chat/completions", kind: "openai", model: rawModel,
    account: lastAccount ? (lastAccount.email || lastAccount.id) : "",
    accountId: lastAccount ? lastAccount.id : "",
    apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
  });
  return jsonResponse({ error: { message: failMessage, type: openaiErrorType(failStatus) } }, failStatus, { ...cors, ...failHeaders });
}

// Maximum characters in a single Kiro text block / content string (~350k chars / ~90k tokens).
// Kiro's validator enforces a per-content block length threshold on individual strings
// (throwing CONTENT_LENGTH_EXCEEDS_THRESHOLD if a single content block exceeds ~1MB).
// However, Kiro fully supports 1M context across multiple conversation turns and blocks.
// Chunking large single blocks preserves 100% of the input text with zero content loss.
const MAX_KIRO_CONTENT_BLOCK_LEN = 350_000;

function splitContentIntoChunks(str, chunkSize = MAX_KIRO_CONTENT_BLOCK_LEN) {
  if (str === null || str === undefined) return [""];
  const s = typeof str === "string" ? str : String(str);
  if (s.length <= chunkSize) return [s];
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    chunks.push(s.slice(i, i + chunkSize));
  }
  return chunks;
}

function pushChunkedUserMessage(history, uim, modelId) {
  if (typeof uim === "string") {
    uim = { content: uim, origin: "KIRO_CLI", modelId: modelId || DEFAULT_MODEL };
  }
  const content = uim?.content || "";
  if (content.length <= MAX_KIRO_CONTENT_BLOCK_LEN) {
    history.push({ userInputMessage: uim });
    return;
  }
  const chunks = splitContentIntoChunks(content, MAX_KIRO_CONTENT_BLOCK_LEN);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkUim = {
      content: chunks[i],
      origin: uim?.origin || "KIRO_CLI",
      modelId: modelId || uim?.modelId || DEFAULT_MODEL,
    };
    if (isLast && uim?.userInputMessageContext) {
      chunkUim.userInputMessageContext = uim.userInputMessageContext;
    }
    history.push({ userInputMessage: chunkUim });
    if (!isLast) {
      history.push({
        assistantResponseMessage: {
          content: `Acknowledged part ${i + 1}/${chunks.length}. Please continue.`,
        },
      });
    }
  }
}

function compactPayloadOnContentLengthOverflow(payload) {
  if (!payload || !payload.conversationState) return;
  const cs = payload.conversationState;
  const history = cs.history;
  if (!Array.isArray(history) || history.length === 0) {
    const cur = cs.currentMessage?.userInputMessage;
    if (cur && typeof cur.content === "string" && cur.content.length > 200_000) {
      const chunks = splitContentIntoChunks(cur.content, 200_000);
      cs.history = [];
      for (let i = 0; i < chunks.length - 1; i++) {
        cs.history.push({
          userInputMessage: { content: chunks[i], origin: "KIRO_CLI", modelId: cur.modelId || "auto" },
        });
        cs.history.push({
          assistantResponseMessage: { content: `Acknowledged part ${i + 1}/${chunks.length}. Please continue.` },
        });
      }
      cur.content = chunks[chunks.length - 1];
    }
    return;
  }

  // Preserve recent history while compacting older turns
  const keepTurns = Math.max(4, Math.floor(history.length / 2));
  let tail = history.slice(history.length - keepTurns);
  while (tail.length > 0 && tail[0].assistantResponseMessage) {
    tail.shift();
  }

  const modelId = cs.currentMessage?.userInputMessage?.modelId || "auto";
  const placeholder = {
    userInputMessage: {
      content: "[Earlier conversation history was compacted to fit upstream threshold.]",
      origin: "KIRO_CLI",
      modelId,
    },
  };

  cs.history = [placeholder, ...tail];
}

function collectToolResultIDs(toolResults) {
  const ids = new Set();
  if (!Array.isArray(toolResults)) return ids;
  for (const tr of toolResults) {
    if (tr && tr.toolUseId) ids.add(tr.toolUseId);
  }
  return ids;
}

function currentToolResultsMatchLastAssistant(history, currentToolResultIDs) {
  if (!currentToolResultIDs || currentToolResultIDs.size === 0) return false;
  if (!Array.isArray(history) || history.length === 0) return false;
  const last = history[history.length - 1];
  const arm = last && last.assistantResponseMessage;
  if (!arm || !Array.isArray(arm.toolUses) || arm.toolUses.length === 0) return false;
  for (const tu of arm.toolUses) {
    if (!currentToolResultIDs.has(tu.toolUseId)) return false;
  }
  return true;
}

function stripPollutedToolCallText(content) {
  if (typeof content !== "string" || !content.includes("[Called tool ")) return content;
  return content.replace(/\[Called tool [^\]]*\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function joinHistoryText(existing, narrated) {
  const ex = (existing || "").trim();
  const na = (narrated || "").trim();
  if (ex && na) return ex + "\n\n" + na;
  if (na) return na;
  return ex;
}

function narrateToolResults(toolResults, names) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return "";
  const parts = [];
  for (const tr of toolResults) {
    const texts = [];
    if (Array.isArray(tr.content)) {
      for (const c of tr.content) {
        if (c && typeof c.text === "string" && c.text.trim()) texts.push(c.text);
      }
    }
    const body = texts.join("\n").trim() || "(no output)";
    const name = (names && names.get && names.get(tr.toolUseId)) || "";
    if (name) {
      parts.push(`[${name}] ${body}`);
    } else {
      parts.push(body);
    }
  }
  if (parts.length === 0) return "";
  return "Tool results:\n\n" + parts.join("\n\n");
}

function sanitizeKiroHistory(history, currentToolResultIDs) {
  if (!Array.isArray(history) || history.length === 0) return history;

  const toolNames = new Map();
  for (const turn of history) {
    const arm = turn && turn.assistantResponseMessage;
    if (arm && Array.isArray(arm.toolUses)) {
      for (const tu of arm.toolUses) {
        if (tu && tu.toolUseId && tu.name) {
          toolNames.set(tu.toolUseId, tu.name);
        }
      }
    }
  }

  let activeIdx = -1;
  if (currentToolResultIDs && currentToolResultIDs.size > 0) {
    const last = history[history.length - 1];
    const arm = last && last.assistantResponseMessage;
    if (arm && Array.isArray(arm.toolUses) && arm.toolUses.length > 0) {
      let allCovered = true;
      for (const tu of arm.toolUses) {
        if (!currentToolResultIDs.has(tu.toolUseId)) {
          allCovered = false;
          break;
        }
      }
      if (allCovered) {
        activeIdx = history.length - 1;
      }
    }
  } else if (history.length > 0) {
    const last = history[history.length - 1];
    if (last && last.assistantResponseMessage && Array.isArray(last.assistantResponseMessage.toolUses) && last.assistantResponseMessage.toolUses.length > 0) {
      activeIdx = history.length - 1;
    }
  }

  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    const arm = turn && turn.assistantResponseMessage;
    if (arm) {
      if (arm.content) {
        arm.content = stripPollutedToolCallText(arm.content);
      }
      if (Array.isArray(arm.toolUses) && arm.toolUses.length > 0) {
        if (i !== activeIdx) {
          delete arm.toolUses;
        }
      }
    }

    const uim = turn && turn.userInputMessage;
    if (uim && uim.userInputMessageContext) {
      const ctx = uim.userInputMessageContext;
      if (Array.isArray(ctx.toolResults) && ctx.toolResults.length > 0) {
        const narrated = narrateToolResults(ctx.toolResults, toolNames);
        uim.content = joinHistoryText(uim.content, narrated);
        delete ctx.toolResults;
      }
      delete ctx.tools;
      if (Object.keys(ctx).length === 0) {
        delete uim.userInputMessageContext;
      }
    }

    if (uim && (!uim.content || !uim.content.trim())) {
      uim.content = ".";
    }
  }

  // Drop hollow assistant turns that have neither content nor toolUses
  const cleaned = [];
  for (const turn of history) {
    const arm = turn && turn.assistantResponseMessage;
    if (arm && (!arm.toolUses || arm.toolUses.length === 0)) {
      const c = (arm.content || "").trim();
      if (!c || c === ".") continue;
    }
    cleaned.push(turn);
  }

  // Trim leading assistant messages only if more than one turn exists
  if (cleaned.length > 1) {
    while (cleaned.length > 1 && cleaned[0].assistantResponseMessage) {
      cleaned.shift();
    }
  }

  return cleaned;
}

function buildOpenAIKiroPayload(input, model, thinking) {
  const modelId = mapKiroModel(input.model || model);
  const messages = input.messages || [];
  if (messages.length === 0) {
    throw new Error("messages required");
  }

  let systemText = "";
  let pendingContent = "";
  let pendingToolResults = [];
  let systemInjected = false;
  const history = [];

  function flushUser(targetHistory = null) {
    let content = pendingContent;
    if (!systemInjected && systemText) {
      content = systemText + (content ? "\n\n" + content : "");
      systemInjected = true;
    }
    const ctx = {};
    if (pendingToolResults.length > 0) {
      ctx.toolResults = pendingToolResults;
    }
    const uim = {
      content,
      origin: "KIRO_CLI",
      modelId,
      userInputMessageContext: ctx,
    };
    pendingContent = "";
    pendingToolResults = [];
    if (targetHistory) {
      pushChunkedUserMessage(targetHistory, uim, modelId);
    }
    return uim;
  }

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const s = flattenContent(m.content);
      if (s) {
        systemText += (systemText ? "\n\n" : "") + s;
      }
    } else if (m.role === "user") {
      const uText = flattenContent(m.content);
      pendingContent += (pendingContent ? "\n" : "") + uText;
    } else if (m.role === "tool") {
      const rawText = flattenContent(m.content);
      const chunks = splitContentIntoChunks(rawText, MAX_KIRO_CONTENT_BLOCK_LEN);
      pendingToolResults.push({
        toolUseId: m.tool_call_id || m.toolCallId || "",
        status: "success",
        content: chunks.map((c) => ({ text: c })),
      });
    } else if (m.role === "assistant") {
      if (pendingContent || pendingToolResults.length > 0) {
        flushUser(history);
      }
      const arm = { content: flattenContent(m.content) };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        arm.toolUses = m.tool_calls.map((tc) => {
          let inputObj = {};
          if (tc.function && tc.function.arguments) {
            try {
              inputObj = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {}
          }
          return {
            toolUseId: tc.id || `toolu_${crypto.randomUUID().slice(0, 10)}`,
            // Verbatim, matching the Go reference (translator.go:1282). The
            // OpenAI tool specs go out through convertTools, which only
            // shortens names and never camelCases them. Sanitizing here turned
            // get_weather into getWeather in the replayed history while the spec
            // still said get_weather, so on the next turn Kiro saw a tool_use
            // referring to a tool it had never been given.
            name: shortenToolName(tc.function?.name || "unknown"),
            input: inputObj,
          };
        });
      }
      history.push({ assistantResponseMessage: arm });
    }
  }

  const curUIM = flushUser();
  if (curUIM && typeof curUIM.content === "string" && curUIM.content.length > MAX_KIRO_CONTENT_BLOCK_LEN) {
    const chunks = splitContentIntoChunks(curUIM.content, MAX_KIRO_CONTENT_BLOCK_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      history.push({
        userInputMessage: {
          content: chunks[i],
          origin: "KIRO_CLI",
          modelId,
        },
      });
      history.push({
        assistantResponseMessage: {
          content: `Acknowledged part ${i + 1}/${chunks.length}. Please continue.`,
        },
      });
    }
    curUIM.content = chunks[chunks.length - 1];
  }

  if (Array.isArray(input.tools) && input.tools.length > 0) {
    if (!curUIM.userInputMessageContext) curUIM.userInputMessageContext = {};
    curUIM.userInputMessageContext.tools = convertTools(input.tools);
  }

  const currentToolResultIDs = collectToolResultIDs(curUIM?.userInputMessageContext?.toolResults);
  const keepCurrentToolResults = currentToolResultsMatchLastAssistant(history, currentToolResultIDs);

  let finalHistory = keepCurrentToolResults
    ? sanitizeKiroHistory(history, currentToolResultIDs)
    : sanitizeKiroHistory(history, null);

  if (!keepCurrentToolResults && curUIM && curUIM.userInputMessageContext?.toolResults) {
    const narrated = narrateToolResults(curUIM.userInputMessageContext.toolResults, null);
    curUIM.content = joinHistoryText(curUIM.content, narrated);
    delete curUIM.userInputMessageContext.toolResults;
    if (Object.keys(curUIM.userInputMessageContext).length === 0) {
      delete curUIM.userInputMessageContext;
    }
  }

  return {
    conversationState: {
      conversationId: crypto.randomUUID(),
      history: finalHistory,
      currentMessage: { userInputMessage: curUIM },
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
    },
  };
}

// ==================== Anthropic Messages & Translation ====================

async function handleClaudeMessages(request, env, ctx, cors, apiKeyId) {
  if (request.method !== "POST") {
    return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "Method Not Allowed" } }, 405, cors);
  }

  const startTime = Date.now();
  const clientIp = getClientIp(request);
  const allKeys = await getApiKeys(env);
  const matchedKeyObj = allKeys.find((k) => k.id === apiKeyId || k.key === apiKeyId);
  const keyDisplayName = matchedKeyObj ? (matchedKeyObj.name ? `${matchedKeyObj.name} (${maskApiKey(matchedKeyObj.key)})` : maskApiKey(matchedKeyObj.key)) : (apiKeyId ? maskApiKey(apiKeyId) : "—");

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400, cors);
  }

  const rawModel = body.model || DEFAULT_MODEL;
  const { model, thinking } = normalizeModel(rawModel);
  const isStream = Boolean(body.stream);
  const quota = await reserveApiKeyQuota(env, matchedKeyObj, estimateCreditReservation(body));
  if (!quota.ok) return handleAuthFailure({ status: 402, error: "API Key credit limit exceeded" }, "claude", cors);
  const reservation = Number(quota.reservation) || 0;
  // Identifies this logical request for settlement idempotency. Created once
  // here so every retry/fallback attempt and the single final settle share it.
  const requestId = crypto.randomUUID();

  const accounts = await getAccounts(env);
  const candidates = pickCandidates(accounts, env);
  if (candidates.length === 0) {
    // Nothing was metered, so this costs nothing — but it is still a request the
    // client saw fail, and a failure that leaves no row is a failure nobody can
    // diagnose. An empty pool is usually every account being disabled at once,
    // which is invisible if the 503 is not recorded.
    await finishFailedRequest(env, ctx, {
      apiKeyId, reservation, requestId, owedCredits: 0, status: 503,
      message: "No active Kiro accounts available in pool",
      endpoint: "/v1/messages", kind: "anthropic", model: rawModel,
      account: "", accountId: "", apiKey: keyDisplayName, ip: clientIp,
      startTime, inputTokens: estimateInputTokens(body),
    });
    return jsonResponse({ type: "error", error: { type: "api_error", message: "No active Kiro accounts available in pool" } }, 503, cors);
  }

  let lastError = null;
  // Set only for an INVALID_MODEL_ID throttle, so the exhaustion path can answer
  // with the normalized 429 + Retry-After instead of upstream's misleading 400.
  let lastFailure = null;
  // Credits upstream already metered on attempts that then failed. Owed even
  // though no response reached the client.
  let owedCredits = 0;
  let lastAccount = null;
  for (const account of candidates) {
    lastAccount = account;
    try {
      const payload = buildClaudeKiroPayload(body, model, thinking);
      const requestedKiroModel = mapKiroModel(model);
      let routing = await callKiroWithAccountResilience(env, account, payload, requestedKiroModel);
      // The permit follows the upstream event stream through EOF/cancel/error.
      let upstreamResp = withReleaseOnBodyEnd(routing.response, routing.release);

      if (!upstreamResp.ok) {
        let errText = await upstreamResp.text();
        lastError = new Error(`HTTP ${upstreamResp.status}: ${errText.slice(0, 300)}`);

        if (isContentLengthExceeded(upstreamResp.status, errText) && !payload.__contentLengthRetried) {
          payload.__contentLengthRetried = true;
          compactPayloadOnContentLengthOverflow(payload);
          routing = await callKiroWithAccountResilience(env, account, payload, requestedKiroModel);
          upstreamResp = withReleaseOnBodyEnd(routing.response, routing.release);
          if (!upstreamResp.ok) {
            errText = await upstreamResp.text();
            lastError = new Error(`HTTP ${upstreamResp.status}: ${errText.slice(0, 300)}`);
          }
        }

        if (!upstreamResp.ok) {
          if (shouldTryNextAccount(upstreamResp.status, errText)) {
            // Keep the normalized throttle for account-pool exhaustion.
            if (isTransientModelRejection(upstreamResp.status, errText)) {
              lastFailure = normalizeUpstreamFailure(upstreamResp.status, errText);
            } else if (upstreamResp.status === 429 && routing.actualModel === null) {
              lastFailure = normalizeUpstreamFailure(400, errText);
            } else if (upstreamResp.status === 503 && routing.actualModel === null) {
              lastFailure = {
                status: 503,
                message: "Kiro returned empty responses for every model candidate",
                headers: { "Retry-After": "3" },
              };
            }
            continue;
          }
          const failure = normalizeUpstreamFailure(upstreamResp.status, errText);
          await finishFailedRequest(env, ctx, {
            apiKeyId, reservation, requestId, owedCredits, status: failure.status,
            message: failure.message,
            endpoint: "/v1/messages", kind: "anthropic", model: rawModel,
            account: account.email || account.id, accountId: account.id,
            apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
          });
          return addModelRoutingHeaders(
            jsonResponse({ type: "error", error: { type: anthropicErrorType(failure.status), message: failure.message } }, failure.status, { ...cors, ...failure.headers }),
            rawModel,
            routing.actualModel,
            routing.fallbackApplied,
          );
        }
      }

      const estInTokens = estimateInputTokens(body);
      if (isStream) {
        const clientResponse = streamClaudeResponse(upstreamResp, rawModel, cors, async (credits, tokens, isSuccess, inTokens = 0) => {
          // Upstream counts when it reported them. The local estimate is kept
          // but flagged, so the dashboard never presents a guess as a
          // measurement. `finalOut` used to fall back to a hardcoded 30, which
          // made every empty response look like it had generated 30 tokens.
          const tokensEstimated = !(inTokens > 0) || !(tokens > 0);
          const finalIn = inTokens > 0 ? inTokens : estInTokens;
          const finalOut = tokens > 0 ? tokens : 0;
          // owedCredits covers upstream work on earlier failed attempts.
          const finalCredits = totalChargeFor(credits > 0 ? credits : calculateCredits(finalIn, finalOut, routing.actualModel || rawModel), owedCredits);
          // Upstream meters what it actually generated, so a stream the client
          // aborted mid-way still owes for the tokens already produced. Settle
          // whatever was metered and only fully release a request that produced
          // nothing, otherwise cancelling streams is free usage.
          const settled = shouldSettleStream(isSuccess, finalCredits)
            ? await settleApiKeyQuota(env, apiKeyId, reservation, finalCredits, requestId)
            : (await releaseApiKeyQuota(env, apiKeyId, reservation), null);
          await recordRequestStats(env, null, isSuccess, finalIn, finalOut, finalCredits, {
            time: Math.floor(Date.now() / 1000),
            timeUnix: Math.floor(Date.now() / 1000),
            account: account.email || account.id,
            accountId: account.id,
            apiKeyId: apiKeyId || "",
            apiKey: keyDisplayName,
            ip: clientIp,
            endpoint: "/v1/messages",
            model: rawModel,
            status: isSuccess ? "success" : "error",
            statusCode: isSuccess ? 200 : 500,
            credits: finalCredits,
            metered: finalCredits > 0,
            tokensEstimated,
            inputTokens: finalIn,
            outputTokens: finalOut,
            totalTokens: finalIn + finalOut,
            tokens: finalIn + finalOut,
            duration: Date.now() - startTime,
            latencyMs: Date.now() - startTime,
            durationMs: Date.now() - startTime,
            kind: "anthropic",
          }, apiKeyId, account.id, rawModel, settled?.used, requestId);
        }, ctx, { tools: body.tools });
        return addModelRoutingHeaders(clientResponse, rawModel, routing.actualModel, routing.fallbackApplied);
      }

      const nonStreamRes = await nonStreamClaudeResponse(upstreamResp, rawModel, cors, { tools: body.tools });
      const tokensEstimated = !(nonStreamRes.inputTokens > 0);
      const finalIn = nonStreamRes.inputTokens > 0 ? nonStreamRes.inputTokens : estInTokens;
      const finalOut = nonStreamRes.outputTokens > 0 ? nonStreamRes.outputTokens : (nonStreamRes.tokens || 0);
      const ownCredits = nonStreamRes.credits > 0 ? nonStreamRes.credits : calculateCredits(finalIn, finalOut, routing.actualModel || rawModel);
      // owedCredits is what earlier attempts already cost us upstream. It has to
      // ride along on the settlement or a retried request underpays.
      const finalCredits = totalChargeFor(ownCredits, owedCredits);
      const settled = await settleApiKeyQuota(env, apiKeyId, reservation, finalCredits, requestId);
      recordRequestStats(env, ctx, true, finalIn, finalOut, finalCredits, {
        time: Math.floor(Date.now() / 1000),
        timeUnix: Math.floor(Date.now() / 1000),
        account: account.email || account.id,
        accountId: account.id,
        apiKeyId: apiKeyId || "",
        apiKey: keyDisplayName,
        ip: clientIp,
        endpoint: "/v1/messages",
        model: rawModel,
        status: "success",
        statusCode: 200,
        credits: finalCredits,
        metered: finalCredits > 0,
        tokensEstimated,
        inputTokens: finalIn,
        outputTokens: finalOut,
        totalTokens: finalIn + finalOut,
        tokens: finalIn + finalOut,
        duration: Date.now() - startTime,
        latencyMs: Date.now() - startTime,
        durationMs: Date.now() - startTime,
        kind: "anthropic",
      }, apiKeyId, account.id, rawModel, settled?.used, requestId);

      return addModelRoutingHeaders(nonStreamRes.response, rawModel, routing.actualModel, routing.fallbackApplied);
    } catch (err) {
      lastError = err;
      // Whatever upstream metered before it failed is already owed.
      owedCredits += partialCreditsOf(err);
      // A request upstream rejected on its own merits (oversized context, bad
      // auth) gets rejected identically by every other account. Return the real
      // status instead of burning the pool and answering 502, which clients
      // treat as transient and retry.
      if (err instanceof KiroUpstreamException && !err.retryable) {
        const status = err.status;
        await finishFailedRequest(env, ctx, {
          apiKeyId, reservation, requestId, owedCredits, status,
          message: upstreamErrorMessage(err),
          endpoint: "/v1/messages", kind: "anthropic", model: rawModel,
          account: account.email || account.id, accountId: account.id,
          apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
        });
        return jsonResponse({ type: "error", error: { type: anthropicErrorType(status), message: upstreamErrorMessage(err) } }, status, cors);
      }
    }
  }

  const failStatus = lastFailure ? lastFailure.status : (lastError ? upstreamErrorStatus(lastError) : 502);
  const failMessage = lastFailure ? lastFailure.message : (lastError ? upstreamErrorMessage(lastError) : "All accounts failed");
  const failHeaders = lastFailure ? lastFailure.headers : {};
  await finishFailedRequest(env, ctx, {
    apiKeyId, reservation, requestId, owedCredits, status: failStatus, message: failMessage,
    endpoint: "/v1/messages", kind: "anthropic", model: rawModel,
    account: lastAccount ? (lastAccount.email || lastAccount.id) : "",
    accountId: lastAccount ? lastAccount.id : "",
    apiKey: keyDisplayName, ip: clientIp, startTime, inputTokens: estimateInputTokens(body),
  });
  return jsonResponse({ type: "error", error: { type: anthropicErrorType(failStatus), message: failMessage } }, failStatus, { ...cors, ...failHeaders });
}

function parseAnthropicBlocks(content) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === "string") return { type: "text", text: b };
      if (!b || typeof b !== "object") return null;
      if (b.type === "text") return { type: "text", text: b.text || "" };
      if (b.type === "tool_use") {
        return {
          type: "tool_use",
          id: b.id || `toolu_${crypto.randomUUID().slice(0, 10)}`,
          name: b.name || "unknown",
          input: typeof b.input === "object" ? b.input : {},
        };
      }
      if (b.type === "tool_result") {
        let textContent = "";
        if (typeof b.content === "string") {
          textContent = b.content;
        } else if (Array.isArray(b.content)) {
          textContent = b.content.map((c) => (c.text ? c.text : JSON.stringify(c))).join("\n");
        } else if (b.content) {
          textContent = JSON.stringify(b.content);
        }
        return {
          type: "tool_result",
          toolUseId: b.tool_use_id || b.toolUseId || "",
          status: b.is_error ? "error" : "success",
          text: textContent,
        };
      }
      return null;
    }).filter(Boolean);
  }
  return [];
}

function buildClaudeUserInputMessage(blocks, modelId) {
  let text = "";
  const toolResults = [];

  for (const b of blocks) {
    if (b.type === "text") {
      text += (text ? "\n" : "") + b.text;
    } else if (b.type === "tool_result") {
      const rawText = b.text || "";
      const chunks = splitContentIntoChunks(rawText, MAX_KIRO_CONTENT_BLOCK_LEN);
      toolResults.push({
        toolUseId: b.toolUseId,
        status: b.status || "success",
        content: chunks.map((chunk) => ({ text: chunk })),
      });
    }
  }

  const ctx = {};
  if (toolResults.length > 0) {
    ctx.toolResults = toolResults;
  }

  return {
    content: text,
    origin: "KIRO_CLI",
    modelId,
    userInputMessageContext: ctx,
  };
}

function buildClaudeAssistantMessage(blocks) {
  let text = "";
  const toolUses = [];

  for (const b of blocks) {
    if (b.type === "text") {
      text += (text ? "\n" : "") + b.text;
    } else if (b.type === "tool_use") {
      toolUses.push({
        toolUseId: b.id,
        name: b.name,
        input: b.input || {},
      });
    }
  }

  const arm = { content: text };
  if (toolUses.length > 0) {
    arm.toolUses = toolUses;
  }
  return arm;
}

function buildClaudeKiroPayload(input, model, thinking) {
  const modelId = mapKiroModel(input.model || model);
  let systemText = "";
  if (typeof input.system === "string") {
    systemText = input.system;
  } else if (Array.isArray(input.system)) {
    systemText = input.system.map((s) => (s.text ? s.text : JSON.stringify(s))).join("\n\n");
  }

  const messages = input.messages || [];
  if (messages.length === 0) {
    throw new Error("messages required");
  }

  const history = [];

  // Dedicated system prompt priming turns in history
  if (systemText && systemText.trim()) {
    const systemChunks = splitContentIntoChunks(systemText.trim(), MAX_KIRO_CONTENT_BLOCK_LEN);
    for (const chunk of systemChunks) {
      history.push({
        userInputMessage: {
          content: chunk,
          origin: "KIRO_CLI",
          modelId,
        },
      });
      history.push({
        assistantResponseMessage: {
          content: "I will follow these instructions.",
        },
      });
    }
  }

  const histMsgs = [...messages];
  const lastMsg = histMsgs.pop();

  for (const m of histMsgs) {
    const blocks = parseAnthropicBlocks(m.content);
    if (m.role === "user") {
      const uim = buildClaudeUserInputMessage(blocks, modelId);
      pushChunkedUserMessage(history, uim, modelId);
    } else if (m.role === "assistant") {
      history.push({ assistantResponseMessage: buildClaudeAssistantMessage(blocks) });
    }
  }

  const curBlocks = parseAnthropicBlocks(lastMsg.content);
  let curUIM;

  if (lastMsg.role === "assistant") {
    history.push({ assistantResponseMessage: buildClaudeAssistantMessage(curBlocks) });
    curUIM = buildClaudeUserInputMessage([], modelId);
  } else {
    curUIM = buildClaudeUserInputMessage(curBlocks, modelId);
  }

  if (curUIM && typeof curUIM.content === "string" && curUIM.content.length > MAX_KIRO_CONTENT_BLOCK_LEN) {
    const chunks = splitContentIntoChunks(curUIM.content, MAX_KIRO_CONTENT_BLOCK_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      history.push({
        userInputMessage: {
          content: chunks[i],
          origin: "KIRO_CLI",
          modelId,
        },
      });
      history.push({
        assistantResponseMessage: {
          content: `Acknowledged part ${i + 1}/${chunks.length}. Please continue.`,
        },
      });
    }
    curUIM.content = chunks[chunks.length - 1];
  }

  if (Array.isArray(input.tools) && input.tools.length > 0) {
    if (!curUIM.userInputMessageContext) curUIM.userInputMessageContext = {};
    curUIM.userInputMessageContext.tools = convertClaudeTools(input.tools);
  }

  const currentToolResultIDs = collectToolResultIDs(curUIM?.userInputMessageContext?.toolResults);
  const keepCurrentToolResults = currentToolResultsMatchLastAssistant(history, currentToolResultIDs);

  let finalHistory = keepCurrentToolResults
    ? sanitizeKiroHistory(history, currentToolResultIDs)
    : sanitizeKiroHistory(history, null);

  if (!keepCurrentToolResults && curUIM && curUIM.userInputMessageContext?.toolResults) {
    const narrated = narrateToolResults(curUIM.userInputMessageContext.toolResults, null);
    curUIM.content = joinHistoryText(curUIM.content, narrated);
    delete curUIM.userInputMessageContext.toolResults;
    if (Object.keys(curUIM.userInputMessageContext).length === 0) {
      delete curUIM.userInputMessageContext;
    }
  }

  return {
    conversationState: {
      conversationId: crypto.randomUUID(),
      history: finalHistory,
      currentMessage: { userInputMessage: curUIM },
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
    },
  };
}

// ==================== Direct Kiro CLI Proxying ====================

async function handleDirectKiroProxy(request, env, ctx, cors, apiKeyId) {
  const startTime = Date.now();
  let bodyBytes;
  try {
    bodyBytes = await request.arrayBuffer();
  } catch {
    return jsonResponse({ error: "Failed to read request body" }, 400, cors);
  }

  const accounts = await getAccounts(env);
  const candidates = pickCandidates(accounts, env);
  if (candidates.length === 0) {
    return jsonResponse({ error: "No available accounts in pool" }, 503, cors);
  }

  let textBody = new TextDecoder().decode(bodyBytes);
  let parsedBody = {};
  try { parsedBody = JSON.parse(textBody); } catch (_) {}
  const directRequestedModel = parsedBody.model ||
    parsedBody?.conversationState?.currentMessage?.userInputMessage?.modelId || "auto";
  const directGateModel = mapKiroModel(directRequestedModel);
  const allKeys = await getApiKeys(env);
  const matchedKeyObj = allKeys.find((k) => k.id === apiKeyId || k.key === apiKeyId);
  const quota = await reserveApiKeyQuota(env, matchedKeyObj, estimateCreditReservation(parsedBody));
  if (!quota.ok) return handleAuthFailure({ status: 402, error: "API Key credit limit exceeded" }, "openai", cors);
  const reservation = Number(quota.reservation) || 0;
  // Identifies this logical request for settlement idempotency. Created once
  // here so every retry/fallback attempt and the single final settle share it.
  const requestId = crypto.randomUUID();
  let lastError = null;
  let lastGateFailure = false;

  for (const account of candidates) {
    let modelPermit = null;
    try {
      // Renew before the headers below capture the token. This path only gets the
      // proactive half of the treatment callKiroWithAuth applies: the request is
      // forwarded verbatim, so retrying it after a rejection would mean rebuilding
      // headers the client supplied. Once any request has recorded an expiry, the
      // proactive check covers this path too.
      await ensureFreshAccountToken(env, account);

      modelPermit = await acquireModelPermit(env, account, directGateModel);
      if (!modelPermit?.ok) {
        lastGateFailure = true;
        lastError = `Model gate admission timed out for ${directGateModel}`;
        continue;
      }
      lastGateFailure = false;

      let finalBody = textBody;
      const isApiKey = account.authMethod === "api_key" || String(account.accessToken || "").startsWith("ksk_");
      if (isApiKey) {
        finalBody = removeProfileArnFromJson(finalBody);
      } else if (account.profileArn) {
        finalBody = rewriteProfileArnInJson(finalBody, account.profileArn);
      }

      const region = account.region || DEFAULT_REGION;
      let url = "";
      let host = "";
      if (isApiKey) {
        host = `runtime.${region}.kiro.dev`;
        url = `https://${host}/`;
      } else {
        url = region === "us-east-1"
          ? "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse"
          : `https://q.${region}.amazonaws.com/generateAssistantResponse`;
        host = new URL(url).host;
      }

      const headers = new Headers();
      // Copy safe headers from client
      for (const [k, v] of request.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "authorization" || lk === "connection") continue;
        headers.set(k, v);
      }
      headers.set("Authorization", `Bearer ${account.accessToken}`);
      headers.set("Host", host);
      headers.set("User-Agent", KIRO_USER_AGENT);
      headers.set("X-Amz-User-Agent", KIRO_AMZ_USER_AGENT);
      if (isApiKey) {
        headers.set("Content-Type", "application/x-amz-json-1.0");
        headers.set("TokenType", "API_KEY");
        headers.set("tokentype", "API_KEY");
        headers.set("X-Amz-Target", "AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
        headers.set("x-amzn-codewhisperer-optout", "false");
      } else {
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        headers.set("x-amzn-kiro-agent-mode", "vibe");
        headers.set("x-amzn-codewhisperer-optout", "true");
      }

      // finalBody is a string, so the request is safe to replay through the
      // INVALID_MODEL_ID retry ramp. Preflight catches the same rejection when
      // Kiro hides it in the first exception frame of an HTTP-200 stream.
      let upstreamResp = await fetchWithModelRetry(async () => preflightKiroEventStream(await fetch(url, {
        method: "POST",
        headers,
        body: finalBody,
      })));

      if (!upstreamResp.ok) {
        const upstreamStatus = upstreamResp.status;
        const errText = await upstreamResp.text();
        const failure = normalizeUpstreamFailure(upstreamStatus, errText);
        lastError = `HTTP ${failure.status}: ${failure.message}`;
        await modelPermit.release();
        modelPermit = null;

        // Another credential may have capacity. Local gate pressure never marks
        // an upstream cooldown, and the raw protocol never rewrites the model.
        if (shouldTryNextAccount(upstreamStatus, errText) && account !== candidates[candidates.length - 1]) {
          continue;
        }
        const failureHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8" });
        for (const [key, value] of Object.entries(failure.headers || {})) failureHeaders.set(key, value);
        let responseBody = errText || failure.message;
        if (isContentLengthExceeded(upstreamStatus, errText)) {
          responseBody = JSON.stringify({ message: failure.message, reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" });
        } else if (failure.message !== errText && isTransientModelRejection(upstreamStatus, errText)) {
          responseBody = JSON.stringify({ message: failure.message, reason: "INVALID_MODEL_ID" });
        }
        upstreamResp = new Response(responseBody, {
          status: failure.status,
          headers: failureHeaders,
        });
      }

      if (!upstreamResp.ok) {
        await releaseApiKeyQuota(env, apiKeyId, reservation);
      } else if (reservation > 0) {
        // Native Kiro responses are binary AWS event streams. Tee the body so
        // metering is parsed for settlement while the client receives it verbatim.
        const [clientBody, meterBody] = upstreamResp.body.tee();
        const meterTask = (async () => {
          let credits = 0;
          let tokensIn = 0;
          let tokensOut = 0;
          let streamErr = null;
          await parseAwsEventStream(meterBody, {
            async onMetering(c) { credits += Number(c) || 0; },
            async onTokens(inp, out) {
              if (inp > tokensIn) tokensIn = inp;
              if (out > tokensOut) tokensOut = out;
            },
          }).catch((e) => { streamErr = e; });
          const finalCredits = credits > 0 ? credits : calculateCredits(tokensIn, tokensOut, parsedBody.model || "auto");
          const settled = await settleApiKeyQuota(env, apiKeyId, reservation, finalCredits, requestId);
          const finalDuration = Date.now() - startTime;
          // The client receives this stream verbatim, so it sees the upstream
          // exception frame itself. The log must not claim 200/success for it.
          const streamOk = !streamErr;
          // Awaited: this task is the unit handed to ctx.waitUntil, so leaving the
          // recording unawaited let the task resolve first and the runtime dropped
          // the pending write.
          await recordRequestStats(env, null, streamOk, tokensIn, tokensOut, finalCredits, {
            time: Math.floor(Date.now() / 1000),
            timeUnix: Math.floor(Date.now() / 1000),
            account: account.email || account.id,
            accountId: account.id,
            apiKeyId: apiKeyId || "",
            apiKey: matchedKeyObj ? (matchedKeyObj.name || maskApiKey(matchedKeyObj.key)) : apiKeyId,
            ip: getClientIp(request),
            endpoint: "/generateAssistantResponse",
            model: parsedBody.model || "auto",
            status: streamOk ? "success" : "error",
            statusCode: streamOk ? upstreamResp.status : upstreamErrorStatus(streamErr),
            error: streamOk ? "" : upstreamErrorMessage(streamErr),
            credits: finalCredits,
            metered: credits > 0,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            totalTokens: tokensIn + tokensOut,
            tokens: tokensIn + tokensOut,
            duration: finalDuration,
            latencyMs: finalDuration,
            durationMs: finalDuration,
            kind: "direct_cli",
          }, apiKeyId, account.id, parsedBody.model || "auto", settled?.used, requestId);
        })();
        if (ctx?.waitUntil) ctx.waitUntil(meterTask);
        // Without a ctx there is nothing to keep the task alive and we must not
        // await it here, or the client would wait for the whole upstream stream.
        // The hold's TTL in the quota DO is the backstop in that case.
        else meterTask.catch(() => {});
        upstreamResp = new Response(clientBody, { status: upstreamResp.status, headers: upstreamResp.headers });
      }

      // Stream response back to client verbatim
      const respHeaders = new Headers();
      for (const [k, v] of upstreamResp.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk === "connection" || lk === "transfer-encoding") continue;
        respHeaders.set(k, v);
      }
      // Add CORS
      for (const [k, v] of Object.entries(cors)) {
        respHeaders.set(k, v);
      }

      // For failed/unlimited native calls, retain a basic request log.
      if ((!upstreamResp.ok || reservation === 0) && ctx && ctx.waitUntil) {
        ctx.waitUntil((async () => {
          const finalDuration = Date.now() - startTime;
          await recordRequestStats(env, null, upstreamResp.ok, 0, 0, 0, {
            timeUnix: Math.floor(Date.now() / 1000),
            time: Math.floor(Date.now() / 1000),
            account: account.email || account.id,
            accountId: account.id,
            apiKeyId: apiKeyId || "",
            apiKey: matchedKeyObj?.key ? maskApiKey(matchedKeyObj.key) : (apiKeyId ? maskApiKey(apiKeyId) : ""),
            endpoint: "/generateAssistantResponse",
            model: parsedBody.model || "auto",
            status: upstreamResp.ok ? "success" : "error",
            statusCode: upstreamResp.status,
            credits: 0,
            metered: false,
            duration: finalDuration,
            latencyMs: finalDuration,
            durationMs: finalDuration,
            kind: "direct_cli",
          }, apiKeyId, account.id);
        })());
      }

      const clientResponse = new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
      return modelPermit
        ? withReleaseOnBodyEnd(clientResponse, modelPermit.release)
        : clientResponse;
    } catch (e) {
      if (modelPermit?.release) await modelPermit.release();
      lastError = e.message;
    }
  }

  await releaseApiKeyQuota(env, apiKeyId, reservation);
  if (lastGateFailure) {
    return jsonResponse(
      { error: lastError || "Model gate is busy" },
      429,
      { ...cors, "Retry-After": "3" },
    );
  }
  return jsonResponse({ error: lastError || "Failed to dispatch Kiro request" }, 502, cors);
}

function removeProfileArnFromJson(jsonStr) {
  return jsonStr.replace(/"profileArn"\s*:\s*"[^"]*",?/g, "").replace(/,\s*}/g, "}");
}

function rewriteProfileArnInJson(jsonStr, newArn) {
  if (jsonStr.includes('"profileArn"')) {
    return jsonStr.replace(/"profileArn"\s*:\s*"[^"]*"/g, `"profileArn":"${newArn}"`);
  }
  return jsonStr.replace(/\{/, `{"profileArn":"${newArn}",`);
}

// ==================== Kiro Upstream Invocation ====================

function normalizeModel(rawModel, thinkingSuffix = THINKING_SUFFIX) {
  if (!rawModel) return { model: DEFAULT_MODEL, thinking: false, publicModel: DEFAULT_MODEL, rawModel: DEFAULT_MODEL };
  let modelStr = String(rawModel).trim();
  let thinking = false;
  if (modelStr.toLowerCase().endsWith(thinkingSuffix.toLowerCase())) {
    modelStr = modelStr.slice(0, -thinkingSuffix.length);
    thinking = true;
  }
  const resolved = mapKiroModel(modelStr);
  return {
    rawModel,
    publicModel: thinking ? `${resolved}${thinkingSuffix}` : resolved,
    model: resolved,
    thinking,
  };
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && part.text) return part.text;
      if (typeof part === "object") {
        try { return JSON.stringify(part); } catch { return ""; }
      }
      return String(part);
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

function flattenClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item.type === "text") return item.text || "";
      if (item.type === "tool_result") {
        const resText = typeof item.content === "string" ? item.content : JSON.stringify(item.content || "");
        return `[Tool Result ${item.tool_use_id}]: ${resText}`;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

// Kiro rejects tool descriptions longer than this. Mirrors Go maxToolDescLen
// (proxy/translator.go). Over-long descriptions are truncated then suffixed
// with "..." so the model still sees intent without tripping the 400.
const MAX_TOOL_DESC_LEN = 10237;

// Deep-clones a JSON-schema value so the caller's object is never mutated.
// Mirrors Go cloneSchemaValue (proxy/translator.go).
function cloneSchemaValue(v) {
  if (Array.isArray(v)) return v.map(cloneSchemaValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = cloneSchemaValue(v[k]);
    return out;
  }
  return v;
}

// Recursively strips schema fields Kiro rejects with a 400: additionalProperties
// (at every level) and empty/null `required`. Mirrors Go cleanSchema
// (proxy/translator.go:974). Operates in place on an already-cloned object.
function cleanSchema(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return;
  delete m.additionalProperties;

  // Kiro rejects a present-but-empty `required` ("Improperly formed request"),
  // so drop it when null or empty; keep it only when it has entries.
  if ("required" in m) {
    const req = m.required;
    if (req == null || (Array.isArray(req) && req.length === 0)) {
      delete m.required;
    }
  }

  for (const k of Object.keys(m)) {
    const v = m[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && !Array.isArray(item)) cleanSchema(item);
      }
    } else if (v && typeof v === "object") {
      cleanSchema(v);
    }
  }
}

// Ensures the tool schema is an object type and cleaned of Kiro-hostile fields
// without mutating the caller's object. Mirrors Go ensureObjectSchema
// (proxy/translator.go:938): deep-clone, recursively cleanSchema, default a
// missing top-level `type` to "object". A previous top-level-only
// `delete copy.$schema` left additionalProperties/empty-required nested inside
// properties, which Kiro rejected with a 400.
function ensureObjectSchema(schema) {
  if (typeof schema === "string") {
    try { schema = JSON.parse(schema); } catch { return { type: "object" }; }
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" };
  }
  const cleaned = cloneSchemaValue(schema);
  delete cleaned.$schema;
  flattenRootSchemaCombinators(cleaned);
  cleanSchema(cleaned);
  if (!("type" in cleaned)) cleaned.type = "object";
  return cleaned;
}

function flattenRootSchemaCombinators(schema) {
  if (!schema || typeof schema !== "object") return;

  if (Array.isArray(schema.allOf)) {
    mergeCombinatorBranches(schema, schema.allOf, true);
    delete schema.allOf;
  }
  if (Array.isArray(schema.oneOf)) {
    mergeCombinatorBranches(schema, schema.oneOf, false);
    delete schema.oneOf;
  }
  if (Array.isArray(schema.anyOf)) {
    mergeCombinatorBranches(schema, schema.anyOf, false);
    delete schema.anyOf;
  }
}

function mergeCombinatorBranches(root, branches, isAllOf) {
  if (!root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    root.properties = {};
  }
  const branchRequiredLists = [];

  for (const branch of branches) {
    if (!branch || typeof branch !== "object") continue;

    for (const defKey of ["$defs", "definitions"]) {
      if (branch[defKey] && typeof branch[defKey] === "object") {
        if (!root[defKey] || typeof root[defKey] !== "object") root[defKey] = {};
        for (const [k, v] of Object.entries(branch[defKey])) {
          if (!(k in root[defKey])) root[defKey][k] = v;
        }
      }
    }

    if (branch.properties && typeof branch.properties === "object" && !Array.isArray(branch.properties)) {
      for (const [k, v] of Object.entries(branch.properties)) {
        if (!(k in root.properties)) {
          root.properties[k] = v;
        }
      }
    }

    if (Array.isArray(branch.required)) {
      const validReqs = branch.required.filter((r) => typeof r === "string" && r.trim() !== "");
      branchRequiredLists.push(validReqs);
    }
  }

  if (isAllOf) {
    const existing = new Set(Array.isArray(root.required) ? root.required : []);
    for (const bReqs of branchRequiredLists) {
      for (const r of bReqs) existing.add(r);
    }
    if (existing.size > 0) root.required = Array.from(existing);
  } else if (branchRequiredLists.length > 0) {
    const counts = new Map();
    for (const bReqs of branchRequiredLists) {
      const seen = new Set(bReqs);
      for (const r of seen) counts.set(r, (counts.get(r) || 0) + 1);
    }
    const common = [];
    for (const [r, cnt] of counts.entries()) {
      if (cnt === branchRequiredLists.length) common.push(r);
    }
    if (common.length > 0) {
      root.required = common;
    } else {
      delete root.required;
    }
  }
}

// Blank/whitespace description -> "Tool: <name>". Mirrors Go normalizeToolDesc
// (proxy/translator.go:1010); Kiro requires a non-empty description.
function normalizeToolDesc(desc, name) {
  if (typeof desc === "string" && desc.trim() !== "") return desc;
  return "Tool: " + name;
}

// Collapses over-long tool names. Mirrors Go shortenToolName
// (proxy/translator.go:1047): mcp__server__tool -> mcp__tool when that fits in
// 64 chars, otherwise a hard 64-char cut. The previous worker only did a
// lossy .slice(0,64), truncating mid-server-name.
function shortenToolName(name) {
  if (name.length <= 64) return name;
  if (name.startsWith("mcp__")) {
    const lastIdx = name.lastIndexOf("__");
    if (lastIdx > 5) {
      const shortened = "mcp__" + name.slice(lastIdx + 2);
      if (shortened.length <= 64) return shortened;
    }
  }
  return name.slice(0, 64);
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const result = [];
  for (const tool of tools) {
    if (tool && tool.type && tool.type !== "function") continue;
    const fn = tool.function || tool;
    const name = shortenToolName(String(fn.name || ""));
    // Kiro rejects tools with empty names; skip unusable specs (Go convertOpenAITools).
    if (name.trim() === "") continue;
    let desc = fn.description || "";
    if (desc.length > MAX_TOOL_DESC_LEN) desc = desc.slice(0, MAX_TOOL_DESC_LEN) + "...";
    result.push({
      toolSpecification: {
        name,
        description: normalizeToolDesc(desc, name),
        inputSchema: { json: ensureObjectSchema(fn.parameters || fn.input_schema || { type: "object" }) },
      },
    });
  }
  return result;
}

// Builds Kiro tool specs from Claude tools AND a sanitized->original name map so
// tool_use responses can be reported under the client's ORIGINAL name (Go
// convertClaudeTools + ToolNameMap, proxy/translator.go:862, kiro.go:272).
function convertClaudeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const result = [];
  for (const t of tools) {
    const original = String(t.name || "");
    // Skip blank names — Kiro rejects them, and there is nothing to sanitize.
    if (original.trim() === "") continue;
    let desc = t.description || "";
    if (desc.length > MAX_TOOL_DESC_LEN) desc = desc.slice(0, MAX_TOOL_DESC_LEN) + "...";
    const sanitized = shortenToolName(sanitizeToolName(original));
    result.push({
      toolSpecification: {
        name: sanitized,
        description: normalizeToolDesc(desc, original),
        inputSchema: { json: ensureObjectSchema(t.input_schema || t.inputSchema || { type: "object" }) },
      },
    });
  }
  return result;
}

// Builds a sanitized->original tool-name map for the Claude path so tool_use
// events echoed by upstream (which carry the sanitized name we sent) can be
// restored to the client's original name. Mirrors Go ToolNameMap
// (proxy/kiro.go:272 + the OnToolUse wrapper at 555-566).
function buildClaudeToolNameMap(tools) {
  const map = new Map();
  if (!Array.isArray(tools)) return map;
  for (const t of tools) {
    const original = String((t && t.name) || "");
    if (original.trim() === "") continue;
    const sanitized = shortenToolName(sanitizeToolName(original));
    if (sanitized !== original) map.set(sanitized, original);
  }
  return map;
}

// Normalizes a tool name to characters Kiro accepts: pure camelCase, split on
// `_`/`-` (including multi-underscore namespace prefixes), fallback "tool".
// Mirrors Go sanitizeToolName (proxy/translator.go:1020). The previous worker
// used a lossy `replace(/[^a-zA-Z0-9_-]/g,"_")`, which kept underscores Kiro
// rejects.
function sanitizeToolName(name) {
  const parts = String(name).split(/[_-]+/).filter((p) => p !== "");
  if (parts.length === 0) return "tool";
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) out += part.charAt(0).toLowerCase() + part.slice(1);
    else out += part.charAt(0).toUpperCase() + part.slice(1);
  }
  return out === "" ? "tool" : out;
}

function pickCandidates(accounts, env) {
  const enabled = accounts.filter((a) => a.enabled !== false && (a.accessToken || a.kiroApiKey));
  if (enabled.length === 0) return [];

  // Sort by smart quota strategy (highest remaining quota first)
  return enabled.sort((a, b) => {
    const remA = (a.usageLimit || 0) > 0 ? (a.usageLimit - a.usageCurrent) : 999999;
    const remB = (b.usageLimit || 0) > 0 ? (b.usageLimit - b.usageCurrent) : 999999;
    return remB - remA;
  });
}

async function callKiro(credential, payload) {
  const isApiKey = credential.authMethod === "api_key" || String(credential.accessToken || "").startsWith("ksk_") || String(credential.kiroApiKey || "").startsWith("ksk_");
  const region = credential.region || DEFAULT_REGION;

  let url = "";
  let host = "";
  if (isApiKey) {
    host = `runtime.${region}.kiro.dev`;
    url = `https://${host}/`;
  } else {
    url = region === "us-east-1"
      ? "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse"
      : `https://q.${region}.amazonaws.com/generateAssistantResponse`;
    host = new URL(url).host;
  }

  const token = credential.accessToken || credential.kiroApiKey || "";
  const top = { ...payload };
  if (!isApiKey && credential.profileArn) {
    top.profileArn = credential.profileArn;
  }

  const headers = {
    "Content-Type": isApiKey ? "application/x-amz-json-1.0" : "application/json",
    "Accept": "application/vnd.amazon.eventstream",
    "User-Agent": KIRO_USER_AGENT,
    "X-Amz-User-Agent": KIRO_AMZ_USER_AGENT,
    "x-amzn-codewhisperer-optout": isApiKey ? "false" : "true",
    "Authorization": `Bearer ${token}`,
    "Host": host,
  };

  if (isApiKey) {
    headers["TokenType"] = "API_KEY";
    headers["tokentype"] = "API_KEY";
    headers["X-Amz-Target"] = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
  } else {
    headers["x-amzn-kiro-agent-mode"] = "vibe";
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(top),
  });
}

// fetchWithModelRetry absorbs the INVALID_MODEL_ID throttle described at
// TRANSIENT_MODEL_REJECTION. `send` must be replayable, so it is passed as a
// thunk that rebuilds the request rather than a prepared Request.
//
// The retry has to reuse the SAME credential. The dispatch loops walk
// `candidates` once, so a pool holding a single account never got a second
// attempt at all — moving to the next account was the only recovery path that
// existed, and there was no next account. That is why every throttle reached the
// client verbatim.
//
// The body is consumed here to classify the failure, so a response that is not a
// throttle is rebuilt around the text already read. Headers are deliberately
// dropped: upstream sets content-encoding for the compressed original, and
// replaying it over an already-decoded string makes the caller's .text() fail.
async function fetchWithModelRetry(send) {
  let resp = await send();

  for (const backoffMs of MODEL_REJECTION_BACKOFF_MS) {
    if (resp.ok) return resp;
    const emptyTransient = resp.status === 503 && resp.headers.get("X-Kiro-Transient-Empty") === "1";
    if (resp.status !== 400 && !emptyTransient) return resp;

    const text = await resp.text();
    if (!emptyTransient && !isTransientModelRejection(resp.status, text)) {
      return new Response(text, { status: resp.status });
    }

    await sleep(jitteredBackoff(backoffMs));
    resp = await send();
  }

  return resp;
}

function callKiroWithModelRetry(credential, payload) {
  return fetchWithModelRetry(async () => preflightKiroEventStream(
    await callKiro(credential, payload),
  ));
}

// callKiroWithAuth is the upstream entry point for the Claude and OpenAI paths. It
// layers credential renewal over the throttle ramp:
//
//   1. renew proactively when the access token is inside the expiry skew
//   2. run the request through the INVALID_MODEL_ID ramp
//   3. renew reactively and retry once if upstream rejects the bearer token
//
// Step 3 is the cold-start net. An account imported without an expiry — which is
// how they arrive today, expiresAt is simply absent — has nothing for step 1 to
// check, so the first renewal has to be triggered by the rejection itself. Once it
// runs, the expiry is recorded and step 1 takes over.
async function callKiroWithAuth(env, account, payload) {
  await ensureFreshAccountToken(env, account);

  const resp = await callKiroWithModelRetry(account, payload);
  if (resp.ok || (resp.status !== 401 && resp.status !== 403)) return resp;

  const text = await resp.text();
  if (!isRejectedTokenResponse(resp.status, text)) {
    return new Response(text, { status: resp.status });
  }

  const renewed = await renewAccountToken(env, account);
  if (!renewed.ok) return new Response(text, { status: resp.status });

  return callKiroWithModelRetry(account, payload);
}

// ==================== Streamed Tool-Use Assembly ====================

// Kiro streams a single tool call across several toolUseEvent frames: the first
// carries toolUseId + name (+ maybe a partial `input`), continuation frames
// carry ONLY a partial-JSON `input` fragment (no id, no name), and a final frame
// carries {stop:true}. The previous per-handler logic keyed everything on the
// frame's own id/name, so continuation frames either got a synthesized
// id/"unknown" name (spawning a phantom second call) or were dropped by an early
// `if(!id)return`, truncating the arguments to the first fragment.
//
// This assembler mirrors Go handleToolUseEvent/finishToolUse
// (proxy/kiro.go:1160,1202): remember the currently-open tool use, append string
// `input` fragments (or REPLACE the buffer when `input` arrives as an object,
// as Go does), flush on stop, and flush any pending tool use at end of stream.
// It calls onFlush(toolUse) exactly once per completed tool call, and onOpen is
// invoked the first time a tool's id+name become known (for the streaming
// handlers that must emit an opening frame before deltas). nameMap restores the
// client's original tool name (Go ToolNameMap / OnToolUse wrapper, kiro.go:555).
function makeToolUseAssembler({ onOpen, onDelta, onFlush, nameMap } = {}) {
  let cur = null; // { id, name, buffer, opened, generatedId }

  const restore = (name) => (nameMap && nameMap.get && nameMap.get(name)) || name;

  const openIfReady = async () => {
    if (cur && !cur.opened && cur.id && cur.name) {
      cur.opened = true;
      if (onOpen) await onOpen({ id: cur.id, name: restore(cur.name) });
    }
  };

  const flush = async () => {
    if (!cur || !cur.name) { cur = null; return; }
    if (!cur.id) cur.id = `toolu_${crypto.randomUUID()}`;
    await openIfReady();
    let input = {};
    if (cur.buffer) {
      try { input = JSON.parse(cur.buffer); } catch { input = {}; }
    }
    if (onFlush) await onFlush({ id: cur.id, name: restore(cur.name), input, raw: cur.buffer || "" });
    cur = null;
  };

  const handle = async (event) => {
    const id = String(event.toolUseId || event.toolUseID || event.tool_use_id || event.id || "");
    const name = String(event.name || event.toolName || event.tool_name || "");
    const isStop = event.stop === true || event.isStop === true || event.done === true;

    if (id && name) {
      if (!cur) {
        cur = { id, name, buffer: "", opened: false, generatedId: false };
      } else if (cur.id !== id) {
        if (cur.generatedId && cur.name === name) {
          cur.id = id;
          cur.generatedId = false;
        } else {
          await flush();
          cur = { id, name, buffer: "", opened: false, generatedId: false };
        }
      }
    } else if (name && !cur) {
      cur = { id: `toolu_${crypto.randomUUID()}`, name, buffer: "", opened: false, generatedId: true };
    } else if (name && cur && cur.name !== name) {
      await flush();
      cur = { id: `toolu_${crypto.randomUUID()}`, name, buffer: "", opened: false, generatedId: true };
    }

    if (cur) {
      let frag = "";
      if (typeof event.input === "string") {
        cur.buffer += event.input;
        frag = event.input;
      } else if (event.input && typeof event.input === "object") {
        // An object input replaces the buffer wholesale (Go finishToolUse).
        cur.buffer = JSON.stringify(event.input);
        frag = cur.buffer;
      }
      await openIfReady();
      if (frag && cur.opened && onDelta) {
        await onDelta({ id: cur.id, name: restore(cur.name), frag });
      }
    }

    if (isStop) {
      await flush();
    }
  };

  // Flush any tool use still open when the stream ends without a stop frame
  // (Go flushes pending state at EOF).
  const end = async () => { await flush(); };

  return { handle, flush, end };
}

// ==================== OpenAI Wire Streaming & Non-Streaming ====================

function streamOpenAIResponse(upstream, model, cors, onDone, ctx = null) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  const pump = (async () => {
    let meteredCredits = 0;
    let tokenCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let isSuccess = true;
    let toolIndex = 0;
    let finishReason = "stop";
    const toolIndexMap = new Map();

    // Assemble multi-frame tool calls (see makeToolUseAssembler). onOpen emits
    // the id+name delta once; onDelta streams argument fragments under the same
    // index — no phantom empty/"unknown" call, no truncated arguments.
    const toolAssembler = makeToolUseAssembler({
      async onOpen({ id: toolId, name }) {
        const idx = toolIndex++;
        toolIndexMap.set(toolId, idx);
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: toolId,
                type: "function",
                function: { name, arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
      async onDelta({ id: toolId, frag }) {
        const idx = toolIndexMap.get(toolId);
        if (idx === undefined || !frag) return;
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: idx, function: { arguments: frag } }] },
            finish_reason: null,
          }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
    });

    const pingTimer = setInterval(() => {
      try {
        writer.write(encoder.encode(": ping\n\n"));
      } catch {
        clearInterval(pingTimer);
      }
    }, 10000);

    try {
      await parseAwsEventStream(upstream.body, {
        async onAssistantChunk(text) {
          if (!text) return;
          tokenCount += Math.ceil(text.length / 4);
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        async onReasoningChunk(text) {
          if (!text) return;
          tokenCount += Math.ceil(text.length / 4);
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        async onToolUse(tool) {
          finishReason = "tool_calls";
          await toolAssembler.handle(tool);
        },
        async onMetadata(meta) {
          if (meta.stopReason) {
            const sr = String(meta.stopReason).toUpperCase();
            // A trailing metadataEvent must not downgrade tool_calls once a tool
            // was emitted (bug 6). Mirror the non-stream guard: END_TURN after a
            // tool call still means tool_calls.
            if (sr === "TOOL_USE") finishReason = "tool_calls";
            else if (sr === "MAX_TOKENS") finishReason = finishReason === "tool_calls" ? "tool_calls" : "length";
            else if (finishReason !== "tool_calls") finishReason = "stop";
          }
        },
        async onMetering(credits) {
          meteredCredits += credits;
        },
        async onTokens(inp, out) {
          if (inp > inputTokens) inputTokens = inp;
          if (out > outputTokens) outputTokens = out;
        },
      });

      // Flush any tool call still open when the stream ended without a stop
      // frame (Go flushes pending state at EOF).
      await toolAssembler.end();

      // Nothing was produced: no text, no tool call, no token, no credit.
      // Fail rather than emit a valid-looking empty completion.
      if (tokenCount === 0 && outputTokens === 0 && toolIndex === 0 && meteredCredits === 0) {
        throw new EmptyUpstreamResponse();
      }

      const finalChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      isSuccess = false;
      // Mid-stream failures cannot change the status code, so the error has to
      // ride the SSE channel or the client sees a clean stop and retries.
      try {
        const status = upstreamErrorStatus(err);
        const errChunk = {
          error: {
            type: openaiErrorType(status),
            code: status,
            message: upstreamErrorMessage(err),
          },
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (_) {}
    } finally {
      clearInterval(pingTimer);
      try { await writer.close(); } catch (_) {}
      const finalOut = outputTokens > 0 ? outputTokens : tokenCount;
      if (onDone) await onDone(meteredCredits, finalOut, isSuccess, inputTokens);
    }
  })();
  // Settlement and usage recording happen after the last byte is written, so the
  // pump must be registered as pending work. Left as a bare promise it was
  // abandoned once the response completed, which silently dropped the metering
  // and leaked the request's credit hold.
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...cors,
    },
  });
}

async function nonStreamOpenAIResponse(upstream, model, cors) {
  let content = "";
  let reasoning = "";
  let credits = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = "stop";
  const toolCalls = [];
  const toolsMap = new Map();
  const toolOrder = [];

  // Assemble multi-frame tool calls: continuation frames carry only an `input`
  // fragment with no id/name, so keying on the frame's own id (the old
  // `if(!id)return`) dropped them and truncated the arguments. onFlush fires
  // once per completed call with the concatenated input.
  const toolAssembler = makeToolUseAssembler({
    async onFlush({ id, name, raw }) {
      if (!toolsMap.has(id)) {
        toolsMap.set(id, { id, name, input: raw || "" });
        toolOrder.push(id);
      } else {
        const t = toolsMap.get(id);
        t.name = name;
        t.input = raw || "";
      }
    },
  });

  let parseErr = null;
  try {
    await parseAwsEventStream(upstream.body, {
      async onAssistantChunk(t) { content += t; },
      async onReasoningChunk(t) { reasoning += t; },
      async onToolUse(tool) {
        finishReason = "tool_calls";
        await toolAssembler.handle(tool);
      },
      async onMetadata(meta) {
        if (meta.stopReason) {
          const sr = String(meta.stopReason).toUpperCase();
          if (sr === "TOOL_USE") finishReason = "tool_calls";
          else if (sr === "MAX_TOKENS") finishReason = "length";
          else if (sr === "END_TURN") finishReason = "stop";
          else finishReason = "stop";
        }
      },
      async onMetering(c) { credits += c; },
      async onTokens(inp, out) {
        if (inp > inputTokens) inputTokens = inp;
        if (out > outputTokens) outputTokens = out;
      },
    });
    // Flush a tool call still open at EOF (no stop frame). Go does the same.
    await toolAssembler.end();
  } catch (err) {
    parseErr = err;
  }

  // Carry whatever upstream already metered so the caller can still settle it.
  if (parseErr) {
    throw withPartialUsage(parseErr, credits, inputTokens, outputTokens);
  }

  if (toolOrder.length > 0 && finishReason === "stop") {
    finishReason = "tool_calls";
  }

  // Nothing came back at all. Throwing lets the caller fail over or return a
  // real error status instead of handing the client an empty completion.
  if (!content && !reasoning && toolOrder.length === 0 && outputTokens === 0 && credits === 0) {
    throw withPartialUsage(new EmptyUpstreamResponse(), credits, inputTokens, outputTokens);
  }

  for (const id of toolOrder) {
    const t = toolsMap.get(id);
    toolCalls.push({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: t.input || "{}" },
    });
  }

  const tokens = outputTokens > 0 ? outputTokens : Math.ceil((content.length + reasoning.length) / 4);
  const message = {
    role: "assistant",
    content: content.trim() || null,
    ...(reasoning ? { reasoning_content: reasoning.trim() } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  const respObj = {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens || 20,
      completion_tokens: tokens,
      total_tokens: (inputTokens || 20) + tokens,
    },
  };

  return {
    response: jsonResponse(respObj, 200, cors),
    credits,
    tokens,
    inputTokens,
    outputTokens: tokens,
  };
}

// ==================== Anthropic Wire Streaming & Non-Streaming ====================

function streamClaudeResponse(upstream, model, cors, onDone, ctx = null, opts = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const msgId = `msg_${crypto.randomUUID().slice(0, 20)}`;
  const nameMap = opts.nameMap || buildClaudeToolNameMap(opts.tools);

  const pump = (async () => {
    let meteredCredits = 0;
    let tokenCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let isSuccess = true;
    let nextIndex = 0;
    let openIndex = -1;
    let openType = "";
    let openToolId = "";
    let stopReason = "end_turn";
    // Track emitted tool IDs to prevent duplicate content_block_start
    const emittedTools = new Set();

    // Keepalive ping every 10s to prevent Cloudflare 524 timeouts
    const pingTimer = setInterval(() => {
      try {
        writer.write(encoder.encode(": ping\n\n"));
      } catch {
        clearInterval(pingTimer);
      }
    }, 10000);

    const closeOpen = async () => {
      if (openIndex >= 0) {
        const stopEv = { type: "content_block_stop", index: openIndex };
        await writer.write(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(stopEv)}\n\n`));
        openIndex = -1;
        openType = "";
        openToolId = "";
      }
    };

    // Assemble multi-frame tool_use: onOpen emits one content_block_start (with
    // the client's original name via nameMap), onDelta streams the input_json
    // fragments, and stop/EOF flushes it. This replaces the old per-frame logic
    // that spawned phantom blocks for continuation frames and dropped their
    // input fragments.
    const toolAssembler = makeToolUseAssembler({
      nameMap,
      async onOpen({ id: toolId, name }) {
        await closeOpen();
        openIndex = nextIndex++;
        openType = "tool";
        openToolId = toolId;
        emittedTools.add(toolId);
        const blockStart = {
          type: "content_block_start",
          index: openIndex,
          content_block: { type: "tool_use", id: toolId, name, input: {} },
        };
        await writer.write(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`));
      },
      async onDelta({ frag }) {
        if (!frag || openType !== "tool") return;
        const delta = {
          type: "content_block_delta",
          index: openIndex,
          delta: { type: "input_json_delta", partial_json: frag },
        };
        await writer.write(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`));
      },
      async onFlush() {
        await closeOpen();
      },
    });

    try {
      // 1. message_start
      const startEv = {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      await writer.write(encoder.encode(`event: message_start\ndata: ${JSON.stringify(startEv)}\n\n`));

      await parseAwsEventStream(upstream.body, {
        async onReasoningChunk(text) {
          if (!text) return;
          tokenCount += Math.ceil(text.length / 4);
          if (openType !== "thinking") {
            await closeOpen();
            openIndex = nextIndex++;
            openType = "thinking";
            const blockStart = { type: "content_block_start", index: openIndex, content_block: { type: "thinking", thinking: "" } };
            await writer.write(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`));
          }
          const delta = { type: "content_block_delta", index: openIndex, delta: { type: "thinking_delta", thinking: text } };
          await writer.write(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`));
        },
        async onReasoningSignature(sig) {
          if (!sig || openType !== "thinking") return;
          const delta = { type: "content_block_delta", index: openIndex, delta: { type: "signature_delta", signature: sig } };
          await writer.write(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`));
        },
        async onAssistantChunk(text) {
          if (!text) return;
          tokenCount += Math.ceil(text.length / 4);
          if (openType !== "text") {
            await closeOpen();
            openIndex = nextIndex++;
            openType = "text";
            const blockStart = { type: "content_block_start", index: openIndex, content_block: { type: "text", text: "" } };
            await writer.write(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`));
          }
          const delta = { type: "content_block_delta", index: openIndex, delta: { type: "text_delta", text } };
          await writer.write(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`));
        },
        async onToolUse(tool) {
          stopReason = "tool_use";
          await toolAssembler.handle(tool);
        },
        async onMetadata(meta) {
          if (meta.stopReason) {
            const sr = String(meta.stopReason).toUpperCase();
            // Once a tool_use was emitted, a trailing END_TURN metadataEvent must
            // not downgrade the stop reason (bug 6) — mirror the non-stream guard.
            if (sr === "TOOL_USE") stopReason = "tool_use";
            else if (sr === "MAX_TOKENS") stopReason = stopReason === "tool_use" ? "tool_use" : "max_tokens";
            else if (stopReason !== "tool_use") stopReason = "end_turn";
          }
        },
        async onMetering(c) { meteredCredits += c; },
        async onTokens(inp, out) {
          if (inp > inputTokens) inputTokens = inp;
          if (out > outputTokens) outputTokens = out;
        },
      });

      // Flush a tool_use still open at EOF (no stop frame), then close any
      // remaining block. Go flushes pending tool state at end of stream.
      await toolAssembler.end();
      await closeOpen();

      // Nothing was produced: no block opened, no token counted, no credit
      // metered. Fail rather than emit a valid-looking empty assistant turn.
      if (nextIndex === 0 && tokenCount === 0 && outputTokens === 0 && meteredCredits === 0) {
        throw new EmptyUpstreamResponse();
      }

      // Use real token counts when available, fall back to estimate
      const finalOutputTokens = outputTokens > 0 ? outputTokens : tokenCount;
      const finalInputTokens = inputTokens > 0 ? inputTokens : 0;

      // 4. message_delta
      const deltaEv = { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: finalOutputTokens } };
      await writer.write(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(deltaEv)}\n\n`));

      // 5. message_stop
      await writer.write(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
    } catch (err) {
      isSuccess = false;
      // The status line is long gone by the time upstream fails mid-stream, so
      // the only way to tell the client is an SSE error event. Without it the
      // client sees a clean end of stream and retries in a tight loop.
      try {
        const errEv = {
          type: "error",
          error: {
            type: anthropicErrorType(upstreamErrorStatus(err)),
            message: upstreamErrorMessage(err),
          },
        };
        await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify(errEv)}\n\n`));
      } catch (_) {}
    } finally {
      clearInterval(pingTimer);
      try { await writer.close(); } catch (_) {}
      const finalOut = outputTokens > 0 ? outputTokens : tokenCount;
      if (onDone) await onDone(meteredCredits, finalOut, isSuccess, inputTokens);
    }
  })();
  // Settlement and usage recording happen after the last byte is written, so the
  // pump must be registered as pending work. Left as a bare promise it was
  // abandoned once the response completed, which silently dropped the metering
  // and leaked the request's credit hold.
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...cors,
    },
  });
}

async function nonStreamClaudeResponse(upstream, model, cors, opts = {}) {
  let text = "";
  let reasoning = "";
  let reasoningSig = "";
  let credits = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const toolsMap = new Map(); // id -> {id, name, input}
  const toolOrder = [];

  // Restore the client's ORIGINAL tool name on tool_use responses. Upstream
  // echoes back the sanitized (camelCased) name we sent, so we map it back
  // rather than re-sanitizing it again (Go ToolNameMap + OnToolUse wrapper,
  // kiro.go:272,555-566). The name map is derived from the declared tools the
  // caller passes through (opts.tools) or supplied directly (opts.nameMap).
  const nameMap = opts.nameMap || buildClaudeToolNameMap(opts.tools);
  const toolAssembler = makeToolUseAssembler({
    nameMap,
    async onFlush({ id, name, raw }) {
      if (!toolsMap.has(id)) {
        toolsMap.set(id, { id, name, input: raw || "" });
        toolOrder.push(id);
      } else {
        const t = toolsMap.get(id);
        t.name = name;
        t.input = raw || "";
      }
    },
  });

  let parseErr = null;
  try {
    await parseAwsEventStream(upstream.body, {
      async onAssistantChunk(t) { text += t; },
      async onReasoningChunk(t) { reasoning += t; },
      async onReasoningSignature(s) { reasoningSig = s; },
      async onToolUse(tool) {
        stopReason = "tool_use";
        await toolAssembler.handle(tool);
      },
      async onMetadata(meta) {
        if (meta.stopReason) {
          const sr = String(meta.stopReason).toUpperCase();
          if (sr === "TOOL_USE") stopReason = "tool_use";
          else if (sr === "MAX_TOKENS") stopReason = "max_tokens";
          else if (sr === "END_TURN") stopReason = "end_turn";
          else stopReason = "end_turn";
        }
      },
      async onMetering(c) { credits += c; },
      async onTokens(inp, out) {
        if (inp > inputTokens) inputTokens = inp;
        if (out > outputTokens) outputTokens = out;
      },
    });
    // Flush a tool call still open at EOF (no stop frame). Go does the same.
    await toolAssembler.end();
  } catch (err) {
    parseErr = err;
  }

  // Carry whatever upstream already metered so the caller can still settle it.
  if (parseErr) {
    throw withPartialUsage(parseErr, credits, inputTokens, outputTokens);
  }

  if (toolOrder.length > 0 && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  // Nothing came back at all. Throwing lets the caller fail over or return a
  // real error status instead of handing the client an empty assistant message.
  if (!text && !reasoning && toolOrder.length === 0 && outputTokens === 0 && credits === 0) {
    throw withPartialUsage(new EmptyUpstreamResponse(), credits, inputTokens, outputTokens);
  }

  const content = [];
  if (reasoning) {
    const tb = { type: "thinking", thinking: reasoning };
    if (reasoningSig) tb.signature = reasoningSig;
    content.push(tb);
  }
  if (text) {
    content.push({ type: "text", text: text.trim() });
  }
  for (const id of toolOrder) {
    const t = toolsMap.get(id);
    let inputObj = {};
    if (t.input) {
      try { inputObj = JSON.parse(t.input); } catch { inputObj = {}; }
    }
    content.push({ type: "tool_use", id: t.id, name: t.name, input: inputObj });
  }

  const tokens = outputTokens > 0 ? outputTokens : Math.ceil((text.length + reasoning.length) / 4);
  const respObj = {
    id: `msg_${crypto.randomUUID().slice(0, 20)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens || 20, output_tokens: tokens },
  };

  return {
    response: jsonResponse(respObj, 200, cors),
    credits,
    tokens,
    inputTokens,
    outputTokens: tokens,
  };
}

// ==================== Upstream Exception Handling ====================

// Upstream failures that are the request's own fault. Retrying them on another
// account only burns the whole pool for the same rejection.
const NON_RETRYABLE_UPSTREAM = /validation|invalidrequest|accessdenied|unauthorized|forbidden|expiredtoken|invalidtoken|contentlengthexceed|inputtoolong|payloadtoolarge|contextwindow/i;
const AUTH_UPSTREAM = /accessdenied|unauthorized|forbidden|expiredtoken|invalidtoken/i;
const THROTTLE_UPSTREAM = /throttl|toomanyrequests|servicequota|limitexceed/i;
const BAD_REQUEST_UPSTREAM = /validation|invalidrequest|contentlengthexceed|inputtoolong|payloadtoolarge|contextwindow/i;

// A modeled error carried inside a 200 AWS event stream. Raised so the caller
// can fail the request instead of returning a well formed but empty answer.
class KiroUpstreamException extends Error {
  constructor(exceptionType, message) {
    super(message || exceptionType || "Kiro upstream exception");
    this.name = "KiroUpstreamException";
    this.exceptionType = String(exceptionType || "UpstreamException");
    this.upstreamMessage = String(message || "");
  }

  // The same throttle callKiroWithModelRetry absorbs on the HTTP path can also
  // arrive as an in-stream ValidationException frame. Classifying it by
  // exceptionType alone lands it in BAD_REQUEST_UPSTREAM/NON_RETRYABLE_UPSTREAM,
  // which is how a transient throttle became a permanent 400 here too. The
  // reason code lives in the message, so that is what has to be inspected.
  get isModelThrottle() {
    return TRANSIENT_MODEL_REJECTION.test(this.upstreamMessage);
  }

  get status() {
    if (this.isModelThrottle) return 429;
    if (THROTTLE_UPSTREAM.test(this.exceptionType)) return 429;
    if (AUTH_UPSTREAM.test(this.exceptionType)) return 401;
    if (BAD_REQUEST_UPSTREAM.test(this.exceptionType)) return 400;
    if (/serviceunavailable|internalserver/i.test(this.exceptionType)) return 503;
    return 502;
  }

  get retryable() {
    if (this.isModelThrottle) return true;
    return !NON_RETRYABLE_UPSTREAM.test(this.exceptionType);
  }
}

// A 200 event stream with no content, no tool call, no token count and no
// metering event is not an answer. It used to be forwarded as an empty
// assistant turn, which clients treat as a transient glitch and retry
// immediately — one upstream failure became a multi-hundred-request loop that
// upstream never charged for, so no quota or rate limit ever stopped it.
class EmptyUpstreamResponse extends KiroUpstreamException {
  constructor() {
    super("EmptyUpstreamResponse", "Upstream returned no content, tokens or metering");
  }
}

function upstreamErrorStatus(err) {
  return err instanceof KiroUpstreamException ? err.status : 502;
}

// Upstream meters what it actually produced, so a request that failed after a
// meteringEvent already arrived still owes for it. The non-stream builders
// accumulate credits in locals, and throwing used to discard them — the request
// became free even though upstream charged us. Same invariant the stream path
// gets from shouldSettleStream(); this carries it across a throw.
function withPartialUsage(err, credits, inputTokens, outputTokens) {
  try {
    err.partialCredits = Math.max(0, Number(credits) || 0);
    err.partialInputTokens = Math.max(0, Number(inputTokens) || 0);
    err.partialOutputTokens = Math.max(0, Number(outputTokens) || 0);
  } catch (_) {}
  return err;
}

function partialCreditsOf(err) {
  return Math.max(0, Number(err && err.partialCredits) || 0);
}

// Total charge for a request: what the attempt that answered cost, plus what
// earlier attempts already cost upstream before they failed. Dropping the second
// term makes a retried request underpay by exactly what the failed attempt cost.
//
// Named and exported-for-test on purpose, same reason as shouldSettleStream():
// inline at the four call sites the suite could only re-implement the arithmetic,
// so reverting the fix left the suite green.
function totalChargeFor(ownCredits, owedCredits) {
  const own = Math.max(0, Number(ownCredits) || 0);
  const owed = Math.max(0, Number(owedCredits) || 0);
  return parseFloat((own + owed).toFixed(6));
}

// Closes out a non-stream request that never produced a response.
//
// Two things used to go wrong here. The hold was always released, so a request
// that failed after upstream had already metered work became free — the same
// hole shouldSettleStream() closes for streams. And nothing was recorded, so a
// failing request left no trace at all; combined with the swallowed exception
// bug the dashboard showed a fabricated success instead of an error.
async function finishFailedRequest(env, ctx, opts) {
  const owed = Math.max(0, Number(opts.owedCredits) || 0);
  const settled = owed > 0
    ? await settleApiKeyQuota(env, opts.apiKeyId, opts.reservation, owed, opts.requestId)
    : (await releaseApiKeyQuota(env, opts.apiKeyId, opts.reservation), null);

  const duration = Date.now() - opts.startTime;
  const inTok = Math.max(0, Number(opts.inputTokens) || 0);
  await recordRequestStats(env, ctx, false, inTok, 0, owed, {
    time: Math.floor(Date.now() / 1000),
    timeUnix: Math.floor(Date.now() / 1000),
    account: opts.account || opts.accountId || "",
    accountId: opts.accountId || "",
    apiKeyId: opts.apiKeyId || "",
    apiKey: opts.apiKey || "",
    ip: opts.ip || "",
    endpoint: opts.endpoint,
    model: opts.model,
    status: "error",
    statusCode: opts.status,
    error: opts.message,
    credits: owed,
    metered: owed > 0,
    tokensEstimated: true,
    inputTokens: inTok,
    outputTokens: 0,
    totalTokens: inTok,
    tokens: inTok,
    duration,
    latencyMs: duration,
    durationMs: duration,
    kind: opts.kind,
  }, opts.apiKeyId, opts.accountId || "", opts.model, settled?.used, opts.requestId);
}

function upstreamErrorMessage(err) {
  if (err instanceof KiroUpstreamException) {
    const text = err.upstreamMessage || err.message || "";
    if (isContentLengthExceeded(err.status, text)) {
      return normalizeUpstreamFailure(err.status, text).message;
    }
    return err.upstreamMessage ? `${err.exceptionType}: ${err.upstreamMessage}` : err.exceptionType;
  }
  const msg = err && err.message ? String(err.message) : "Upstream stream failed";
  if (isContentLengthExceeded(400, msg)) {
    return normalizeUpstreamFailure(400, msg).message;
  }
  return msg;
}

function anthropicErrorType(status) {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status === 400) return "invalid_request_error";
  if (status === 503) return "overloaded_error";
  return "api_error";
}

function openaiErrorType(status) {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status === 400) return "invalid_request_error";
  return "api_error";
}

// ==================== AWS EventStream Binary Frame Parser ====================

async function parseAwsEventStream(bodyStream, hooks = {}) {
  const reader = bodyStream.getReader();
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = concatBytes(buffer, value);

      while (buffer.length >= 12) {
        // Ensure we have a proper DataView over the current buffer slice
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLen = view.getUint32(0, false);
        const headersLen = view.getUint32(4, false);

        if (totalLen < 16 || totalLen > 1024 * 1024 || headersLen > (totalLen - 16) || headersLen > 8192) {
          // Corrupt frame — skip one byte and try to re-sync
          buffer = buffer.subarray(1);
          continue;
        }

        if (buffer.length < totalLen) break; // wait for full frame

        const headersStart = 12;
        const headersEnd = headersStart + headersLen;
        const payloadEnd = totalLen - 4;

        const headersBytes = buffer.subarray(headersStart, headersEnd);
        const payloadBytes = buffer.subarray(headersEnd, payloadEnd);

        const frameHeaders = parseFrameHeaders(headersBytes);
        const eventType = typeof frameHeaders[":event-type"] === "string" ? frameHeaders[":event-type"] : "";
        const messageType = typeof frameHeaders[":message-type"] === "string" ? frameHeaders[":message-type"] : "";
        const exceptionType = frameHeaders[":exception-type"] || frameHeaders[":error-code"] || "";

        let payloadJson = null;
        try {
          const payloadStr = new TextDecoder().decode(payloadBytes);
          if (payloadStr.length > 0) payloadJson = JSON.parse(payloadStr);
        } catch {}

        // Errors are not `:event-type` frames. Smithy marks them with
        // `:message-type: exception` plus `:exception-type: <MemberName>`, so a
        // parser keyed only on `:event-type` saw an unknown frame and dropped
        // it — turning upstream throttling and validation failures into silent
        // empty 200 responses. Raise instead, and advance the buffer first so
        // nothing is left half-consumed.
        const isExceptionFrame = messageType === "exception" || messageType === "error" ||
          Boolean(exceptionType) || /Exception$/.test(eventType);
        if (isExceptionFrame) {
          buffer = buffer.subarray(totalLen);
          const name = String(exceptionType || eventType || "UpstreamException");
          const msg = (payloadJson && (payloadJson.message || payloadJson.Message || payloadJson.errorMessage || payloadJson.reason)) ||
            frameHeaders[":error-message"] || "";
          throw new KiroUpstreamException(name, msg);
        }

        if (payloadJson) {
          // Hook failures (a closed writer after a client disconnect) stay
          // swallowed here; only upstream exceptions are allowed to propagate.
          try {
            await dispatchEvent(eventType, payloadJson, hooks);
          } catch (err) {
            if (err instanceof KiroUpstreamException) {
              buffer = buffer.subarray(totalLen);
              throw err;
            }
          }
        }

        buffer = buffer.subarray(totalLen);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function dispatchEvent(eventType, payload, hooks) {
  switch (eventType) {
    case "assistantResponseEvent": {
      const txt = typeof payload.content === "string" ? payload.content : (typeof payload.text === "string" ? payload.text : (typeof payload.delta?.text === "string" ? payload.delta.text : ""));
      if (txt && hooks.onAssistantChunk) {
        await hooks.onAssistantChunk(txt);
      }
      break;
    }
    case "reasoningContentEvent": {
      // Kiro sends {text: "...", signature: "..."} — parse text and signature
      const rText = typeof payload.text === "string" ? payload.text : (typeof payload.reasoningContent === "string" ? payload.reasoningContent : (typeof payload.content === "string" ? payload.content : (typeof payload.delta?.text === "string" ? payload.delta.text : "")));
      const rSig = payload.signature || payload.delta?.signature || "";
      if (rText && hooks.onReasoningChunk) {
        await hooks.onReasoningChunk(rText);
      }
      if (rSig && hooks.onReasoningSignature) {
        await hooks.onReasoningSignature(rSig);
      }
      break;
    }
    case "toolUseEvent":
      if (hooks.onToolUse) {
        await hooks.onToolUse(payload);
      }
      break;
    case "metadataEvent":
      if (hooks.onMetadata) {
        await hooks.onMetadata(payload);
      }
      if (hooks.onTokens) {
        const inp = payload.inputTokenCount || payload.inputTokens || (payload.usage && (payload.usage.inputTokens || payload.usage.promptTokens)) || 0;
        const out = payload.outputTokenCount || payload.outputTokens || (payload.usage && (payload.usage.outputTokens || payload.usage.completionTokens)) || 0;
        if (inp > 0 || out > 0) {
          hooks.onTokens(inp, out);
        }
      }
      break;
    case "contextUsageEvent":
      if (hooks.onContextUsage) {
        await hooks.onContextUsage(payload);
      }
      break;
    case "meteringEvent": {
      // Credits can be in payload.usage, payload.credits, or nested in
      // payload.meteringCredits / payload.creditsConsumed
      let credits = 0;
      if (typeof payload.usage === "number" && payload.usage > 0) {
        credits = payload.usage;
      } else if (typeof payload.credits === "number" && payload.credits > 0) {
        credits = payload.credits;
      } else if (typeof payload.meteringCredits === "number" && payload.meteringCredits > 0) {
        credits = payload.meteringCredits;
      } else if (typeof payload.creditsConsumed === "number" && payload.creditsConsumed > 0) {
        credits = payload.creditsConsumed;
      }
      if (credits > 0 && hooks.onMetering) {
        await hooks.onMetering(credits);
      }
      // Token counts
      if (hooks.onTokens) {
        const inp = payload.inputTokenCount || payload.inputTokens || (payload.usage && (payload.usage.inputTokens || payload.usage.promptTokens)) || 0;
        const out = payload.outputTokenCount || payload.outputTokens || (payload.usage && (payload.usage.outputTokens || payload.usage.completionTokens)) || 0;
        if (inp > 0 || out > 0) {
          hooks.onTokens(inp, out);
        }
      }
      break;
    }
    default:
      break;
  }
}

// Decodes every prelude header of an AWS event-stream frame. The previous
// version returned as soon as it found `:event-type`, which meant exception
// frames (which carry `:message-type` / `:exception-type` and no `:event-type`)
// were indistinguishable from an unknown event and silently discarded.
function parseFrameHeaders(headersBytes) {
  const out = {};
  try {
    let offset = 0;
    while (offset < headersBytes.length - 1) {
      const nameLen = headersBytes[offset];
      offset += 1;
      if (offset + nameLen > headersBytes.length) break;
      const name = new TextDecoder().decode(headersBytes.subarray(offset, offset + nameLen));
      offset += nameLen;
      if (offset >= headersBytes.length) break;
      const valType = headersBytes[offset];
      offset += 1;

      if (valType === 7) { // string
        if (offset + 2 > headersBytes.length) break;
        const valLen = (headersBytes[offset] << 8) | headersBytes[offset + 1];
        offset += 2;
        if (offset + valLen > headersBytes.length) break;
        out[name] = new TextDecoder().decode(headersBytes.subarray(offset, offset + valLen));
        offset += valLen;
      } else if (valType === 0) { // bool true
        out[name] = true;
      } else if (valType === 1) { // bool false
        out[name] = false;
      } else if (valType === 2) { // byte
        offset += 1;
      } else if (valType === 3) { // short
        offset += 2;
      } else if (valType === 4) { // int
        offset += 4;
      } else if (valType === 5) { // long
        offset += 8;
      } else if (valType === 6) { // bytes
        if (offset + 2 > headersBytes.length) break;
        const bLen = (headersBytes[offset] << 8) | headersBytes[offset + 1];
        offset += 2 + bLen;
      } else if (valType === 8) { // timestamp
        offset += 8;
      } else if (valType === 9) { // uuid
        offset += 16;
      } else {
        break; // unknown type, bail
      }
    }
  } catch {}
  return out;
}

function extractEventType(headersBytes) {
  const h = parseFrameHeaders(headersBytes);
  return typeof h[":event-type"] === "string" ? h[":event-type"] : "";
}

function concatBytes(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

// ==================== Public Quota & Key Checker ====================

async function handleQuotaCheck(request, env, cors) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  let pathKey = "";
  if (path.startsWith("/check/")) pathKey = path.slice("/check/".length).trim();
  else if (path.startsWith("/key/")) pathKey = path.slice("/key/".length).trim();
  else if (path.startsWith("/quota/")) pathKey = path.slice("/quota/".length).trim();

  const authHeader = request.headers.get("Authorization") ||
                     request.headers.get("X-Api-Key") ||
                     request.headers.get("x-api-key") ||
                     request.headers.get("anthropic-auth-token") ||
                     request.headers.get("x-anthropic-auth-token") ||
                     request.headers.get("api-key") ||
                     "";

  let rawKey = url.searchParams.get("key") ||
               url.searchParams.get("api_key") ||
               url.searchParams.get("token") ||
               url.searchParams.get("k") ||
               pathKey ||
               authHeader.replace(/^Bearer\s+/i, "").trim();

  if (request.method === "POST") {
    try {
      const b = await request.json();
      if (b && typeof b === "object") {
        if (b.key || b.apiKey || b.api_key || b.token) {
          rawKey = String(b.key || b.apiKey || b.api_key || b.token).trim();
        }
      }
    } catch (_) {}
  }

  const acceptHeader = request.headers.get("Accept") || "";
  const formatParam = (url.searchParams.get("format") || "").toLowerCase();
  const forceJson = formatParam === "json" || url.searchParams.get("json") === "1" || url.searchParams.get("json") === "true";
  const prefersJson = forceJson || (acceptHeader.includes("application/json") && !acceptHeader.includes("text/html") && !acceptHeader.includes("*/*"));
  const isJson = prefersJson;

  const catalogModels = FALLBACK_MODELS;

  if (!rawKey) {
    if (isJson) return jsonResponse({ error: "Missing ?key parameter" }, 400, cors);
    return new Response(renderQuotaCheckHtml(url.origin, null, "", "", catalogModels, []), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", ...cors },
    });
  }

  const keys = await getApiKeys(env, request);
  const cleanRaw = String(rawKey || "").trim();
  const matched = keys.find((k) => {
    const kVal = String(k.key || "").trim();
    const kId = String(k.id || "").trim();
    return kVal === cleanRaw || kId === cleanRaw || (cleanRaw.length >= 10 && kVal.startsWith(cleanRaw)) || (kVal.length >= 10 && cleanRaw.startsWith(kVal));
  });

  if (!matched) {
    if (isJson) return jsonResponse({ error: "API Key not found" }, 404, cors);
    return new Response(renderQuotaCheckHtml(url.origin, null, rawKey, "API key not found or unrecognized. Please check the secret and try again.", catalogModels, []), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", ...cors },
    });
  }

  const allLogs = await getLogs(env, request);
  const belongsToKey = (l) => l && (
    l.apiKeyId === matched.id ||
    l.apiKey === matched.id ||
    l.apiKey === matched.key ||
    l.keyId === matched.id ||
    l.keyId === matched.key ||
    (l.apiKeyMasked && l.apiKeyMasked === maskApiKey(matched.key))
  );

  // The Durable Object is strongly consistent; KV is not. Read both and let the
  // DO win so a request that just finished shows up on the next poll instead of
  // after the 60s KV edge cache expires.
  const live = await getApiKeyLiveState(env, matched.id);
  const liveStats = live && live.stats ? live.stats : null;
  const liveLogs = live && Array.isArray(live.logs) ? live.logs.filter(belongsToKey) : [];
  const peerOverlay = peerDelta(await getPeerKeyOverlay(env, matched.id));
  const peerLogs = (await getPeerLogs(env)).filter(belongsToKey);

  const logSignature = (l) => l.id || [l.cluster || "", l.timeUnix || l.time || 0, l.model || "", l.totalTokens ?? l.tokens ?? "", l.duration ?? ""].join("|");
  const seenLogs = new Set();
  const keyLogs = [];
  for (const l of [...liveLogs, ...allLogs.filter(belongsToKey), ...peerLogs]) {
    const sig = logSignature(l);
    if (seenLogs.has(sig)) continue;
    seenLogs.add(sig);
    keyLogs.push(l);
  }
  keyLogs.sort((a, b) => (Number(b.timeUnix || b.time || 0) - Number(a.timeUnix || a.time || 0)));
  if (keyLogs.length > CHECK_LOG_LIMIT) keyLogs.length = CHECK_LOG_LIMIT;

  const kvTokensIn = Number(matched.tokensIn) || 0;
  const kvTokensOut = Number(matched.tokensOut) || Number(matched.tokens) || 0;
  const kvRequests = Number(matched.requestsCount) || Number(matched.requests) || 0;
  const kvCreditsUsed = Number(matched.creditsUsed) || Number(matched.credits) || 0;

  const tokensIn = Math.max(kvTokensIn, liveStats ? Number(liveStats.tokensIn) || 0 : 0) + (Number(peerOverlay.tokensIn) || 0);
  const tokensOut = Math.max(kvTokensOut, liveStats ? Number(liveStats.tokensOut) || 0 : 0) + (Number(peerOverlay.tokensOut) || 0);
  const tokensUsed = Math.max(Number(matched.tokensUsed) || 0, tokensIn + tokensOut);
  const requestsCount = Math.max(kvRequests, liveStats ? Number(liveStats.requests) || 0 : 0) + (Number(peerOverlay.requests) || 0);
  const liveCreditsUsed = live && Number.isFinite(Number(live.used)) ? Number(live.used) : 0;
  // modelUsage is the unrewritten metered record, so it is the floor that
  // exposes credits an earlier settle bug had dropped from the running total.
  const meteredCreditsUsed = sumModelUsageCredits(matched.modelUsage);
  const localCreditsUsed = Math.max(kvCreditsUsed, liveCreditsUsed, meteredCreditsUsed);
  const creditsUsed = combinedCreditsUsed(localCreditsUsed, peerOverlay);
  const creditLimit = Number(matched.creditLimit) || 0;
  const tokenLimit = Number(matched.tokenLimit) || 0;
  const lastUsedAt = Math.max(
    Number(matched.lastUsedUnix || matched.lastUsedAt || 0) || 0,
    liveStats ? Number(liveStats.lastUsedUnix) || 0 : 0,
    Number(peerOverlay.lastUsedUnix) || 0,
  );

  const keyExpiresAt = Number(matched.expiresAt || matched.tokenExpires || 0);
  const isKeyExpired = keyExpiresAt > 0 && Math.floor(Date.now() / 1000) >= keyExpiresAt;
  let resolvedKeyStatus = matched.enabled === false ? "disabled" : (creditLimit > 0 && creditsUsed >= creditLimit ? "quota_exceeded" : (isKeyExpired ? "quota_exceeded" : "active"));

  // The dashboard renders from this object, so overlay the live numbers or the
  // server-rendered first paint would still show the stale KV balance.
  const viewKey = {
    ...matched,
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    tokensUsed,
    requests: requestsCount,
    requestsCount,
    credits: creditsUsed,
    creditsUsed,
    lastUsedUnix: lastUsedAt,
  };

  if (isJson) {
    return jsonResponse({
      success: true,
      name: matched.name || "API Key",
      key_name: matched.name || "API Key",
      key_prefix: getKeyPrefix(rawKey),
      key_masked: maskApiKey(rawKey),
      enabled: matched.enabled !== false,
      status: resolvedKeyStatus,
      expires_at: keyExpiresAt,
      expired: isKeyExpired,
      credit_limit: creditLimit,
      credits_used: creditsUsed,
      credits_used_kirogo: localCreditsUsed,
      credits_used_kiropool: Number(peerOverlay.creditsUsed) || 0,
      credits_reserved: live ? Number(live.reserved) || 0 : 0,
      remaining_credits: creditLimit > 0 ? Math.max(0, creditLimit - creditsUsed) : "unlimited",
      token_limit: tokenLimit,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_used: tokensUsed,
      remaining_tokens: tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : "unlimited",
      requests_count: requestsCount,
      model_usage: matched.modelUsage || {},
      created_at: matched.createdUnix || matched.createdAt || 0,
      last_used_at: lastUsedAt,
      allowed_models: catalogModels,
      recent_logs: keyLogs,
      live: Boolean(live),
      server_time: Math.floor(Date.now() / 1000),
    }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate", ...cors });
  }

  return new Response(renderQuotaCheckHtml(url.origin, viewKey, rawKey, "", catalogModels, keyLogs), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", ...cors },
  });
}

function renderQuotaCheckHtml(origin, keyData = null, rawKey = "", errorMsg = "", catalogModels = [], keyLogs = []) {
  const keyVal = rawKey ? escapeAttrVal(rawKey) : "";
  const isFound = Boolean(keyData);
  const isEnabled = isFound && keyData.enabled !== false;
  const creditsUsed = isFound ? (Number(keyData.creditsUsed) || Number(keyData.credits) || 0) : 0;
  const creditLimit = isFound ? (Number(keyData.creditLimit) || 0) : 0;
  const keyExpiresAt = isFound ? Number(keyData.expiresAt || keyData.tokenExpires || keyData.expires_at || 0) : 0;
  const isKeyExpired = keyExpiresAt > 0 && Math.floor(Date.now() / 1000) >= keyExpiresAt;
  const isQuotaExceeded = isFound && ((creditLimit > 0 && creditsUsed >= creditLimit) || isKeyExpired);

  let status = "none";
  let statusBadgeText = "Chưa kết nối";
  let statusBadgeClass = "bg-zinc-500/10 text-zinc-400 border-zinc-500/20";
  if (isFound) {
    if (!isEnabled) {
      status = "disabled";
      statusBadgeText = "● Đã khóa";
      statusBadgeClass = "bg-rose-500/10 text-rose-400 border-rose-500/20";
    } else if (isQuotaExceeded) {
      status = "quota_exceeded";
      statusBadgeText = isKeyExpired ? "⚠️ Hết hạn dùng" : "⚠️ Vượt Quota";
      statusBadgeClass = "bg-rose-500/10 text-rose-400 border-rose-500/20";
    } else {
      status = "active";
      statusBadgeText = "● Hoạt động";
      statusBadgeClass = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    }
  }

  const tokensIn = isFound ? (Number(keyData.tokensIn) || 0) : 0;
  const tokensOut = isFound ? (Number(keyData.tokensOut) || Number(keyData.tokens) || 0) : 0;
  const tokensUsed = isFound ? (Number(keyData.tokensUsed) || (tokensIn + tokensOut)) : 0;
  const tokenLimit = isFound ? (Number(keyData.tokenLimit) || 0) : 0;
  const tokenPct = tokenLimit > 0 ? Math.min(100, Math.round((tokensUsed / tokenLimit) * 100)) : 0;

  const remainingCreditsNum = creditLimit > 0 ? Math.max(0, creditLimit - creditsUsed) : null;
  const creditPct = creditLimit > 0 ? Math.min(100, Math.round((creditsUsed / creditLimit) * 100)) : 0;
  const requestsCount = isFound ? (Number(keyData.requestsCount) || Number(keyData.requests) || 0) : 0;

  const keyDataJson = isFound ? JSON.stringify({
    success: true,
    name: keyData.name || "API Key",
    key_name: keyData.name || "API Key",
    key_prefix: getKeyPrefix(rawKey),
    key_masked: maskApiKey(rawKey),
    enabled: isEnabled,
    status: status,
    expires_at: keyExpiresAt,
    expired: isKeyExpired,
    credit_limit: creditLimit,
    credits_used: creditsUsed,
    remaining_credits: remainingCreditsNum !== null ? remainingCreditsNum : "unlimited",
    token_limit: tokenLimit,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_used: tokensUsed,
    remaining_tokens: tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : "unlimited",
    requests_count: requestsCount,
    model_usage: keyData.modelUsage || {},
    created_at: keyData.createdUnix || keyData.createdAt || 0,
    last_used_at: keyData.lastUsedUnix || keyData.lastUsedAt || 0,
    recent_logs: keyLogs || []
  }).replace(/</g, "\\u003c") : "null";

  return `<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kiro-Go</title>
  <link rel="icon" type="image/png" href="/admin/icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@100;200;300;400;500;600;700;800;900&family=Geist+Mono:wght@100;200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/vendor/fontawesome/css/all.min.css" />
  <script>
    (function() {
      var savedTheme = localStorage.getItem("kiro_theme") || "dark";
      if (savedTheme === "light") {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
      } else {
        document.documentElement.classList.add("dark");
        document.documentElement.classList.remove("light");
      }
    })();
  </script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root, html.light {
      --bg: #fcfcfc;
      --card: #ffffff;
      --card-inner: #f5f5f5;
      --border: #e4e4e4;
      --border-hover: #cccccc;
      --text-primary: #000000;
      --text-secondary: #525252;
      --text-muted: #8c8c8c;
      --table-head: #f5f5f5;
      --table-hover: #f0f0f0;
      --input-bg: #ffffff;
      --code-bg: #f5f5f5;
      --badge-bg: #f5f5f5;
      --badge-border: #e4e4e4;
      --brand: #000000;
      --accent: #000000;
    }
    html.dark {
      --bg: #000000;
      --card: #090909;
      --card-inner: #141414;
      --border: #242424;
      --border-hover: #383838;
      --text-primary: #ffffff;
      --text-secondary: #a4a4a4;
      --text-muted: #737373;
      --table-head: #121212;
      --table-hover: #191919;
      --input-bg: #111111;
      --code-bg: #121212;
      --badge-bg: #191919;
      --badge-border: #333333;
      --brand: #ffffff;
      --accent: #ffffff;
    }
    body {
      background-color: var(--bg);
      color: var(--text-primary);
      font-family: "Geist", -apple-system, BlinkMacSystemFont, sans-serif;
      transition: background-color 0.15s ease, color 0.15s ease;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }
    .mono { font-family: "Geist Mono", ui-monospace, Menlo, monospace; }
    .tabular-nums { font-variant-numeric: tabular-nums; }
    .app-card { background-color: var(--card); border: 1px solid var(--border); }
    .app-card-inner { background-color: var(--card-inner); border: 1px solid var(--border); }
    .tab-btn.active { background: var(--card-inner); color: var(--text-primary); border-color: var(--border-hover); font-weight: 600; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border-hover); border-radius: 3px; }

    /* Login Screen & Ghost Animation */
    .login-wrapper {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      background: var(--bg);
    }
    .ghost-bg {
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      overflow: hidden;
    }
    .ghost-bg .ghost {
      position: absolute;
      color: var(--text-primary);
      opacity: 0.04;
      animation: ghostFloat 16s ease-in-out infinite;
    }
    html.dark .ghost-bg .ghost {
      opacity: 0.06;
    }
    .ghost-bg .ghost-1 { top: 8%; left: 5%; font-size: 2.5rem; animation-delay: 0s; animation-duration: 14s; }
    .ghost-bg .ghost-2 { top: 20%; left: 16%; font-size: 1.6rem; animation-delay: -2s; animation-duration: 18s; }
    .ghost-bg .ghost-3 { top: 72%; left: 8%; font-size: 2.8rem; animation-delay: -4s; animation-duration: 20s; }
    .ghost-bg .ghost-4 { top: 52%; left: 22%; font-size: 1.8rem; animation-delay: -6s; animation-duration: 16s; }
    .ghost-bg .ghost-5 { top: 12%; right: 7%; font-size: 2.6rem; animation-delay: -1s; animation-duration: 15s; }
    .ghost-bg .ghost-6 { top: 35%; right: 18%; font-size: 1.7rem; animation-delay: -5s; animation-duration: 19s; }
    .ghost-bg .ghost-7 { top: 65%; right: 9%; font-size: 2.3rem; animation-delay: -3s; animation-duration: 17s; }
    .ghost-bg .ghost-8 { top: 84%; right: 24%; font-size: 1.5rem; animation-delay: -7s; animation-duration: 13s; }
    .ghost-bg .ghost-9 { top: 5%; left: 45%; font-size: 2rem; animation-delay: -8s; animation-duration: 21s; }
    .ghost-bg .ghost-10 { top: 86%; left: 46%; font-size: 2.1rem; animation-delay: -9s; animation-duration: 15s; }
    .ghost-bg .ghost-11 { top: 40%; left: 3%; font-size: 1.7rem; animation-delay: -11s; animation-duration: 17s; }
    .ghost-bg .ghost-12 { top: 45%; right: 4%; font-size: 1.8rem; animation-delay: -10s; animation-duration: 16s; }

    @keyframes ghostFloat {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      25% { transform: translateY(-16px) rotate(4deg); }
      50% { transform: translateY(-6px) rotate(-3deg); }
      75% { transform: translateY(-22px) rotate(2deg); }
    }

    .login-topbar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10;
      width: 100%;
      height: 3.75rem;
      padding: 0 1.75rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }

    .login-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100dvh;
      padding: 5rem 1.25rem 3rem;
      position: relative;
      z-index: 2;
    }

    /* Clean Authentic Kiro-Go Box */
    .login-box {
      width: 100%;
      max-width: 520px;
      padding: 2.75rem 2.25rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1.25rem;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.4);
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes cardIn {
      from { transform: translateY(18px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .input-affix {
      position: relative;
      display: flex;
      align-items: center;
    }
    .input-affix input {
      padding-left: 2.85rem !important;
      padding-right: 2.85rem !important;
      width: 100%;
    }
    .input-affix .affix-icon {
      position: absolute;
      left: 1rem;
      color: var(--text-muted);
      pointer-events: none;
      font-size: 1rem;
    }
    .input-affix .affix-btn {
      position: absolute;
      right: 0.65rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
    }
    .input-affix .affix-btn:hover {
      color: var(--text-primary);
    }
    .shake {
      animation: shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
    }
    @keyframes shake {
      10%, 90% { transform: translate3d(-1px, 0, 0); }
      20%, 80% { transform: translate3d(2px, 0, 0); }
      30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
      40%, 60% { transform: translate3d(3px, 0, 0); }
    }
  </style>
</head>
<body class="min-h-screen">

  <!-- ==================== VIEW 1: KEY LOGIN BOX ==================== -->
  <div id="loginView" class="login-wrapper ${isFound ? 'hidden' : ''}">
    <!-- Ambient Floating Ghosts on Login Screen -->
    <div class="ghost-bg" aria-hidden="true">
      <i class="fa-solid fa-ghost ghost ghost-1"></i>
      <i class="fa-solid fa-ghost ghost ghost-2"></i>
      <i class="fa-solid fa-ghost ghost ghost-3"></i>
      <i class="fa-solid fa-ghost ghost ghost-4"></i>
      <i class="fa-solid fa-ghost ghost ghost-5"></i>
      <i class="fa-solid fa-ghost ghost ghost-6"></i>
      <i class="fa-solid fa-ghost ghost ghost-7"></i>
      <i class="fa-solid fa-ghost ghost ghost-8"></i>
      <i class="fa-solid fa-ghost ghost ghost-9"></i>
      <i class="fa-solid fa-ghost ghost ghost-10"></i>
      <i class="fa-solid fa-ghost ghost ghost-11"></i>
      <i class="fa-solid fa-ghost ghost ghost-12"></i>
    </div>

    <header class="login-topbar">
      <div class="flex items-center gap-3">
        <img src="/admin/icon.png" alt="Kiro-Go" class="w-8 h-8 object-contain rounded-md" style="filter: invert(1);" />
        <span class="font-bold text-base text-[var(--text-primary)] tracking-tight">Kiro-Go</span>
      </div>
      <div class="flex items-center gap-3">
        <!-- Language Switcher -->
        <div class="inline-flex rounded-lg border border-[var(--border)] bg-[var(--card-inner)] p-1 text-xs">
          <button type="button" onclick="setLang('vi')" id="langBtnVi" class="px-2.5 py-1 rounded-md font-semibold text-[var(--text-primary)] bg-[var(--badge-bg)] cursor-pointer">VI</button>
          <button type="button" onclick="setLang('en')" id="langBtnEn" class="px-2.5 py-1 rounded-md font-semibold text-[var(--text-secondary)] hover:bg-[var(--badge-bg)] cursor-pointer">EN</button>
          <button type="button" onclick="setLang('zh')" id="langBtnZh" class="px-2.5 py-1 rounded-md font-semibold text-[var(--text-secondary)] hover:bg-[var(--badge-bg)] cursor-pointer">ZH</button>
        </div>
        <!-- Theme Switcher -->
        <button type="button" onclick="toggleTheme()" id="themeBtn" title="Chuyển đổi giao diện Sáng / Tối" class="p-2 rounded-lg border border-[var(--border)] bg-[var(--card-inner)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition flex items-center justify-center">
          <span id="loginThemeIcon" class="text-sm">🌙</span>
        </button>
      </div>
    </header>

    <main class="login-main">
      <div class="login-box" id="loginCard">
        <div class="text-center mb-6">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--card-inner)] border border-[var(--border)] mb-3 shadow-inner">
            <i class="fa-solid fa-key text-xl text-[var(--text-primary)]"></i>
          </div>
          <h1 class="text-2xl font-bold tracking-tight text-[var(--text-primary)] mb-1.5" id="t_title">Tra cứu API Key</h1>
          <p class="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed" id="t_subtitle">Kiểm tra hạn mức Quota, số lượng requests, token và lịch sử gọi API theo thời gian thực.</p>
        </div>

        <form id="keyLoginForm" onsubmit="handleKeyLogin(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-[var(--text-secondary)] mb-2" id="t_labelKey">API Key Khách hàng</label>
            <div class="input-affix">
              <i class="fa-solid fa-key affix-icon"></i>
              <input
                type="password"
                id="loginKeyInput"
                value="${keyVal}"
                placeholder="kpp_... hoặc sk-..."
                required
                autocomplete="off"
                class="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-xl py-3 text-sm text-[var(--text-primary)] mono outline-none focus:border-[var(--text-primary)] focus:ring-1 focus:ring-[var(--text-primary)] transition"
              />
              <button type="button" class="affix-btn" id="loginKeyToggle" onclick="toggleKeyVisibility()" title="Hiển thị / Ẩn Key">
                <i class="fa-solid fa-eye text-sm" id="loginKeyEyeIcon"></i>
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between text-xs pt-1">
            <label class="inline-flex items-center gap-2 cursor-pointer text-[var(--text-secondary)] select-none">
              <input type="checkbox" id="rememberKeyCheck" checked class="w-4 h-4 rounded border-[var(--border)] accent-[var(--text-primary)] cursor-pointer" />
              <span id="t_remember">Ghi nhớ key trên trình duyệt</span>
            </label>
          </div>

          <button
            type="submit"
            id="loginSubmitBtn"
            class="w-full py-3 rounded-xl bg-[var(--text-primary)] text-[var(--bg)] font-semibold text-sm hover:opacity-90 transition cursor-pointer flex items-center justify-center gap-2 shadow-md"
          >
            <span id="loginSpinner" class="hidden animate-spin text-sm">↻</span>
            <span id="loginBtnText"><i class="fa-solid fa-magnifying-glass"></i> Kiểm tra hạn mức</span>
          </button>
        </form>

        <div id="loginErrorBox" class="mt-4 ${errorMsg ? '' : 'hidden'}">
          <div class="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2.5">
            <i class="fa-solid fa-circle-exclamation text-sm"></i>
            <span id="loginErrorText" class="font-medium">${escapeHtmlVal(errorMsg || "API Key không tồn tại hoặc không hợp lệ")}</span>
          </div>
        </div>

        <div class="mt-6 pt-5 border-t border-[var(--border)] flex items-center justify-center gap-5 text-xs text-[var(--text-muted)]">
          <span class="inline-flex items-center gap-1.5 font-medium"><i class="fa-solid fa-bolt text-[11px] text-amber-500"></i> Realtime Quota</span>
          <span>•</span>
          <span class="inline-flex items-center gap-1.5 font-medium"><i class="fa-solid fa-shield-halved text-[11px] text-emerald-400"></i> Zero-Log</span>
        </div>
      </div>
    </main>
  </div>


  <!-- ==================== VIEW 2: KEY DASHBOARD & STATS ==================== -->
  <div id="dashboardView" class="min-h-screen py-6 px-4 md:px-8 relative z-10 ${isFound ? '' : 'hidden'}">
    <div class="max-w-5xl mx-auto space-y-5">

      <!-- Dashboard Header -->
      <header class="flex items-center justify-between pb-3 border-b border-[var(--border)] flex-wrap gap-3">
        <div class="flex items-center gap-3">
          <button type="button" onclick="showLoginView()" class="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--card-inner)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition flex items-center gap-1.5 cursor-pointer font-medium">
            <i class="fa-solid fa-arrow-left"></i>
            <span id="t_back">Tra cứu Key khác</span>
          </button>
          <div class="flex items-center gap-2">
            <img src="/admin/icon.png" alt="Kiro-Go" class="w-6 h-6 object-contain rounded" style="filter: invert(1);" />
            <span class="text-sm font-bold text-[var(--text-primary)]">Kiro-Go</span>
            <span class="text-[var(--text-muted)] text-xs">/</span>
            <span id="dashKeyName" class="text-xs font-semibold text-[var(--text-primary)]">${escapeHtmlVal(keyData?.name || "API Key")}</span>
          </div>
        </div>

        <div class="flex items-center gap-2.5">
          <div id="dashStatusBadge" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${statusBadgeClass}">
            ${statusBadgeText}
          </div>
          <button type="button" onclick="refreshDashboard(true)" id="refreshBtn" title="Tải lại dữ liệu" class="p-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--card-inner)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">
            <i class="fa-solid fa-rotate-right" id="refreshIcon"></i>
          </button>
          <button type="button" onclick="toggleTheme()" class="p-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--card-inner)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">
            <span id="dashThemeIcon">🌙</span>
          </button>
        </div>
      </header>

      <!-- Key Info Banner & 6 Metric Cards -->
      <section class="app-card rounded-xl p-4 shadow-sm space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border)]">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs text-[var(--text-secondary)] font-medium">Masked Key:</span>
            <div class="px-2.5 py-1 rounded-md bg-[var(--input-bg)] border border-[var(--border)] mono text-xs text-[var(--text-primary)] flex items-center gap-2">
              <span id="dashMaskedKey">${escapeHtmlVal(maskApiKey(rawKey))}</span>
              <button type="button" onclick="copySnippetText(activeKey, this)" class="text-[var(--text-primary)] hover:opacity-70 text-xs underline cursor-pointer">Copy</button>
            </div>
          </div>
          <div class="flex items-center gap-4 text-xs text-[var(--text-secondary)] flex-wrap">
            <div id="dashExpiresAt" class="flex items-center gap-1.5">
              <span>Hạn dùng:</span> <span class="font-semibold text-[var(--text-primary)]" id="m_expiryText">${keyExpiresAt > 0 ? formatTokenExpiry(keyExpiresAt) : 'Vĩnh viễn'}</span>
            </div>
            <div id="dashLastUsed" class="flex items-center gap-1.5">
              <span>Hoạt động gần nhất:</span> <span class="text-[var(--text-primary)] font-medium">${keyData?.lastUsedUnix ? formatRelativeTime(keyData.lastUsedUnix) : 'Chưa gọi request nào'}</span>
            </div>
          </div>
        </div>

        <!-- 6 Metric Cards (Clean Monochrome) -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <!-- 1. Requests -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Requests</span>
            </div>
            <div class="text-xl font-bold text-[var(--text-primary)] mono leading-tight" id="m_requests">${requestsCount.toLocaleString()}</div>
            <p class="text-[10px] text-[var(--text-muted)] truncate">Tổng lượt gọi</p>
          </div>

          <!-- 2. Token In -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Tokens In</span>
            </div>
            <div class="text-xl font-bold text-[var(--text-primary)] mono leading-tight" id="m_tokensIn">${tokensIn.toLocaleString()}</div>
            <p class="text-[10px] text-[var(--text-muted)] truncate">Prompt / Context</p>
          </div>

          <!-- 3. Token Out -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Tokens Out</span>
            </div>
            <div class="text-xl font-bold text-[var(--text-primary)] mono leading-tight" id="m_tokensOut">${tokensOut.toLocaleString()}</div>
            <p class="text-[10px] text-[var(--text-muted)] truncate">Completion</p>
          </div>

          <!-- 4. Total Tokens -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Tổng Tokens</span>
              <span class="text-[10px] text-[var(--text-muted)] mono" id="m_tokenPct">${tokenLimit > 0 ? `${tokenPct}%` : "∞"}</span>
            </div>
            <div class="text-xl font-bold text-[var(--text-primary)] mono leading-tight" id="m_tokensUsed">${tokensUsed.toLocaleString()}</div>
            <p class="text-[10px] text-[var(--text-muted)] truncate" id="m_tokenLimitDesc">${tokenLimit > 0 ? `Còn ${Math.max(0, tokenLimit - tokensUsed).toLocaleString()}` : "Không giới hạn"}</p>
          </div>

          <!-- 5. Credits Balance -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider truncate" title="Quota / Credits">Credits</span>
              <span class="text-[10px] text-[var(--text-muted)] mono whitespace-nowrap" id="m_creditPct">${creditLimit > 0 ? `${creditPct}% used` : "∞"}</span>
            </div>
            <div class="text-xl font-bold text-[var(--text-primary)] mono leading-tight" id="m_credits">${remainingCreditsNum !== null ? `${remainingCreditsNum.toFixed(2)} Cr` : "Unlimited"}</div>
            <p class="text-[10px] text-[var(--text-muted)] truncate" id="m_creditLimitDesc" title="${creditLimit > 0 ? `Đã dùng: ${creditsUsed.toFixed(4)} / ${creditLimit} Cr` : ''}">${creditLimit > 0 ? `Đã dùng: ${creditsUsed >= 1000 ? Math.round(creditsUsed).toLocaleString() : creditsUsed.toFixed(1)} / ${creditLimit.toLocaleString()} Cr` : (creditsUsed > 0 ? `Đã dùng ${creditsUsed.toFixed(2)} Cr` : "Không giới hạn")}</p>
          </div>

          <!-- 6. Hạn sử dụng (Expiry Time) -->
          <div class="app-card-inner rounded-lg p-3 flex flex-col justify-between min-h-[96px]">
            <div class="flex items-center justify-between h-4">
              <span class="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Hạn dùng Key</span>
            </div>
            <div class="text-base font-bold leading-tight ${isKeyExpired ? 'text-rose-400' : 'text-emerald-400'}" id="m_expiryCard">
              ${keyExpiresAt > 0 ? formatTokenExpiry(keyExpiresAt) : 'Vĩnh viễn'}
            </div>
            <p class="text-[10px] text-[var(--text-muted)] truncate" id="m_expiryDateDesc" title="${keyExpiresAt > 0 ? formatDateTime(keyExpiresAt) : ''}">${keyExpiresAt > 0 ? formatDateTime(keyExpiresAt) : 'Không giới hạn ngày'}</p>
          </div>
        </div>

        <!-- Quota Progress Bar Card (Slim & Elegant) -->
        <div id="quotaProgressSection" class="app-card-inner rounded-xl p-3.5 space-y-2 border border-[var(--border)] mt-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <span class="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
              <i class="fa-solid fa-gauge-high text-xs text-emerald-400" id="quotaProgressIcon"></i>
              <span id="quotaProgressTitle">Tiến độ hạn mức Quota (Credits / Tokens)</span>
            </span>
            <span class="font-mono text-xs font-bold text-emerald-400" id="quotaProgressVal">100% Available</span>
          </div>
          <div class="w-full h-2 rounded-full bg-[var(--card)] border border-[var(--border)] overflow-hidden">
            <div id="quotaProgressBar" class="h-full rounded-full transition-all duration-500 bg-emerald-500 shadow-sm" style="width: 100%;"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-[var(--text-muted)] flex-wrap gap-1">
            <span id="quotaProgressHint" class="flex items-center gap-1">🟢 Đang hoạt động bình thường</span>
            <span id="quotaRemainingDesc" class="font-mono">Không giới hạn</span>
          </div>
        </div>
      </section>

      <!-- SECTION 2: RECENT REQUESTS TABLE (DIRECTLY UNDER QUOTA PROGRESS BAR WITH PAGINATION) -->
      <section class="app-card rounded-xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
              <i class="fa-solid fa-list-check text-xs text-[var(--text-primary)]"></i>
              <span>Lịch sử Requests gần nhất</span>
            </h3>
            <span class="px-2 py-0.5 rounded text-[10px] bg-[var(--badge-bg)] text-[var(--text-secondary)] font-mono border border-[var(--badge-border)]" id="logsCountBadge">0 reqs</span>
            <span id="liveSyncLabel" class="text-[10px] font-mono text-[var(--text-muted)]">Live · đang đồng bộ...</span>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <label class="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
              <span>Hiển thị:</span>
              <select id="logsPageSize" onchange="changeLogsPageSize(this.value)" class="bg-[var(--card-inner)] border border-[var(--border)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none cursor-pointer">
                <option value="10">10 / trang</option>
                <option value="20" selected>20 / trang</option>
                <option value="50">50 / trang</option>
                <option value="100">100 / trang</option>
              </select>
            </label>
          </div>
        </div>

        <div class="overflow-x-auto border border-[var(--border)] rounded-lg">
          <table class="w-full border-collapse">
            <thead>
              <tr class="bg-[var(--table-head)] border-b border-[var(--border)] text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                <th class="py-2.5 px-4 text-left whitespace-nowrap">Thời gian</th>
                <th class="py-2.5 px-4 text-left whitespace-nowrap">Model</th>
                <th class="py-2.5 px-3 text-center whitespace-nowrap">Giao thức</th>
                <th class="py-2.5 px-4 text-right whitespace-nowrap">Tokens (In / Out)</th>
                <th class="py-2.5 px-4 text-right whitespace-nowrap">Tổng Tokens</th>
                <th class="py-2.5 px-4 text-right whitespace-nowrap">Credits</th>
                <th class="py-2.5 px-4 text-right whitespace-nowrap">Độ trễ</th>
                <th class="py-2.5 px-4 text-center whitespace-nowrap">Trạng thái</th>
              </tr>
            </thead>
            <tbody id="dashLogsTableBody">
              <tr>
                <td colspan="8" class="py-8 text-center text-xs text-[var(--text-muted)]">
                  Chưa có dữ liệu request nào được ghi nhận cho API key này.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination Controls -->
        <div id="logsPaginationBar" class="flex items-center justify-between pt-2 text-xs text-[var(--text-secondary)] flex-wrap gap-2">
          <span id="logsPaginationInfo" class="text-[11px] text-[var(--text-muted)]">Hiển thị 0 - 0 trên tổng số 0</span>
          <div class="flex items-center gap-1.5">
            <button type="button" id="btnPrevPage" onclick="prevLogsPage()" class="px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--card-inner)] text-[var(--text-primary)] hover:border-[var(--border-hover)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition text-xs flex items-center gap-1 font-medium">
              <i class="fa-solid fa-chevron-left text-[10px]"></i> Trước
            </button>
            <span id="logsPageIndicator" class="px-2.5 py-1 rounded-md bg-[var(--card)] border border-[var(--border)] font-mono text-[11px]">Trang 1 / 1</span>
            <button type="button" id="btnNextPage" onclick="nextLogsPage()" class="px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--card-inner)] text-[var(--text-primary)] hover:border-[var(--border-hover)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition text-xs flex items-center gap-1 font-medium">
              Sau <i class="fa-solid fa-chevron-right text-[10px]"></i>
            </button>
          </div>
        </div>
      </section>

      <!-- SECTION 3: QUICK INTEGRATION SNIPPETS -->
      <section class="app-card rounded-xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
            <i class="fa-solid fa-code text-xs text-[var(--text-primary)]"></i>
            <span>Hướng dẫn kết nối nhanh (Quick Setup)</span>
          </h3>
          <div class="flex items-center gap-1 flex-wrap">
            <button type="button" onclick="switchTab('curl')" class="tab-btn active text-xs px-2.5 py-1 rounded-md border border-[var(--border)]" data-tab="curl">cURL</button>
            <button type="button" onclick="switchTab('claude')" class="tab-btn text-xs px-2.5 py-1 rounded-md border border-[var(--border)]" data-tab="claude">Claude Code</button>
            <button type="button" onclick="switchTab('cursor')" class="tab-btn text-xs px-2.5 py-1 rounded-md border border-[var(--border)]" data-tab="cursor">Cursor</button>
            <button type="button" onclick="switchTab('hermes')" class="tab-btn text-xs px-2.5 py-1 rounded-md border border-[var(--border)]" data-tab="hermes">Hermes Agent</button>
            <button type="button" onclick="switchTab('openai')" class="tab-btn text-xs px-2.5 py-1 rounded-md border border-[var(--border)]" data-tab="openai">OpenAI SDK</button>
          </div>
        </div>

        <div id="tab-curl" class="tab-pane active space-y-2">
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Terminal cURL command</span>
            <button type="button" onclick="copySnippetById('snippet-curl', this)" class="px-2.5 py-1 rounded bg-[var(--text-primary)] text-[var(--bg)] font-medium text-xs cursor-pointer hover:opacity-80 transition">Copy</button>
          </div>
          <pre id="snippet-curl" class="bg-[var(--code-bg)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] mono overflow-x-auto select-all">curl -X POST "${origin}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${rawKey || 'kpp_...'}" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "${DEFAULT_MODEL}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello!"}]}'</pre>
        </div>

        <div id="tab-claude" class="tab-pane space-y-2">
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Claude Code CLI Environment Setup</span>
            <button type="button" onclick="copySnippetById('snippet-claude', this)" class="px-2.5 py-1 rounded bg-[var(--text-primary)] text-[var(--bg)] font-medium text-xs cursor-pointer hover:opacity-80 transition">Copy</button>
          </div>
          <pre id="snippet-claude" class="bg-[var(--code-bg)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] mono overflow-x-auto select-all">export ANTHROPIC_BASE_URL="${origin}/v1"
export ANTHROPIC_API_KEY="${rawKey || 'kpp_...'}"
claude</pre>
        </div>

        <div id="tab-cursor" class="tab-pane space-y-2">
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Cursor IDE Settings (Anthropic / OpenAI API)</span>
            <button type="button" onclick="copySnippetById('snippet-cursor', this)" class="px-2.5 py-1 rounded bg-[var(--text-primary)] text-[var(--bg)] font-medium text-xs cursor-pointer hover:opacity-80 transition">Copy</button>
          </div>
          <pre id="snippet-cursor" class="bg-[var(--code-bg)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] mono overflow-x-auto select-all">Base URL: ${origin}/v1
API Key:  ${rawKey || 'kpp_...'}
Models:   claude-opus-5, claude-opus-4.8, claude-opus-4.7, claude-sonnet-5</pre>
        </div>

        <div id="tab-hermes" class="tab-pane space-y-2">
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Hermes Agent config.yaml Provider Entry</span>
            <button type="button" onclick="copySnippetById('snippet-hermes', this)" class="px-2.5 py-1 rounded bg-[var(--text-primary)] text-[var(--bg)] font-medium text-xs cursor-pointer hover:opacity-80 transition">Copy</button>
          </div>
          <pre id="snippet-hermes" class="bg-[var(--code-bg)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] mono overflow-x-auto select-all">model: custom/${DEFAULT_MODEL}
providers:
  custom:
    base_url: "${origin}/v1"
    api_key: "${rawKey || 'kpp_...'}"
    api_mode: "chat_completions"</pre>
        </div>

        <div id="tab-openai" class="tab-pane space-y-2">
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Python OpenAI SDK Example</span>
            <button type="button" onclick="copySnippetById('snippet-openai', this)" class="px-2.5 py-1 rounded bg-[var(--text-primary)] text-[var(--bg)] font-medium text-xs cursor-pointer hover:opacity-80 transition">Copy</button>
          </div>
          <pre id="snippet-openai" class="bg-[var(--code-bg)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] mono overflow-x-auto select-all">from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",
    api_key="${rawKey || 'kpp_...'}"
)

response = client.chat.completions.create(
    model="${DEFAULT_MODEL}",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)</pre>
        </div>
      </section>

    </div>
  </div>

  <!-- Toast Container -->
  <div id="toastContainer" class="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none"></div>

  <script>
    var serverOrigin = "${origin}";
    var activeKey = "${keyVal}";
    var initialData = ${keyDataJson};
    var initialLogs = ${JSON.stringify(keyLogs || []).replace(/</g, "\\u003c")};
    var currentLogsList = ${JSON.stringify(keyLogs || []).replace(/</g, "\\u003c")};
    var autoRefreshTimer = null;

    // Pagination State
    var logsCurrentPage = 1;
    var logsPageSize = 20;
    var AUTO_REFRESH_MS = 5000;
    var isThinkingModeActive = false;

    var I18N = {
      vi: {
        title: "Tra cứu API Key",
        subtitle: "Kiểm tra hạn mức Quota, số lượng requests, token và lịch sử gọi API.",
        labelKey: "API Key Khách hàng",
        remember: "Ghi nhớ key trên trình duyệt",
        btnInspect: "Kiểm tra hạn mức",
        btnChecking: "Đang kiểm tra...",
        back: "Tra cứu Key khác",
        errNotFound: "API Key không tồn tại hoặc không hợp lệ. Vui lòng kiểm tra lại."
      },
      en: {
        title: "Tra cứu API Key",
        subtitle: "Check quota balance, request counts, tokens, and live API history.",
        labelKey: "Client API Key",
        remember: "Remember key on this browser",
        btnInspect: "Inspect Key",
        btnChecking: "Checking...",
        back: "Check Another Key",
        errNotFound: "API Key not found or unrecognized. Please check and try again."
      },
      zh: {
        title: "API Key 额度查询",
        subtitle: "实时查询 API Key 余额额度、请求次数、Token 消耗及调用日志。",
        labelKey: "客户端 API Key",
        remember: "在此浏览器上记住 Key",
        btnInspect: "查询额度",
        btnChecking: "正在查询...",
        back: "查询其他 Key",
        errNotFound: "API Key 不存在或无效，请核对后重试。"
      }
    };
    var currentLang = localStorage.getItem("kiro_lang") || "vi";

    function safeSetText(id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    }

    function safeSetHtml(id, html) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }

    function formatTokenExpiry(ts) {
      if (!ts || ts <= 0) return "Vĩnh viễn";
      var now = Math.floor(Date.now() / 1000);
      var diff = ts - now;
      if (diff <= 0) return "🔴 Đã hết hạn";
      if (diff < 3600) return "Còn " + Math.floor(diff / 60) + " phút";
      if (diff < 86400) return "Còn " + Math.floor(diff / 3600) + " giờ";
      var days = Math.floor(diff / 86400);
      var hours = Math.floor((diff % 86400) / 3600);
      return "Còn " + days + " ngày" + (hours > 0 ? (" " + hours + "h") : "");
    }

    function formatDateTime(unixSeconds) {
      if (!unixSeconds || unixSeconds <= 0) return "Không giới hạn ngày";
      return new Date(unixSeconds * 1000).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour12: false
      });
    }

    document.addEventListener("DOMContentLoaded", function() {
      setLang(currentLang);
      var isDark = document.documentElement.classList.contains("dark");
      updateThemeIcons(isDark);

      if (initialData && activeKey) {
        showDashboardView(initialData, initialLogs);
      } else {
        var saved = localStorage.getItem("kiro_client_key");
        if (saved) {
          var inp = document.getElementById("loginKeyInput");
          if (inp) inp.value = saved;
        }
      }

      // Coming back to the tab should show current numbers without an F5.
      document.addEventListener("visibilitychange", function() {
        if (!document.hidden && activeKey) refreshDashboard(false);
      });
      window.addEventListener("focus", function() {
        if (activeKey) refreshDashboard(false);
      });
    });

    function setLang(lang) {
      if (!I18N[lang]) lang = "vi";
      currentLang = lang;
      localStorage.setItem("kiro_lang", lang);
      var t = I18N[lang];
      safeSetText("t_title", t.title);
      safeSetText("t_subtitle", t.subtitle);
      safeSetText("t_labelKey", t.labelKey);
      safeSetText("t_remember", t.remember);
      safeSetHtml("loginBtnText", '<i class="fa-solid fa-magnifying-glass"></i> ' + t.btnInspect);
      safeSetText("t_back", t.back);

      ["vi", "en", "zh"].forEach(function(l) {
        var btn = document.getElementById("langBtn" + l.charAt(0).toUpperCase() + l.slice(1));
        if (btn) {
          if (l === lang) {
            btn.className = "px-2.5 py-1 rounded-md font-semibold text-[var(--text-primary)] bg-[var(--badge-bg)] cursor-pointer";
          } else {
            btn.className = "px-2.5 py-1 rounded-md font-semibold text-[var(--text-secondary)] hover:bg-[var(--badge-bg)] cursor-pointer";
          }
        }
      });
    }

    function toggleTheme() {
      var isDark = document.documentElement.classList.contains("dark");
      if (isDark) {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
        localStorage.setItem("kiro_theme", "light");
        updateThemeIcons(false);
      } else {
        document.documentElement.classList.add("dark");
        document.documentElement.classList.remove("light");
        localStorage.setItem("kiro_theme", "dark");
        updateThemeIcons(true);
      }
    }

    function updateThemeIcons(isDark) {
      var ico1 = document.getElementById("loginThemeIcon");
      var ico2 = document.getElementById("dashThemeIcon");
      if (ico1) ico1.textContent = isDark ? "🌙" : "☀️";
      if (ico2) ico2.textContent = isDark ? "🌙" : "☀️";
    }

    function toggleKeyVisibility() {
      var input = document.getElementById("loginKeyInput");
      var icon = document.getElementById("loginKeyEyeIcon");
      if (!input || !icon) return;
      if (input.type === "password") {
        input.type = "text";
        icon.className = "fa-solid fa-eye-slash text-sm";
      } else {
        input.type = "password";
        icon.className = "fa-solid fa-eye text-sm";
      }
    }

    function setThinkingMode(enabled) {
      isThinkingModeActive = Boolean(enabled);
      var btnStd = document.getElementById("btnModeStandard");
      var btnThk = document.getElementById("btnModeThinking");

      if (btnStd && btnThk) {
        if (isThinkingModeActive) {
          btnThk.className = "px-2.5 py-1 rounded-md font-semibold text-amber-500 bg-[var(--badge-bg)] cursor-pointer transition";
          btnStd.className = "px-2.5 py-1 rounded-md font-semibold text-[var(--text-secondary)] hover:bg-[var(--badge-bg)] cursor-pointer transition";
        } else {
          btnStd.className = "px-2.5 py-1 rounded-md font-semibold text-[var(--text-primary)] bg-[var(--badge-bg)] cursor-pointer transition";
          btnThk.className = "px-2.5 py-1 rounded-md font-semibold text-[var(--text-secondary)] hover:bg-[var(--badge-bg)] cursor-pointer transition";
        }
      }

      // Update all model cards
      document.querySelectorAll(".model-item").forEach(function(item) {
        var baseModel = item.dataset.baseModel;
        var displayEl = item.querySelector(".model-display-id");
        if (displayEl && baseModel) {
          var canThink = baseModel.startsWith("claude-");
          if (isThinkingModeActive && canThink) {
            displayEl.textContent = baseModel + "-thinking";
            displayEl.className = "font-mono font-semibold text-xs text-amber-500 model-display-id";
          } else {
            displayEl.textContent = baseModel;
            displayEl.className = "font-mono font-semibold text-xs text-[var(--text-primary)] model-display-id";
          }
        }
      });

      updateSnippets(activeKey);
    }

    function copyModelById(baseModel, btn) {
      var canThink = baseModel.startsWith("claude-");
      var finalModel = (isThinkingModeActive && canThink) ? (baseModel + "-thinking") : baseModel;
      copySnippetText(finalModel, btn);
    }

    function filterModelCategory(cat) {
      document.querySelectorAll(".cat-btn").forEach(function(b) {
        if (b.dataset.cat === cat) {
          b.className = "cat-btn active px-2 py-0.5 rounded font-medium text-[var(--text-primary)] bg-[var(--badge-bg)] cursor-pointer";
        } else {
          b.className = "cat-btn px-2 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer";
        }
      });
      document.querySelectorAll(".model-item").forEach(function(item) {
        if (cat === "all" || item.dataset.category === cat) {
          item.style.display = "block";
        } else {
          item.style.display = "none";
        }
      });
    }

    async function handleKeyLogin(e) {
      e.preventDefault();
      var input = document.getElementById("loginKeyInput");
      var key = input ? input.value.trim() : "";
      if (!key) return;

      var btn = document.getElementById("loginSubmitBtn");
      var spinner = document.getElementById("loginSpinner");
      var btnText = document.getElementById("loginBtnText");
      var errBox = document.getElementById("loginErrorBox");
      var card = document.getElementById("loginCard");

      if (btn) btn.disabled = true;
      if (spinner) spinner.classList.remove("hidden");
      if (btnText) btnText.textContent = I18N[currentLang].btnChecking;
      if (errBox) errBox.classList.add("hidden");

      try {
        var res = await fetch("/check?key=" + encodeURIComponent(key) + "&format=json&_ts=" + Date.now(), {
          headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
          cache: "no-store"
        });
        var data = await res.json();

        if (!res.ok || !data.success) {
          if (errBox) errBox.classList.remove("hidden");
          safeSetText("loginErrorText", data.message || data.error || I18N[currentLang].errNotFound);
          if (card) {
            card.classList.remove("shake");
            void card.offsetWidth;
            card.classList.add("shake");
          }
          return;
        }

        activeKey = key;
        var rememberEl = document.getElementById("rememberKeyCheck");
        if (rememberEl && rememberEl.checked) {
          localStorage.setItem("kiro_client_key", key);
        } else {
          localStorage.removeItem("kiro_client_key");
        }

        showDashboardView(data, data.recent_logs || []);
        showToast("Đã tải dữ liệu API Key thành công!", "success");
      } catch (err) {
        if (errBox) errBox.classList.remove("hidden");
        safeSetText("loginErrorText", "Lỗi kết nối mạng. Vui lòng thử lại.");
        if (card) {
          card.classList.remove("shake");
          void card.offsetWidth;
          card.classList.add("shake");
        }
      } finally {
        if (btn) btn.disabled = false;
        if (spinner) spinner.classList.add("hidden");
        if (btnText) btnText.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> ' + I18N[currentLang].btnInspect;
      }
    }

    function showLoginView() {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      document.getElementById("dashboardView").classList.add("hidden");
      document.getElementById("loginView").classList.remove("hidden");
      document.title = "Kiro-Go";
    }

    function showDashboardView(data, logs, isRefresh) {
      document.getElementById("loginView").classList.add("hidden");
      document.getElementById("dashboardView").classList.remove("hidden");
      document.title = (data.name || "API Key") + " · Kiro-Go";

      currentLogsList = logs || [];
      // A background refresh must not yank the reader back to page 1.
      if (!isRefresh) logsCurrentPage = 1;

      safeSetText("dashKeyName", data.name || "API Key");
      safeSetText("dashMaskedKey", data.key_masked || maskApiKey(activeKey));

      var statusBadge = document.getElementById("dashStatusBadge");
      var keyExpiresAt = Number(data.expires_at || data.expiresAt || 0);
      var isKeyExpired = keyExpiresAt > 0 && Math.floor(Date.now() / 1000) >= keyExpiresAt;

      if (statusBadge) {
        if (data.status === "disabled" || data.enabled === false) {
          statusBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border bg-rose-500/10 text-rose-400 border-rose-500/20";
          statusBadge.textContent = "● Đã khóa";
        } else if (data.status === "quota_exceeded" || isKeyExpired) {
          statusBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border bg-rose-500/10 text-rose-400 border-rose-500/20";
          statusBadge.textContent = isKeyExpired ? "⚠️ Hết hạn dùng" : "⚠️ Vượt Quota";
        } else {
          statusBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
          statusBadge.textContent = "● Hoạt động";
        }
      }

      var expiryFormatted = formatTokenExpiry(keyExpiresAt);
      safeSetText("m_expiryText", expiryFormatted);
      safeSetText("m_expiryCard", expiryFormatted);
      var expiryCardEl = document.getElementById("m_expiryCard");
      if (expiryCardEl) {
        expiryCardEl.className = "text-base font-bold leading-tight " + (isKeyExpired ? "text-rose-400" : "text-emerald-400");
      }
      var expiryDateStr = keyExpiresAt > 0 ? formatDateTime(keyExpiresAt) : "Không giới hạn ngày";
      safeSetText("m_expiryDateDesc", expiryDateStr);
      var expiryDateEl = document.getElementById("m_expiryDateDesc");
      if (expiryDateEl) expiryDateEl.title = keyExpiresAt > 0 ? expiryDateStr : "";

      if (data.last_used_at) {
        safeSetHtml("dashLastUsed", 'Hoạt động gần nhất: <span class="text-[var(--text-primary)] font-medium">' + formatRelativeTime(data.last_used_at) + '</span>');
      } else {
        safeSetText("dashLastUsed", "Chưa gọi request nào");
      }

      var reqs = Number(data.requests_count) || 0;
      var tokIn = Number(data.tokens_in) || 0;
      var tokOut = Number(data.tokens_out) || 0;
      var tokUsed = Number(data.tokens_used) || (tokIn + tokOut);
      var tokLim = Number(data.token_limit) || 0;
      var credUsed = Number(data.credits_used) || 0;
      var credLim = Number(data.credit_limit) || 0;

      safeSetText("m_requests", reqs.toLocaleString());
      safeSetText("m_tokensIn", tokIn.toLocaleString());
      safeSetText("m_tokensOut", tokOut.toLocaleString());
      safeSetText("m_tokensUsed", tokUsed.toLocaleString());

      if (tokLim > 0) {
        var pct = Math.min(100, Math.round((tokUsed / tokLim) * 100));
        safeSetText("m_tokenPct", pct + "%");
        safeSetText("m_tokenLimitDesc", "Còn " + Math.max(0, tokLim - tokUsed).toLocaleString());
      } else {
        safeSetText("m_tokenPct", "∞");
        safeSetText("m_tokenLimitDesc", "Không giới hạn");
      }

      var descEl = document.getElementById("m_creditLimitDesc");
      if (credLim > 0) {
        var cpct = Math.min(100, Math.round((credUsed / credLim) * 100));
        safeSetText("m_creditPct", cpct + "% used");
        safeSetText("m_credits", Math.max(0, credLim - credUsed).toFixed(2) + " Cr");
        var shortUsed = credUsed >= 1000 ? Math.round(credUsed).toLocaleString() : credUsed.toFixed(1);
        safeSetText("m_creditLimitDesc", "Đã dùng: " + shortUsed + " / " + credLim.toLocaleString() + " Cr");
        if (descEl) descEl.title = "Đã dùng: " + credUsed.toFixed(4) + " / " + credLim + " Cr";
      } else {
        safeSetText("m_creditPct", "∞");
        safeSetText("m_credits", "Unlimited");
        safeSetText("m_creditLimitDesc", credUsed > 0 ? ("Đã dùng " + credUsed.toFixed(2) + " Cr") : "Không giới hạn");
        if (descEl) descEl.title = credUsed > 0 ? ("Đã dùng " + credUsed.toFixed(4) + " Cr") : "";
      }

      // Update Quota Progress Bar Color & Fill
      var isExceeded = (data.status === "quota_exceeded") || isKeyExpired || (credLim > 0 && credUsed >= credLim) || (tokLim > 0 && tokUsed >= tokLim);
      var bar = document.getElementById("quotaProgressBar");
      var barVal = document.getElementById("quotaProgressVal");
      var barHint = document.getElementById("quotaProgressHint");
      var barIcon = document.getElementById("quotaProgressIcon");
      var barRem = document.getElementById("quotaRemainingDesc");

      if (isExceeded) {
        if (bar) {
          bar.style.width = "100%";
          bar.className = "h-full rounded-full transition-all duration-500 bg-rose-500 shadow-sm animate-pulse";
        }
        if (barVal) {
          barVal.className = "font-mono text-xs font-bold text-rose-400";
          barVal.textContent = (credLim > 0 ? (credUsed.toFixed(4) + " / " + credLim + " Cr") : (isKeyExpired ? "Đã hết hạn ngày dùng" : "100% Quota Exceeded")) + " (100% Full Vạch Đỏ)";
        }
        if (barHint) {
          barHint.innerHTML = '<span class="text-rose-400 font-medium flex items-center gap-1"><i class="fa-solid fa-triangle-exclamation"></i> 🔴 ' + (isKeyExpired ? "API Key đã hết hạn sử dụng" : "Đã dùng hết 100% Quota") + '</span>';
        }
        if (barIcon) barIcon.className = "fa-solid fa-triangle-exclamation text-xs text-rose-400";
        if (barRem) barRem.textContent = "0.00 Cr còn lại (Bị khóa 429)";
      } else if (data.status === "disabled" || data.enabled === false) {
        if (bar) {
          bar.style.width = "100%";
          bar.className = "h-full rounded-full transition-all duration-500 bg-zinc-600 shadow-sm";
        }
        if (barVal) {
          barVal.className = "font-mono text-xs font-bold text-rose-400";
          barVal.textContent = "Key đã bị tạm khóa / Vô hiệu hóa";
        }
        if (barHint) {
          barHint.innerHTML = '<span class="text-rose-400 font-medium">⚫ Key đã bị khóa</span>';
        }
        if (barIcon) barIcon.className = "fa-solid fa-ban text-xs text-rose-400";
        if (barRem) barRem.textContent = "Disabled";
      } else if (credLim > 0) {
        var ratio = Math.min(100, Math.round((credUsed / credLim) * 100));
        var displayWidth = Math.max(3, ratio);
        var colorClass = ratio >= 90 ? "bg-rose-500" : (ratio >= 70 ? "bg-amber-500" : "bg-emerald-500");
        var textClass = ratio >= 90 ? "text-rose-400" : (ratio >= 70 ? "text-amber-400" : "text-emerald-400");

        if (bar) {
          bar.style.width = displayWidth + "%";
          bar.className = "h-full rounded-full transition-all duration-500 " + colorClass + " shadow-sm";
        }
        if (barVal) {
          barVal.className = "font-mono text-xs font-bold " + textClass;
          barVal.textContent = credUsed.toFixed(4) + " / " + credLim + " Credits (" + ratio + "%)";
        }
        if (barHint) {
          barHint.innerHTML = ratio >= 90
            ? '<span class="text-rose-400 font-medium">⚠️ Sắp hết hạn mức Quota (' + ratio + '%)</span>'
            : (ratio >= 70 ? '<span class="text-amber-400 font-medium">⚡ Đã dùng ' + ratio + '% Quota</span>' : '<span class="text-emerald-400 font-medium">🟢 Hạn mức khả dụng</span>');
        }
        if (barIcon) barIcon.className = "fa-solid fa-gauge-high text-xs " + textClass;
        if (barRem) barRem.textContent = "Còn lại: " + Math.max(0, credLim - credUsed).toFixed(4) + " Cr";
      } else if (tokLim > 0) {
        var ratioTok = Math.min(100, Math.round((tokUsed / tokLim) * 100));
        var displayWidthTok = Math.max(3, ratioTok);
        var colorClassTok = ratioTok >= 90 ? "bg-rose-500" : (ratioTok >= 70 ? "bg-amber-500" : "bg-emerald-500");
        var textClassTok = ratioTok >= 90 ? "text-rose-400" : (ratioTok >= 70 ? "text-amber-400" : "text-emerald-400");

        if (bar) {
          bar.style.width = displayWidthTok + "%";
          bar.className = "h-full rounded-full transition-all duration-500 " + colorClassTok + " shadow-sm";
        }
        if (barVal) {
          barVal.className = "font-mono text-xs font-bold " + textClassTok;
          barVal.textContent = tokUsed.toLocaleString() + " / " + tokLim.toLocaleString() + " Tokens (" + ratioTok + "%)";
        }
        if (barHint) {
          barHint.innerHTML = '<span class="' + textClassTok + ' font-medium">⚡ Đã dùng ' + ratioTok + '% Tokens</span>';
        }
        if (barIcon) barIcon.className = "fa-solid fa-gauge-high text-xs " + textClassTok;
        if (barRem) barRem.textContent = "Còn lại: " + Math.max(0, tokLim - tokUsed).toLocaleString() + " Tokens";
      } else {
        if (bar) {
          bar.style.width = "100%";
          bar.className = "h-full rounded-full transition-all duration-500 bg-emerald-500 shadow-sm";
        }
        if (barVal) {
          barVal.className = "font-mono text-xs font-bold text-emerald-400";
          barVal.textContent = (credUsed > 0 ? ("Đã dùng " + credUsed.toFixed(4) + " Cr • ") : "") + "Unlimited (100% OK)";
        }
        if (barHint) {
          barHint.innerHTML = '<span class="text-emerald-400 font-medium">🟢 Không giới hạn hạn mức (Unlimited Quota Active)</span>';
        }
        if (barIcon) barIcon.className = "fa-solid fa-gauge-high text-xs text-emerald-400";
        if (barRem) barRem.textContent = "Hạn mức: Không giới hạn";
      }

      updateSnippets(activeKey);
      renderPaginatedLogs();

      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(function() {
        refreshDashboard(false);
      }, AUTO_REFRESH_MS);
    }

    async function refreshDashboard(showSpinner) {
      if (!activeKey) return;
      var icon = document.getElementById("refreshIcon");
      if (showSpinner && icon) icon.classList.add("fa-spin");

      try {
        // The cache buster plus no-store matters: without them the polled JSON
        // could be answered from the browser/edge cache and the balance would
        // only ever move when the user pressed F5.
        var res = await fetch("/check?key=" + encodeURIComponent(activeKey) + "&format=json&_ts=" + Date.now(), {
          headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
          cache: "no-store"
        });
        var data = await res.json();
        if (res.ok && data.success) {
          currentLogsList = data.recent_logs || [];
          showDashboardView(data, currentLogsList, true);
          setLiveIndicator(true);
        } else {
          setLiveIndicator(false);
        }
      } catch (_) {
        setLiveIndicator(false);
      } finally {
        if (showSpinner && icon) icon.classList.remove("fa-spin");
      }
    }

    function setLiveIndicator(ok) {
      var el = document.getElementById("liveSyncLabel");
      if (!el) return;
      var stamp = new Date().toLocaleTimeString();
      el.textContent = ok ? ("Live · cập nhật " + stamp) : ("Mất kết nối · thử lại " + stamp);
      el.className = ok
        ? "text-[10px] font-mono text-emerald-400"
        : "text-[10px] font-mono text-rose-400";
    }

    function changeLogsPageSize(val) {
      logsPageSize = parseInt(val, 10) || 20;
      logsCurrentPage = 1;
      renderPaginatedLogs();
    }

    function prevLogsPage() {
      if (logsCurrentPage > 1) {
        logsCurrentPage--;
        renderPaginatedLogs();
      }
    }

    function nextLogsPage() {
      var totalPages = Math.ceil((currentLogsList || []).length / logsPageSize) || 1;
      if (logsCurrentPage < totalPages) {
        logsCurrentPage++;
        renderPaginatedLogs();
      }
    }

    function renderPaginatedLogs() {
      var logs = currentLogsList || [];
      var total = logs.length;
      var tbody = document.getElementById("dashLogsTableBody");
      var badge = document.getElementById("logsCountBadge");
      var info = document.getElementById("logsPaginationInfo");
      var indicator = document.getElementById("logsPageIndicator");
      var btnPrev = document.getElementById("btnPrevPage");
      var btnNext = document.getElementById("btnNextPage");

      if (badge) badge.textContent = total + " reqs";

      if (!tbody) return;
      if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-xs text-[var(--text-muted)]">Chưa có dữ liệu request nào được ghi nhận cho API key này.</td></tr>';
        if (info) info.textContent = "Hiển thị 0 - 0 trên tổng số 0";
        if (indicator) indicator.textContent = "Trang 1 / 1";
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        return;
      }

      var totalPages = Math.ceil(total / logsPageSize) || 1;
      if (logsCurrentPage > totalPages) logsCurrentPage = totalPages;
      if (logsCurrentPage < 1) logsCurrentPage = 1;

      var startIdx = (logsCurrentPage - 1) * logsPageSize;
      var endIdx = Math.min(startIdx + logsPageSize, total);
      var pageLogs = logs.slice(startIdx, endIdx);

      tbody.innerHTML = pageLogs.map(function(l) {
        // Every field used to fall through to a success default, so an entry
        // recorded as an error still rendered "200 OK". Trust the explicit
        // status/statusCode the gateway writes, and only guess when both absent.
        var code = Number(l.statusCode) || 0;
        var isSuccess;
        if (l.success === false || l.status === "error") isSuccess = false;
        else if (code) isSuccess = code === 200;
        else isSuccess = l.status === "success" || l.status === 200 || l.success === true;
        var codeLabel = isSuccess ? ((code || 200) + " OK") : (code ? String(code) : (l.status || "ERR"));
        var statusBadge = isSuccess
          ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--badge-bg)] text-[var(--text-primary)] border border-[var(--badge-border)]">' + escapeHtmlVal(codeLabel) + '</span>'
          : '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20" title="' + escapeAttrVal(l.error || "") + '">' + escapeHtmlVal(codeLabel) + '</span>';
        var timeUnix = l.timeUnix || l.time || 0;
        var timeStr = timeUnix ? new Date(timeUnix * 1000).toLocaleString() : "—";
        var relTime = timeUnix ? formatRelativeTime(timeUnix) : "—";
        var modelStr = l.model || "${DEFAULT_MODEL}";
        var proto = (l.kind === "anthropic" || l.type === "claude") ? "Anthropic" : "OpenAI";
        // The old fallback to l.tokens kicked in whenever output was
        // legitimately 0 and displayed the in+out total in the output column.
        var inTok = firstFiniteNum(l.inputTokens, l.tokensIn, 0);
        var outTok = firstFiniteNum(l.outputTokens, l.tokensOut, 0);
        var totTok = firstFiniteNum(l.totalTokens, inTok + outTok);
        var estMark = l.tokensEstimated === true ? "~" : "";
        var estTitle = l.tokensEstimated === true
          ? "Upstream reported no usage; these counts are a local estimate"
          : "";
        var latMs = Number(l.latencyMs || l.duration || l.latency || 0);
        var latSec = latMs > 0 ? ((latMs / 1000).toFixed(2) + "s") : "—";
        var latColor = latMs > 0 ? (latMs < 1000 ? "text-emerald-400" : (latMs < 3000 ? "text-amber-400" : "text-[var(--text-secondary)]")) : "text-[var(--text-muted)]";
        var cred = Number(l.credits) || 0;

        return '<tr class="border-b border-[var(--border)] hover:bg-[var(--table-hover)] transition-colors text-xs">' +
          '<td class="py-2.5 px-4 text-left text-[var(--text-secondary)] whitespace-nowrap" title="' + escapeAttrVal(timeStr) + '">' + escapeHtmlVal(relTime) + '</td>' +
          '<td class="py-2.5 px-4 text-left font-mono font-medium text-[var(--text-primary)] whitespace-nowrap">' + escapeHtmlVal(modelStr) + '</td>' +
          '<td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--badge-bg)] text-[var(--text-secondary)] border border-[var(--badge-border)]">' + proto + '</span></td>' +
          '<td class="py-2.5 px-4 text-right font-mono tabular-nums text-[var(--text-secondary)] whitespace-nowrap" title="' + escapeAttrVal(estTitle) + '"><span class="text-[var(--text-primary)]">' + estMark + inTok.toLocaleString() + '</span> <span class="text-[var(--text-muted)]">/</span> <span class="text-[var(--text-secondary)]">' + estMark + outTok.toLocaleString() + '</span></td>' +
          '<td class="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-[var(--text-primary)] whitespace-nowrap">' + estMark + totTok.toLocaleString() + '</td>' +
          '<td class="py-2.5 px-4 text-right font-mono tabular-nums whitespace-nowrap">' + (cred > 0 ? (cred.toFixed(4) + ' Cr') : '—') + '</td>' +
          '<td class="py-2.5 px-4 text-right font-mono tabular-nums whitespace-nowrap ' + latColor + '">' + latSec + '</td>' +
          '<td class="py-2.5 px-4 text-center whitespace-nowrap">' + statusBadge + '</td>' +
          '</tr>';
      }).join("");

      if (info) info.textContent = "Hiển thị " + (startIdx + 1) + " - " + endIdx + " trên tổng số " + total;
      if (indicator) indicator.textContent = "Trang " + logsCurrentPage + " / " + totalPages;
      if (btnPrev) btnPrev.disabled = (logsCurrentPage <= 1);
      if (btnNext) btnNext.disabled = (logsCurrentPage >= totalPages);
    }

    function switchTab(tabId) {
      document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.toggle("active", b.dataset.tab === tabId); });
      document.querySelectorAll(".tab-pane").forEach(function(p) { p.classList.toggle("active", p.id === "tab-" + tabId); });
    }

    function updateSnippets(key) {
      var k = key || "kpp_...";
      var sq = String.fromCharCode(39);
      var bs = String.fromCharCode(92);
      var nl = String.fromCharCode(10);
      var modelName = isThinkingModeActive ? "${DEFAULT_MODEL}-thinking" : "${DEFAULT_MODEL}";

      var curl = document.getElementById("snippet-curl");
      if (curl) {
        curl.textContent = [
          'curl -X POST "' + serverOrigin + '/v1/messages" ' + bs,
          '  -H "Content-Type: application/json" ' + bs,
          '  -H "x-api-key: ' + k + '" ' + bs,
          '  -H "anthropic-version: 2023-06-01" ' + bs,
          '  -d ' + sq + '{"model": "' + modelName + '", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello!"}]}' + sq
        ].join(nl);
      }

      var claude = document.getElementById("snippet-claude");
      if (claude) {
        claude.textContent = [
          'export ANTHROPIC_BASE_URL="' + serverOrigin + '/v1"',
          'export ANTHROPIC_API_KEY="' + k + '"',
          'claude'
        ].join(nl);
      }

      var cursor = document.getElementById("snippet-cursor");
      if (cursor) {
        cursor.textContent = [
          'Base URL: ' + serverOrigin + '/v1',
          'API Key:  ' + k,
          'Models:   ' + (isThinkingModeActive ? 'claude-opus-5-thinking, claude-opus-4.8-thinking, claude-opus-4.7-thinking, claude-sonnet-5-thinking' : 'claude-opus-5, claude-opus-4.8, claude-opus-4.7, claude-sonnet-5')
        ].join(nl);
      }

      var hermes = document.getElementById("snippet-hermes");
      if (hermes) {
        hermes.textContent = [
          'model: custom/' + modelName,
          'providers:',
          '  custom:',
          '    base_url: "' + serverOrigin + '/v1"',
          '    api_key: "' + k + '"',
          '    api_mode: "chat_completions"'
        ].join(nl);
      }

      var openai = document.getElementById("snippet-openai");
      if (openai) {
        openai.textContent = [
          'from openai import OpenAI',
          '',
          'client = OpenAI(',
          '    base_url="' + serverOrigin + '/v1",',
          '    api_key="' + k + '"',
          ')',
          '',
          'response = client.chat.completions.create(',
          '    model="' + modelName + '",',
          '    messages=[{"role": "user", "content": "Hello!"}]',
          ')',
          'print(response.choices[0].message.content)'
        ].join(nl);
      }
    }

    function copySnippetById(elementId, btn) {
      var el = document.getElementById(elementId);
      if (el) copySnippetText(el.innerText || el.textContent, btn);
    }

    async function copySnippetText(text, btn) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        if (btn) {
          var oldText = btn.innerHTML;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
          setTimeout(function() { btn.innerHTML = oldText; }, 2000);
        }
        showToast("Đã sao chép vào clipboard!", "success");
      } catch (_) {
        showToast("Không thể sao chép tự động", "error");
      }
    }

    function showToast(msg, type) {
      if (!type) type = "info";
      var container = document.getElementById("toastContainer");
      if (!container) return;
      var toast = document.createElement("div");
      toast.className = "px-4 py-2.5 rounded-lg text-xs font-medium shadow-lg border transition-all transform translate-y-2 opacity-0 flex items-center gap-2 pointer-events-auto " +
        (type === "success" ? "bg-emerald-500 text-white border-emerald-600" : (type === "error" ? "bg-rose-500 text-white border-rose-600" : "bg-[var(--card)] text-[var(--text-primary)] border-[var(--border)]"));
      toast.innerHTML = (type === "success" ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-circle-info"></i>') + ' <span>' + msg + '</span>';
      container.appendChild(toast);
      setTimeout(function() { toast.classList.remove("translate-y-2", "opacity-0"); }, 10);
      setTimeout(function() {
        toast.classList.add("opacity-0", "translate-y-2");
        setTimeout(function() { toast.remove(); }, 300);
      }, 2500);
    }

    function formatRelativeTime(unix) {
      if (!unix || unix <= 0) return "Chưa hoạt động";
      var now = Math.floor(Date.now() / 1000);
      var diff = now - unix;
      if (diff < 10) return "Vừa xong";
      if (diff < 60) return diff + "s trước";
      if (diff < 3600) return Math.floor(diff / 60) + "m trước";
      if (diff < 86400) return Math.floor(diff / 3600) + "h trước";
      return new Date(unix * 1000).toLocaleDateString();
    }

    function maskApiKey(key) {
      if (!key) return "—";
      var s = String(key).trim();
      if (s.length <= 12) return s.slice(0, 4) + "••••" + s.slice(-2);
      return s.slice(0, 8) + "••••••••" + s.slice(-4);
    }

    function escapeHtmlVal(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function escapeAttrVal(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Picks the first argument that is an actual number, treating 0 as a real
    // value. The old "a || b || 0" chain silently skipped legitimate zeros.
    function firstFiniteNum() {
      for (var i = 0; i < arguments.length; i++) {
        var n = Number(arguments[i]);
        if (arguments[i] !== null && arguments[i] !== undefined && arguments[i] !== "" && isFinite(n)) return n;
      }
      return 0;
    }
  </script>
</body>
</html>`;
}

// ==================== Client Setup Scripts ====================

function serveSetupClientScript(origin) {
  const script = `#!/bin/bash
# setup-client.sh — Zero-login client setup for KiroPool
set -euo pipefail
KIRO="\${KIRO_CLI:-kiro-cli}"
case "$(uname -s)" in
    Darwin) DB="\${KIRO_DATA_DIR:-\$HOME/Library/Application Support/kiro-cli}/data.sqlite3" ;;
    *)      DB="\${KIRO_DATA_DIR:-\${XDG_DATA_HOME:-\$HOME/.local/share}/kiro-cli}/data.sqlite3" ;;
esac
command -v "$KIRO" >/dev/null 2>&1 || { echo "❌ kiro-cli not found (set KIRO_CLI=/path)"; exit 1; }
if [ "\${1:-}" == "--reset" ]; then
    "$KIRO" settings -d api.krs.service 2>/dev/null || true
    "$KIRO" settings -d api.cps.service 2>/dev/null || true
    "$KIRO" settings -d api.codewhisperer.service 2>/dev/null || true
    echo "✅ Endpoints reset."
    exit 0
fi
PROXY="\${1:-${origin}}"
REGION="\${2:-us-east-1}"
APIKEY="\${3:-POOL_PLACEHOLDER}"
VAL="{\\"endpoint\\":\\"$PROXY\\",\\"region\\":\\"$REGION\\"}"
echo "[1/3] Pointing kiro-cli to proxy: $PROXY"
"$KIRO" settings api.krs.service "$VAL"
"$KIRO" settings api.cps.service "$VAL"
"$KIRO" settings api.codewhisperer.service "$VAL"
echo "✅ Configured successfully! Run 'kiro-cli chat'"
`;
  return new Response(script, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8", ...corsHeaders() },
  });
}

function serveSetEndpointsScript(origin) {
  const script = `#!/bin/bash
set -e
KIRO="\${KIRO_CLI:-kiro-cli}"
REGION="\${2:-us-east-1}"
PROXY="\${1:-${origin}}"
VAL="{\\"endpoint\\":\\"$PROXY\\",\\"region\\":\\"$REGION\\"}"
"$KIRO" settings api.krs.service "$VAL"
"$KIRO" settings api.cps.service "$VAL"
"$KIRO" settings api.codewhisperer.service "$VAL"
echo "✅ Done. Verify with: $KIRO settings api.krs.service"
`;
  return new Response(script, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8", ...corsHeaders() },
  });
}

function serveSetupClientPs1(origin) {
  const script = `<# setup-client.ps1 for Windows #>
param([string]$Proxy = "${origin}", [string]$Region = "us-east-1", [string]$ApiKey = "POOL_PLACEHOLDER", [switch]$Reset)
$ErrorActionPreference = "Stop"
$Kiro = if ($env:KIRO_CLI) { $env:KIRO_CLI } else { "kiro-cli" }
if ($Reset) {
    & $Kiro settings -d api.krs.service 2>$null
    & $Kiro settings -d api.cps.service 2>$null
    & $Kiro settings -d api.codewhisperer.service 2>$null
    Write-Host "✅ Endpoints reset."
    exit 0
}
$Val = "{\`"endpoint\`":\`"$Proxy\`",\`"region\`":\`"$Region\`"}"
& $Kiro settings api.krs.service $Val
& $Kiro settings api.cps.service $Val
& $Kiro settings api.codewhisperer.service $Val
Write-Host "✅ Configured successfully! Run 'kiro-cli chat'"
`;
  return new Response(script, {
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
  });
}

async function handleModels(env, cors) {
  // config:models is populated from the upstream ListAvailableModels call, which
  // only returns base ids. Union it with FALLBACK_MODELS so the "-thinking"
  // variants (Opus 5 / 4.8 / 4.7, Sonnet 5) are always advertised, and filter to
  // the published catalog so retired Claude 4.6 / 4.5 / 3.x and the
  // GLM / DeepSeek / Qwen / MiniMax ids can never leak back in from KV.
  const models = await getKV(env, "config:models", null);
  const allowedSet = new Set(FALLBACK_MODELS);
  const synced = [];
  const syncedById = new Map();
  if (Array.isArray(models)) {
    for (const model of models) {
      const id = typeof model === "string" ? model : (model?.modelId || model?.id);
      if (!id) continue;
      synced.push(id);
      syncedById.set(id, model);
    }
  }

  const list = [];
  for (const id of [...FALLBACK_MODELS, ...synced]) {
    if (!allowedSet.has(id) || list.includes(id)) continue;
    list.push(id);
  }

  const data = list.map((id) => {
    const entry = {
      id,
      object: "model",
      created: 1700000000,
      owned_by: "kiro",
      permission: [],
      root: id,
      parent: null,
    };
    const base = id.endsWith(THINKING_SUFFIX) ? id.slice(0, -THINKING_SUFFIX.length) : id;
    const modelInfo = syncedById.get(id) || syncedById.get(base) || null;
    // Publish the same value under the aliases different clients read. A real
    // upstream limit wins; otherwise contextWindowForModel intentionally uses a
    // conservative Kiro-runtime fallback so clients compact before rejection.
    const window = contextWindowForModel(id, modelInfo);
    if (window) {
      entry.context_window = window;
      entry.context_length = window;
      entry.max_input_tokens = window;
    }
    const tokenLimits = normalizeTokenLimits(modelInfo);
    if (tokenLimits?.maxOutputTokens > 0) {
      entry.max_output_tokens = tokenLimits.maxOutputTokens;
      entry.max_tokens = tokenLimits.maxOutputTokens;
    }
    return entry;
  });
  return jsonResponse({ object: "list", data }, 200, cors);
}
