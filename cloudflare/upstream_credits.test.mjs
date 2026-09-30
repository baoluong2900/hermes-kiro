// Credit accounting across the upstream failure paths added when exception
// frames stopped being swallowed.
//
// Run:  node --test cloudflare/upstream_credits.test.mjs
//
// The invariant: a request is charged exactly what upstream metered, no more and
// no less, and its hold is always dropped. Two ways to get this wrong:
//
//   - Release on every failure. Upstream meters what it produced, so a request
//     that failed after a meteringEvent already arrived becomes free. The stream
//     path is protected by shouldSettleStream(); the non-stream builders
//     accumulate credits in locals, so throwing used to discard them.
//   - Charge on a failure that produced nothing, or forget to drop the hold at
//     all, which slowly eats the key's limit.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-credits-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  reserveApiKeyQuota, settleApiKeyQuota, releaseApiKeyQuota, handleQuotaCheck,
  finishFailedRequest, withPartialUsage, partialCreditsOf, totalChargeFor,
  nonStreamClaudeResponse, nonStreamOpenAIResponse, streamClaudeResponse,
  shouldSettleStream, KiroUpstreamException, EmptyUpstreamResponse,
};
`);
  const mod = await import(file);
  return { ...mod.__internals, ApiKeyQuota: mod.ApiKeyQuota };
}

const W = await loadWorker();

// ----------------------------------------------------------- test doubles

class KV {
  constructor(seed) { this.store = { ...seed }; }
  async get(k) { return this.store[k] ?? null; }
  async put(k, v) { this.store[k] = v; }
}

class DOStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.get(k); }
  async put(a, b) {
    if (typeof a === "object" && a !== null && !Array.isArray(a)) {
      for (const [k, v] of Object.entries(a)) this.map.set(k, v);
    } else this.map.set(a, b);
  }
  async deleteAll() { this.map.clear(); }
}

function makeKey(over = {}) {
  return {
    id: "key-credit-1",
    key: "kpp_credit_test",
    name: "credit test",
    creditLimit: 100,
    creditsUsed: 0,
    credits: 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    modelUsage: {},
    ...over,
  };
}

function makeEnv(key) {
  const kv = new KV({
    "config:api_keys": JSON.stringify([key]),
    "config:stats": JSON.stringify({ totalRequests: 0, successRequests: 0, failedRequests: 0, totalCredits: 0 }),
    "config:accounts": JSON.stringify([]),
    "config:settings": JSON.stringify({}),
  });
  const instances = new Map();
  const env = {
    KIRO_KV: kv,
    API_KEY_QUOTA: {
      idFromName: (n) => n,
      get: (n) => {
        if (!instances.has(n)) {
          instances.set(n, new W.ApiKeyQuota({ storage: new DOStorage(), blockConcurrencyWhile: (f) => f() }, {}));
        }
        const inst = instances.get(n);
        return { fetch: (url, init) => inst.fetch(new Request(url, init)) };
      },
    },
  };
  return { env, kv };
}

async function quotaState(env, keyId) {
  const stub = env.API_KEY_QUOTA.get(keyId);
  const resp = await stub.fetch("https://quota/state", { method: "POST", body: "{}" });
  if (resp.ok) return await resp.json();
  // No /state route: derive the same numbers from a zero-charge settle probe.
  return null;
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), drain: () => Promise.allSettled(pending) };
}

// Reads the balance the way the dashboard does.
async function check(env, keyStr) {
  const req = new Request(`https://gw/check?key=${encodeURIComponent(keyStr)}&format=json`,
    { headers: { Accept: "application/json" } });
  return (await W.handleQuotaCheck(req, env, {})).json();
}

// ----------------------------------------------------------- frame encoding

function frame(headers, payloadObj) {
  const enc = new TextEncoder();
  const payload = enc.encode(payloadObj === undefined ? "" : JSON.stringify(payloadObj));
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const h = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    h[o++] = n.length;
    h.set(n, o); o += n.length;
    h[o++] = 7;
    h[o++] = (v.length >> 8) & 0xff;
    h[o++] = v.length & 0xff;
    h.set(v, o);
    parts.push(h);
  }
  const headerLen = parts.reduce((s, p) => s + p.length, 0);
  const total = 12 + headerLen + payload.length + 4;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headerLen, false);
  view.setUint32(8, 0, false);
  let off = 12;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  buf.set(payload, off); off += payload.length;
  view.setUint32(off, 0, false);
  return buf;
}

function bodyOf(...frames) {
  const total = frames.reduce((s, f) => s + f.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  return new Response(all, { status: 200 });
}

const textFrame = (t) => frame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: t });
const meterFrame = (c) => frame({ ":event-type": "meteringEvent", ":message-type": "event" }, { credits: c });
const throttleFrame = () => frame({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, { message: "slow down" });
const validationFrame = () => frame({ ":message-type": "exception", ":exception-type": "ValidationException" }, { message: "input too long" });

// ------------------------------------------------- partial usage on the error

test("credits metered before an exception ride along on the error", async () => {
  // Symptom: nonStreamClaudeResponse accumulated credits in a local and threw,
  // so upstream's charge was discarded and the request was free.
  await assert.rejects(
    () => W.nonStreamClaudeResponse(bodyOf(textFrame("hi"), meterFrame(0.42), throttleFrame()), "claude-opus-4.7", {}),
    (err) => {
      assert.equal(W.partialCreditsOf(err), 0.42, "the metered charge must survive the throw");
      return true;
    },
  );
});

test("the OpenAI builder carries partial usage too", async () => {
  await assert.rejects(
    () => W.nonStreamOpenAIResponse(bodyOf(textFrame("hi"), meterFrame(0.7), throttleFrame()), "gpt-4o", {}),
    (err) => W.partialCreditsOf(err) === 0.7,
  );
});

test("an empty response owes nothing", async () => {
  // No content, no tokens, no metering: upstream did no work, so the hold must
  // come back in full rather than being charged.
  await assert.rejects(
    () => W.nonStreamClaudeResponse(bodyOf(), "claude-opus-4.7", {}),
    (err) => err instanceof W.EmptyUpstreamResponse && W.partialCreditsOf(err) === 0,
  );
});

// --------------------------------------------------- settlement of a failure

test("a failure that upstream metered is charged, and the hold is dropped", async () => {
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;
  assert.ok(reservation > 0, "a hold must exist to begin with");

  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation, owedCredits: 0.42, status: 429,
    message: "ThrottlingException: slow down",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "a", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 1200, inputTokens: 8000,
  });
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), 0.42, "upstream's charge is paid");
  assert.equal(after.credits_reserved, 0, "the hold must not leak");
});

test("a failure that produced nothing is free", async () => {
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation, owedCredits: 0, status: 502,
    message: "EmptyUpstreamResponse",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "a", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 900, inputTokens: 8000,
  });
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(after.credits_used, 0, "nothing produced, nothing charged");
  assert.equal(after.credits_reserved, 0, "the hold still has to be dropped");
});

test("a failed request is recorded as an error, not left invisible", async () => {
  // Before this, non-stream failures called releaseApiKeyQuota and returned
  // without recording anything. Combined with the swallowed-exception bug the
  // dashboard showed a fabricated success; without it the row would just vanish.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation, owedCredits: 0.1, status: 429,
    message: "ThrottlingException: slow down",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "acct@example.com", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 1500, inputTokens: 8000,
  });
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(after.requests_count, 1, "the attempt is counted");
  assert.equal(after.recent_logs.length, 1, "and it leaves a log row");

  const row = after.recent_logs[0];
  assert.equal(row.status, "error");
  assert.equal(row.statusCode, 429);
  assert.match(row.error, /ThrottlingException/);
  assert.equal(row.outputTokens, 0, "a failure must not report invented output");
  assert.equal(row.metered, true, "it was metered, so say so");
  assert.ok(row.duration > 0, "latency is recorded");
});

test("a metered failure and a metered retry are both paid for", async () => {
  // Account A metered 0.3 then threw; the retry on account B cost 0.5. The key
  // owes 0.8. Settling only the successful attempt underpays by exactly the
  // amount the failed attempt cost.
  //
  // Bound to totalChargeFor rather than re-adding the numbers here: a test that
  // re-implements the arithmetic stays green when the shipped call sites stop
  // doing it.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  let owedCredits = 0;
  try {
    await W.nonStreamClaudeResponse(bodyOf(textFrame("partial"), meterFrame(0.3), throttleFrame()), "claude-opus-4.7", {});
    assert.fail("attempt A should have thrown");
  } catch (err) {
    owedCredits += W.partialCreditsOf(err);
  }
  assert.equal(owedCredits, 0.3);

  const ok = await W.nonStreamClaudeResponse(bodyOf(textFrame("answer"), meterFrame(0.5)), "claude-opus-4.7", {});
  const finalCredits = W.totalChargeFor(ok.credits, owedCredits);
  assert.equal(finalCredits, 0.8, "the failed attempt is still owed");

  await W.settleApiKeyQuota(env, key.id, reservation, finalCredits);

  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), 0.8, "both attempts are billed");
  assert.equal(after.credits_reserved, 0);
});

test("totalChargeFor never drops the owed term", async () => {
  assert.equal(W.totalChargeFor(0.5, 0.3), 0.8);
  assert.equal(W.totalChargeFor(0, 0.42), 0.42, "a failed attempt alone is still owed");
  assert.equal(W.totalChargeFor(0.5, 0), 0.5);
  assert.equal(W.totalChargeFor(undefined, undefined), 0);
  assert.equal(W.totalChargeFor(-1, -1), 0, "negatives cannot create a refund");
  assert.equal(W.totalChargeFor(0.1, 0.2), 0.3, "no float dust");
});

// ------------------------------------------------------- streaming settlement

test("a stream that failed after metering still settles", async () => {
  // shouldSettleStream already encoded this; the check is that an exception
  // frame reaches it as a failure with the credits intact rather than as a
  // silent success.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  let observed = null;
  const resp = W.streamClaudeResponse(
    bodyOf(textFrame("partial"), meterFrame(0.25), throttleFrame()),
    "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => {
      observed = { credits, isSuccess };
      const settled = W.shouldSettleStream(isSuccess, credits)
        ? await W.settleApiKeyQuota(env, key.id, reservation, credits)
        : (await W.releaseApiKeyQuota(env, key.id, reservation), null);
      assert.ok(settled, "a metered failure must settle, not release");
    },
    ctx,
  );
  try { await resp.text(); } catch { /* ignore */ }
  await ctx.drain();

  assert.equal(observed.isSuccess, false, "the exception must fail the stream");
  assert.equal(observed.credits, 0.25, "metered credits survive to the callback");

  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), 0.25);
  assert.equal(after.credits_reserved, 0);
});

test("an empty stream releases its hold instead of charging", async () => {
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  const resp = W.streamClaudeResponse(
    bodyOf(), "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => {
      assert.equal(isSuccess, false);
      assert.equal(credits, 0);
      if (W.shouldSettleStream(isSuccess, credits)) {
        await W.settleApiKeyQuota(env, key.id, reservation, credits);
      } else {
        await W.releaseApiKeyQuota(env, key.id, reservation);
      }
    },
    ctx,
  );
  await resp.text();
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(after.credits_used, 0, "an empty response is free");
  assert.equal(after.credits_reserved, 0, "and its hold is returned");
});

// ------------------------------------------------------------ limit behaviour

test("a metered failure counts against the credit limit", async () => {
  // The loop in the report ran free: every attempt was released, so the key's
  // limit never moved and nothing throttled it. Once failures are billed, a key
  // near its limit stops being able to spin.
  const key = makeKey({ creditLimit: 1, creditsUsed: 0 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();

  for (let i = 0; i < 3; i++) {
    const r = await W.reserveApiKeyQuota(env, key, 0.01);
    if (!r.ok) break;
    await W.finishFailedRequest(env, ctx, {
      apiKeyId: key.id, reservation: Number(r.reservation) || 0, owedCredits: 0.3, status: 429,
      message: "ThrottlingException: slow down",
      endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
      account: "a", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
      startTime: Date.now() - 500, inputTokens: 100,
    });
  }
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), 0.9, "three metered failures cost 0.9");
  assert.equal(after.credits_reserved, 0, "no hold left behind");
  assert.ok(after.credits_used > 0, "the limit is actually moving now");
});

test("an empty account pool is logged as a free 503, not silently dropped", async () => {
  // Every account being disabled at once produces a 503 that costs nothing. It
  // used to return without recording anything, so the request counter stayed at
  // zero and the dashboard gave no hint why calls were failing.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 0.01)).reservation;

  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation, owedCredits: 0, status: 503,
    message: "No active Kiro accounts available in pool",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "", accountId: "", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 600, inputTokens: 12,
  });
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(after.credits_used, 0, "an empty pool costs nothing");
  assert.equal(after.credits_reserved, 0, "and returns its hold");
  assert.equal(after.requests_count, 1, "but the attempt is still counted");
  assert.equal(after.recent_logs.length, 1);
  assert.equal(after.recent_logs[0].statusCode, 503);
  assert.match(after.recent_logs[0].error, /No active Kiro accounts/);
});

test("a metered failure throttles the very next request, before any async write lands", async () => {
  // Only the DO's own "used" gates /reserve. It gets there two ways: /settle,
  // which runs inline, and /usage, which rides a waitUntil task and uses the
  // recorded credits as a floor. The floor eventually heals the balance either
  // way, so the thing settlement actually buys is immediacy — and immediacy is
  // the whole point here, because the loop in the report fired about twice a
  // second. Releasing instead of settling leaves every request in that burst
  // admitted against a stale zero balance.
  const key = makeKey({ creditLimit: 1, creditsUsed: 0 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();

  const first = await W.reserveApiKeyQuota(env, key, 0.01);
  assert.equal(first.ok, true, "the first request is admitted");

  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation: Number(first.reservation) || 0, owedCredits: 0.95, status: 429,
    message: "ThrottlingException: slow down",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "a", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 500, inputTokens: 100,
  });

  // Deliberately before ctx.drain(): the log/usage mirror has not been written
  // yet, so this only passes if settlement already moved the balance.
  assert.equal(ctx.pending.length, 1, "the usage mirror is still pending");
  const second = await W.reserveApiKeyQuota(env, key, 0.1);
  assert.equal(second.ok, false,
    "the next request must be refused immediately, not one async hop later");

  await ctx.drain();
  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), 0.95, "and the charge is not double counted");
});

test("metered failures exhaust the limit in the Durable Object, not just in KV", async () => {
  // Same invariant seen from the durable side: the key object handed to reserve
  // still says creditsUsed: 0, mirroring the stale KV read a real request does,
  // so the DO has to refuse on its own balance.
  const key = makeKey({ creditLimit: 1, creditsUsed: 0 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();

  const first = await W.reserveApiKeyQuota(env, key, 0.01);
  assert.equal(first.ok, true, "the first request is admitted");
  await W.finishFailedRequest(env, ctx, {
    apiKeyId: key.id, reservation: Number(first.reservation) || 0, owedCredits: 0.95, status: 429,
    message: "ThrottlingException: slow down",
    endpoint: "/v1/messages", kind: "anthropic", model: "claude-opus-4.7",
    account: "a", accountId: "a", apiKey: "credit test", ip: "1.1.1.1",
    startTime: Date.now() - 500, inputTokens: 100,
  });
  await ctx.drain();

  const second = await W.reserveApiKeyQuota(env, key, 0.1);
  assert.equal(second.ok, false,
    "a metered failure must consume the limit, or the loop never gets throttled");
});
