//
// Run:  node --test cloudflare/model_throttle.test.mjs
//
// Symptom these all share: Kiro reports a throttled premium model as
// 400 ValidationException with reason INVALID_MODEL_ID instead of 429
// ThrottlingException. 400 tells a client its request was malformed and must not
// be retried, so a throttle that clears in under a second became a hard failure
// and Opus was unusable under any concurrency. Measured against the live
// gateway: a burst of ten concurrent Opus 5 calls lost roughly a third this way
// while the same burst on gpt-5.6-* lost none, the identical request succeeded on
// an immediate retry, and the same calls spaced 20s apart never failed at all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-throttle-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  isTransientModelRejection, normalizeUpstreamFailure,
  fetchWithModelRetry, callKiroWithModelRetry,
  KiroUpstreamException, mapKiroModel,
  MODEL_REJECTION_BACKOFF_MS, RETRYABLE_STATUSES,
  shouldTryNextAccount,
};
`);
  return (await import(file)).__internals;
}

const W = await loadWorker();

const THROTTLE_BODY = JSON.stringify({
  message: "Invalid model. Please select a different model to continue.",
  reason: "INVALID_MODEL_ID",
});

const GENUINE_VALIDATION_BODY = JSON.stringify({
  __type: "com.amazon.kiro.runtimeservice#ValidationException",
  message: "Improperly formed request.",
  reason: "REQUEST_BODY_INVALID",
});

const API_KEY_CREDENTIAL = { authMethod: "api_key", kiroApiKey: "ksk_test", region: "us-east-1" };

function successfulEventStream(text = "ok") {
  const enc = new TextEncoder();
  const payload = enc.encode(JSON.stringify({ content: text }));
  const name = enc.encode(":event-type");
  const value = enc.encode("assistantResponseEvent");
  const header = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  let h = 0;
  header[h++] = name.length;
  header.set(name, h); h += name.length;
  header[h++] = 7;
  header[h++] = (value.length >> 8) & 0xff;
  header[h++] = value.length & 0xff;
  header.set(value, h);

  const totalLen = 12 + header.length + payload.length + 4;
  const frame = new Uint8Array(totalLen);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLen, false);
  view.setUint32(4, header.length, false);
  view.setUint32(8, 0, false);
  frame.set(header, 12);
  frame.set(payload, 12 + header.length);
  view.setUint32(totalLen - 4, 0, false);
  return frame;
}

// Replaces fetch with a scripted queue of responses and collapses the retry
// sleeps, so the ramp is exercised without the test waiting it out.
function withStubbedUpstream(responses, body) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;

  let calls = 0;
  globalThis.fetch = async () => {
    const spec = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return new Response(spec.body ?? "", { status: spec.status });
  };
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };

  return body(() => calls).finally(() => {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  });
}

// ------------------------------------------------------- failure classification

test("INVALID_MODEL_ID on a 400 is read as a throttle", () => {
  assert.equal(W.isTransientModelRejection(400, THROTTLE_BODY), true);
});

test("the prose form alone is enough, the reason code may be absent", () => {
  assert.equal(
    W.isTransientModelRejection(400, `{"message":"Invalid model. Please select a different model to continue."}`),
    true,
  );
});

test("a genuinely malformed request is not a throttle", () => {
  assert.equal(W.isTransientModelRejection(400, GENUINE_VALIDATION_BODY), false);
});

test("only a 400 qualifies, so other statuses keep their own handling", () => {
  assert.equal(W.isTransientModelRejection(500, THROTTLE_BODY), false);
  assert.equal(W.isTransientModelRejection(429, THROTTLE_BODY), false);
});

// ------------------------------------------------------------- retry behaviour

test("a throttled model recovers on a retry against the same account", async () => {
  await withStubbedUpstream(
    [
      { status: 400, body: THROTTLE_BODY },
      { status: 400, body: THROTTLE_BODY },
      { status: 200, body: successfulEventStream("ok") },
    ],
    async (callCount) => {
      const resp = await W.callKiroWithModelRetry(API_KEY_CREDENTIAL, {});
      assert.equal(resp.status, 200);
      assert.equal(callCount(), 3, "expected two throttled attempts then a success");
    },
  );
});

test("an empty HTTP-200 stream recovers on the same model before fallback", async () => {
  await withStubbedUpstream(
    [
      { status: 200, body: successfulEventStream("") },
      { status: 200, body: successfulEventStream("") },
      { status: 200, body: successfulEventStream("recovered") },
    ],
    async (callCount) => {
      const resp = await W.callKiroWithModelRetry(API_KEY_CREDENTIAL, {});
      assert.equal(resp.status, 200);
      assert.equal(callCount(), 3, "two empty streams should be retried on the same model");
      assert.ok((await resp.arrayBuffer()).byteLength > 0, "productive response remains readable");
    },
  );
});

test("the retry is bounded by the backoff ramp", async () => {
  await withStubbedUpstream([{ status: 400, body: THROTTLE_BODY }], async (callCount) => {
    const resp = await W.callKiroWithModelRetry(API_KEY_CREDENTIAL, {});
    assert.equal(resp.status, 400);
    assert.equal(callCount(), 1 + W.MODEL_REJECTION_BACKOFF_MS.length);
  });
});

test("a malformed request is attempted once and its body stays readable", async () => {
  await withStubbedUpstream([{ status: 400, body: GENUINE_VALIDATION_BODY }], async (callCount) => {
    const resp = await W.callKiroWithModelRetry(API_KEY_CREDENTIAL, {});
    assert.equal(resp.status, 400);
    assert.equal(callCount(), 1, "retrying a malformed request only delays the answer");

    // The classification step consumes the body; the caller still has to read it.
    assert.equal(await resp.text(), GENUINE_VALIDATION_BODY);
  });
});

test("a non-400 failure is handed back untouched for the existing paths", async () => {
  await withStubbedUpstream([{ status: 503, body: "unavailable" }], async (callCount) => {
    const resp = await W.callKiroWithModelRetry(API_KEY_CREDENTIAL, {});
    assert.equal(resp.status, 503);
    assert.equal(callCount(), 1);
    assert.equal(W.RETRYABLE_STATUSES.has(503), true, "503 keeps its account-level failover");
  });
});

// --------------------------------------------------------- client-facing status

test("an exhausted throttle is reported as 429, not 400", () => {
  const failure = W.normalizeUpstreamFailure(400, THROTTLE_BODY);
  assert.equal(failure.status, 429);
  assert.match(failure.message, /throttled/i);
});

test("every other failure keeps its status and upstream text", () => {
  const failure = W.normalizeUpstreamFailure(400, GENUINE_VALIDATION_BODY);
  assert.equal(failure.status, 400);
  assert.equal(failure.message, GENUINE_VALIDATION_BODY);
});

// ------------------------------------------------------ in-stream exception frame

test("an in-stream throttle is classified by message, not exception type", () => {
  const err = new W.KiroUpstreamException(
    "ValidationException",
    "Invalid model. Please select a different model to continue.",
  );
  assert.equal(err.isModelThrottle, true);
  assert.equal(err.status, 429, "ValidationException alone would have mapped to 400");
  assert.equal(err.retryable, true, "ValidationException alone would have been permanent");
});

test("an in-stream malformed request stays a permanent 400", () => {
  const err = new W.KiroUpstreamException("ValidationException", "Improperly formed request.");
  assert.equal(err.isModelThrottle, false);
  assert.equal(err.status, 400);
  assert.equal(err.retryable, false);
});

// ------------------------------------------------------------------ model table

test("every live model id survives mapping untouched", () => {
  for (const id of ["auto", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7", "claude-sonnet-5", "gpt-5.6-sol"]) {
    assert.equal(W.mapKiroModel(id), id);
  }
});

test("retired ids fold onto a model Kiro still serves", () => {
  assert.equal(W.mapKiroModel("claude-opus-4.5"), "claude-opus-4.7");
  assert.equal(W.mapKiroModel("claude-sonnet-4.5"), "claude-sonnet-5");
});

// ------------------------------------------------- shared ramp, raw-fetch paths

// The native passthrough builds its own request instead of going through
// callKiro, and shared the same flaw. It replays through the same ramp.
test("the ramp applies to callers that build their own request", async () => {
  let calls = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };

  try {
    const resp = await W.fetchWithModelRetry(async () => {
      calls++;
      return calls < 3
        ? new Response(THROTTLE_BODY, { status: 400 })
        : new Response("ok", { status: 200 });
    });
    assert.equal(resp.status, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ------------------------------------------------------------- pool failover
//
// Symptom the user reported: "Retry failed: rate_limit_error: Kiro throttled this
// model (upstream reported INVALID_MODEL_ID)". fetchWithModelRetry's ramp only
// ever retries the SAME credential, and the throttle is per credential. Upstream
// labels it 400, which is not in RETRYABLE_STATUSES, so the dispatch loop read it
// as a permanent client error, skipped every remaining account in the pool, and
// returned the 429 immediately. A pool with idle accounts still failed the call.

test("an exhausted model throttle sends the pool to the next account", () => {
  assert.equal(W.shouldTryNextAccount(400, THROTTLE_BODY), true);
});

test("the prose-only form also fails over", () => {
  assert.equal(
    W.shouldTryNextAccount(400, "Invalid model. Please select a different model to continue."),
    true,
  );
});

test("a genuinely malformed request still stops the loop", () => {
  // Every account would reject it identically, so walking the pool only burns
  // quota and latency.
  assert.equal(W.shouldTryNextAccount(400, GENUINE_VALIDATION_BODY), false);
});

test("the honestly-labelled transient statuses keep failing over", () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(W.shouldTryNextAccount(status, ""), true, `status ${status}`);
  }
});

test("a permanent client error is not spread across the pool", () => {
  for (const status of [401, 403, 404, 422]) {
    assert.equal(W.shouldTryNextAccount(status, ""), false, `status ${status}`);
  }
});

test("a pool that runs out of accounts still reports the throttle as 429", () => {
  // The exhaustion path must answer with the normalized failure, not upstream's
  // 400, or the client is told never to retry a model that works seconds later.
  const failure = W.normalizeUpstreamFailure(400, THROTTLE_BODY);
  assert.equal(failure.status, 429);
  assert.equal(failure.headers["Retry-After"], "3");
});
