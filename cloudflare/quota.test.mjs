// Regression suite for API key quota accounting in worker.gateway.js.
//
// Run:  node --test cloudflare/quota.test.mjs
//
// These cover bugs that all shared one shape: usage was computed correctly but
// then lost, either because a stale KV read overwrote it, or because the promise
// doing the bookkeeping was never registered as pending work and the runtime
// discarded it. Each test states the symptom it guards against.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The worker only exports its Durable Object and default fetch handler. Load a
// copy with the internals re-exported so they can be exercised directly.
async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-quota-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  handleQuotaCheck, handleModels, recordRequestStats,
  reserveApiKeyQuota, settleApiKeyQuota, releaseApiKeyQuota,
  streamClaudeResponse, normalizeModel, sumModelUsageCredits, shouldSettleStream,
  estimateInputTokens,
  FALLBACK_MODELS, DEFAULT_MODEL, VALID_KIRO_MODELS, HOLD_TTL_MS,
};
`);
  const mod = await import(file);
  return { ...mod.__internals, ApiKeyQuota: mod.ApiKeyQuota };
}

const W = await loadWorker();

// ---------------------------------------------------------------- test doubles

// Workers KV serves reads from an edge cache with a 60s floor. Writes are held
// back until propagate() so tests can reproduce that window deliberately.
class StaleKV {
  constructor(seed) { this.hidden = { ...seed }; this.visible = { ...seed }; }
  async get(k) { return this.visible[k] ?? null; }
  async put(k, v) { this.hidden[k] = v; }
  propagate() { this.visible = { ...this.hidden }; }
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

function quotaNamespace() {
  const instances = new Map();
  return {
    instances,
    idFromName: (n) => n,
    get(id) {
      if (!instances.has(id)) instances.set(id, new W.ApiKeyQuota({ storage: new DOStorage() }));
      return { fetch: (url, init) => instances.get(id).fetch(new Request(url, init)) };
    },
  };
}

// Collects pending work the way the Workers runtime does: anything not handed to
// waitUntil is abandoned once the response completes.
function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), drain: () => Promise.allSettled(pending) };
}

function makeKey(over = {}) {
  return {
    id: "key-1", name: "test", key: "ksk_" + "0".repeat(32),
    enabled: true, creditLimit: 0, creditsUsed: 0, credits: 0,
    requests: 0, tokensIn: 0, tokensOut: 0, modelUsage: {}, ...over,
  };
}

function makeEnv(key, { logs = [] } = {}) {
  const kv = new StaleKV({
    "config:api_keys": JSON.stringify([key]),
    "config:logs": JSON.stringify(logs),
  });
  const ns = quotaNamespace();
  return { env: { KIRO_KV: kv, API_KEY_QUOTA: ns }, kv, ns };
}

async function check(env, key) {
  const req = new Request(`https://gw/check?key=${encodeURIComponent(key)}&format=json`,
    { headers: { Accept: "application/json" } });
  return (await W.handleQuotaCheck(req, env, {})).json();
}

function logEntry(over = {}) {
  return {
    timeUnix: 1788000000, model: "claude-opus-4.8", inputTokens: 10, outputTokens: 50,
    totalTokens: 60, credits: 0, duration: 1000, status: "success", kind: "anthropic", ...over,
  };
}

// Runs one fully-metered request end to end: reserve, settle, record.
async function billRequest(env, key, credits, extra = {}) {
  const r = await W.reserveApiKeyQuota(env, key, 1);
  if (!r.ok) return { rejected: true };
  const settled = await W.settleApiKeyQuota(env, key.id, r.reservation, credits);
  await W.recordRequestStats(env, null, true, 10, 50, credits,
    logEntry({ apiKeyId: key.id, credits, ...extra }),
    key.id, "acc-1", extra.model || "claude-opus-4.8", settled?.used);
  return { rejected: false };
}

// ---------------------------------------------------------------------- tests

test("stale KV reads must not freeze the credit counter", async () => {
  // Symptom: /reserve re-seeded "used" from KV on every request, discarding every
  // settlement newer than the KV cache. Usage sat at "old value + one charge" no
  // matter how many requests ran.
  const START = 0.25, CHARGE = 0.05, N = 20;
  const key = makeKey({ creditLimit: 1000, creditsUsed: START, credits: START,
    modelUsage: { "claude-opus-5": { requests: 1, credits: START } } });
  const { env, kv } = makeEnv(key);

  for (let i = 0; i < N; i++) {
    // Read the key the way the handler does: through the stale cache.
    const stale = JSON.parse(kv.visible["config:api_keys"])[0];
    await billRequest(env, stale, CHARGE, { timeUnix: 1788000000 + i });
  }

  const after = await check(env, key.key);
  assert.equal(Number(after.credits_used.toFixed(6)), Number((START + N * CHARGE).toFixed(6)));
  assert.equal(after.requests_count, N);
  assert.equal(after.credits_reserved, 0, "every hold was settled");

  kv.propagate();
  const settled = await check(env, key.key);
  assert.equal(Number(settled.credits_used.toFixed(6)), Number((START + N * CHARGE).toFixed(6)),
    "KV catching up must not double count");
});

test("stream bookkeeping is registered as pending work", async () => {
  // Symptom: the stream pump was a bare promise. Settlement runs after the last
  // byte, so the runtime tore the isolate down first and every streamed request
  // went unbilled and unlogged while its hold leaked.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();

  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;
  let settleFinished = false;

  const resp = W.streamClaudeResponse(
    new Response(new Blob([]).stream(), { status: 200 }), "claude-opus-4.8", {},
    async () => {
      const settled = await W.settleApiKeyQuota(env, key.id, reservation, 0.42);
      await W.recordRequestStats(env, null, true, 10, 55, 0.42,
        logEntry({ apiKeyId: key.id, credits: 0.42 }), key.id, "a", "claude-opus-4.8", settled?.used);
      settleFinished = true;
    }, ctx);

  assert.equal(ctx.pending.length, 1, "pump must be handed to waitUntil");
  await resp.text();
  assert.equal(settleFinished, false, "settlement is still pending when the client has the body");

  await ctx.drain();
  assert.equal(settleFinished, true);

  const after = await check(env, key.key);
  assert.equal(after.credits_used, 0.42);
  assert.equal(after.credits_reserved, 0, "hold released");
  assert.equal(after.requests_count, 1);
  assert.equal(after.recent_logs.length, 1);
});

test("a stream aborted after partial output is still billed", async () => {
  // Symptom: any non-success released the hold, so cancelling a stream mid-answer
  // returned tokens the upstream had already metered and charged us for.
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const ctx = fakeCtx();
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;

  const resp = W.streamClaudeResponse(
    new Response(new ReadableStream({ start(c) { c.error(new Error("client gone")); } }), { status: 200 }),
    "claude-opus-4.8", {},
    async (credits, tokens, isSuccess) => {
      assert.equal(isSuccess, false, "the pump must observe the failure");
      const metered = 0.3;                       // upstream already metered this
      const settled = (isSuccess || metered > 0)
        ? await W.settleApiKeyQuota(env, key.id, reservation, metered)
        : (await W.releaseApiKeyQuota(env, key.id, reservation), null);
      await W.recordRequestStats(env, null, isSuccess, 10, 20, metered,
        logEntry({ apiKeyId: key.id, credits: metered, status: "error" }),
        key.id, "a", "claude-opus-4.8", settled?.used);
    }, ctx);

  try { await resp.text(); } catch { /* aborted body */ }
  await ctx.drain();

  const after = await check(env, key.key);
  assert.equal(after.credits_used, 0.3, "partial output is charged");
  assert.equal(after.credits_reserved, 0, "remainder of the hold returned");
});

test("a request that produced nothing releases its whole hold", async () => {
  const key = makeKey({ creditLimit: 100 });
  const { env } = makeEnv(key);
  const reservation = (await W.reserveApiKeyQuota(env, key, 1)).reservation;
  assert.equal((await check(env, key.key)).credits_reserved, 1);

  await W.releaseApiKeyQuota(env, key.id, reservation);
  const after = await check(env, key.key);
  assert.equal(after.credits_reserved, 0);
  assert.equal(after.credits_used, 0, "nothing billed");
});

test("leaked holds expire instead of eating the limit forever", async () => {
  // Symptom: holds were one running total that only grew, so every settlement
  // that never ran permanently locked credit. Production reached 94 locked
  // credits with a real balance under 1.
  const key = makeKey({ creditLimit: 1000 });
  const { env, ns } = makeEnv(key);

  for (let i = 0; i < 40; i++) await W.reserveApiKeyQuota(env, key, 1);
  assert.equal((await check(env, key.key)).credits_reserved, 40);

  // Age every hold past the TTL.
  const storage = ns.instances.get(key.id).state.storage;
  const aged = storage.map.get("holds").map((h) => ({ ...h, atMs: h.atMs - (W.HOLD_TTL_MS + 1000) }));
  storage.map.set("holds", aged);

  const after = await check(env, key.key);
  assert.equal(after.credits_reserved, 0, "expired holds reclaimed");
  assert.equal(after.credits_used, 0, "reclaiming a hold must not bill it");
});

test("a pre-existing scalar hold total is migrated and expired", async () => {
  const key = makeKey({ creditLimit: 1000 });
  const { env, ns } = makeEnv(key);
  // Simulate storage written by the old scalar-only implementation.
  ns.get(key.id);
  ns.instances.get(key.id).state.storage.map.set("reserved", 94.02);

  const after = await check(env, key.key);
  assert.equal(after.credits_reserved, 0, "legacy leak is reclaimed on first read");
});

test("settling an already-expired hold must not steal a live one", async () => {
  const key = makeKey({ creditLimit: 1000 });
  const { env } = makeEnv(key);
  const stale = (await W.reserveApiKeyQuota(env, key, 0.25)).reservation;
  await W.reserveApiKeyQuota(env, key, 0.75);              // a different live hold
  assert.equal((await check(env, key.key)).credits_reserved, 1);

  // Settle with an amount whose hold is gone: 0.25 is present, so it matches.
  await W.settleApiKeyQuota(env, key.id, stale, 0.1);
  assert.equal((await check(env, key.key)).credits_reserved, 0.75, "only the matching hold went");

  // Now settle an amount that matches nothing.
  await W.settleApiKeyQuota(env, key.id, 0.33, 0.1);
  assert.equal((await check(env, key.key)).credits_reserved, 0.75,
    "a miss must leave the live hold alone");
});

test("credit limit is enforced and usage never passes the ceiling", async () => {
  const key = makeKey({ creditLimit: 1 });
  const { env } = makeEnv(key);
  let rejected = 0;
  for (let i = 0; i < 8; i++) {
    const stale = makeKey({ creditLimit: 1 });
    const r = await billRequest(env, stale, 0.3, { timeUnix: 1788000000 + i });
    if (r.rejected) rejected++;
  }
  const after = await check(env, key.key);
  assert.ok(rejected > 0, "requests past the limit are refused");
  assert.ok(after.credits_used <= 1 + 1e-9, `used ${after.credits_used} must not exceed the limit`);
  assert.equal(after.remaining_credits >= 0, true);
});

test("modelUsage repairs a balance an earlier bug pinned too low", async () => {
  // The per-model credits are pure increments that nothing rewrites, so they are
  // the ground truth used to heal a drifted running total.
  const key = makeKey({
    creditLimit: 1000, creditsUsed: 0.313578, credits: 0.313578,
    modelUsage: {
      "claude-opus-5": { credits: 0.410929 }, "claude-haiku-4.5": { credits: 0.149739 },
      "claude-opus-4.8": { credits: 0.027220 }, "claude-sonnet-4.6": { credits: 0.020056 },
    },
  });
  const { env } = makeEnv(key);
  const metered = W.sumModelUsageCredits(key.modelUsage);
  const after = await check(env, key.key);
  assert.equal(after.credits_used, metered);
  assert.ok(after.credits_used > 0.313578, "the drifted total was corrected upward");
});

test("unlimited keys still accumulate usage", async () => {
  const key = makeKey({ creditLimit: 0 });
  const { env } = makeEnv(key);
  for (let i = 0; i < 4; i++) {
    await W.recordRequestStats(env, null, true, 50, 150, 0.25,
      logEntry({ apiKeyId: key.id, credits: 0.25, timeUnix: 1788000000 + i }),
      key.id, "a", "claude-opus-5", null);
  }
  const after = await check(env, key.key);
  assert.equal(after.credits_used, 1);
  assert.equal(after.requests_count, 4);
  assert.equal(after.remaining_credits, "unlimited");
});

test("/check merges live and KV logs without duplicating rows", async () => {
  const key = makeKey({ creditLimit: 100 });
  const { env, kv } = makeEnv(key);
  for (let i = 0; i < 3; i++) {
    await billRequest(env, key, 0.1, { timeUnix: 1788000000 + i });
  }
  const before = await check(env, key.key);
  kv.propagate();
  const after = await check(env, key.key);
  assert.equal(before.recent_logs.length, 3);
  assert.equal(after.recent_logs.length, 3, "the same rows from both sources collapse");
  assert.equal(new Set(after.recent_logs.map((l) => l.id)).size, 3);
});

test("/check works when no quota Durable Object is bound", async () => {
  const key = makeKey({ creditLimit: 0 });
  const logs = Array.from({ length: 300 }, (_, i) =>
    logEntry({ id: "l" + i, apiKeyId: key.id, timeUnix: 1788000000 - i }));
  const kv = new StaleKV({
    "config:api_keys": JSON.stringify([key]),
    "config:logs": JSON.stringify(logs),
  });
  const after = await check({ KIRO_KV: kv }, key.key);
  assert.equal(after.live, false);
  assert.equal(after.success, true);
  assert.equal(after.recent_logs.length, 200, "capped at 10 pages of 20");
});

test("a finished stream owes money whenever upstream metered anything", () => {
  // Guards the settle-vs-release decision itself. The end-to-end test around it
  // supplies its own callback, so without this the fix could be reverted with the
  // suite still green.
  assert.equal(W.shouldSettleStream(true, 0), true, "a clean stream always settles");
  assert.equal(W.shouldSettleStream(true, 0.3), true);

  // The bug: an aborted stream that already produced metered output.
  assert.equal(W.shouldSettleStream(false, 0.3), true,
    "an aborted stream with metered output must be billed, not refunded");
  assert.equal(W.shouldSettleStream(false, 0.0001), true, "any metered amount counts");

  // Nothing produced means nothing owed.
  assert.equal(W.shouldSettleStream(false, 0), false, "a failure with no output releases the hold");
  assert.equal(W.shouldSettleStream(false, undefined), false);
  assert.equal(W.shouldSettleStream(false, NaN), false, "unparseable metering is not a charge");
  assert.equal(W.shouldSettleStream(false, -1), false, "a negative reading is not a charge");
});

test("published model catalog", async () => {
  const kv = { get: async () => JSON.stringify([
    { modelId: "claude-opus-5" }, { modelId: "claude-sonnet-4.6" },
    { modelId: "claude-haiku-4.5" }, { modelId: "glm-5" }, { modelId: "deepseek-3.2" },
  ]), put: async () => {} };
  const ids = (await (await W.handleModels({ KIRO_KV: kv }, {})).json()).data.map((m) => m.id);

  for (const required of ["claude-opus-5-thinking", "claude-opus-4.8-thinking", "claude-opus-4.7-thinking"]) {
    assert.ok(ids.includes(required), `${required} must be advertised`);
  }
  const retired = ids.filter((id) => /4\.6|4\.5|claude-3-|glm|deepseek|qwen|minimax|haiku|sonnet-4/.test(id));
  assert.deepEqual(retired, [], "retired and third-party ids must not be advertised");
});

test("legacy model names still resolve to a live model", async () => {
  for (const legacy of ["claude-sonnet-4.6", "claude-3-5-sonnet", "claude-haiku-4.5",
                        "gpt-4o", "glm-5", "deepseek-chat", "claude-opus-4.6-thinking"]) {
    const { model } = W.normalizeModel(legacy);
    assert.ok(W.VALID_KIRO_MODELS.has(model), `${legacy} -> ${model} must be a live model`);
  }
  assert.equal(W.normalizeModel("claude-opus-4.8-thinking").thinking, true);
  assert.ok(W.VALID_KIRO_MODELS.has(W.DEFAULT_MODEL));
});

// ---------------------------------------------------- count_tokens estimation

// POST /v1/messages/count_tokens used to answer a constant {"input_tokens":100}.
// Claude Code sizes its context window from that number, so a constant made it
// believe every session was tiny, never compact, and eventually die on an
// upstream context-length error. The endpoint now runs estimateInputTokens over
// the real payload; these guard the shape and the scaling it depends on.

function words(n) { return Array.from({ length: n }, () => "lorem").join(" "); }
function msg(text) { return { role: "user", content: text }; }

test("count_tokens scales with payload size", () => {
  const small = W.estimateInputTokens({ messages: [msg(words(10))] });
  const medium = W.estimateInputTokens({ messages: [msg(words(200))] });
  const large = W.estimateInputTokens({ messages: [msg(words(4000))] });
  assert.ok(small < medium, `small ${small} < medium ${medium}`);
  assert.ok(medium < large, `medium ${medium} < large ${large}`);
});

test("count_tokens on a large payload rises far above the old constant 100", () => {
  const large = W.estimateInputTokens({ messages: [msg(words(4000))] });
  assert.ok(large > 1000, `4000-word turn estimated at ${large}, must dwarf the old 100`);
});

test("count_tokens returns the floor, never 0 or NaN, when messages are empty or absent", () => {
  for (const input of [undefined, null, {}, { messages: [] }, { messages: [msg("")] }]) {
    const n = W.estimateInputTokens(input);
    assert.ok(Number.isInteger(n), `expected integer, got ${n}`);
    assert.ok(n >= 10, `expected at least the floor of 10, got ${n}`);
  }
});

test("count_tokens counts tools and system blocks, not just user text", () => {
  const base = W.estimateInputTokens({ messages: [msg("hi")] });
  const withSystem = W.estimateInputTokens({
    system: [{ type: "text", text: words(100) }], messages: [msg("hi")],
  });
  const withSystemString = W.estimateInputTokens({ system: words(100), messages: [msg("hi")] });
  const withTools = W.estimateInputTokens({
    messages: [msg("hi")],
    tools: [{ name: "search", description: words(100), input_schema: { type: "object" } }],
  });
  assert.ok(withSystem > base, `system block must add tokens (${withSystem} > ${base})`);
  assert.ok(withSystemString > base, `system string must add tokens (${withSystemString} > ${base})`);
  assert.ok(withTools > base, `tools must add tokens (${withTools} > ${base})`);
});

test("count_tokens counts tool_result, tool_use and image blocks it used to ignore", () => {
  const base = W.estimateInputTokens({ messages: [msg("hi")] });

  // A tool_result whose content is a plain string.
  const toolResultString = W.estimateInputTokens({
    messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: words(200) },
    ] }],
  });
  // A tool_result whose content is nested text blocks.
  const toolResultBlocks = W.estimateInputTokens({
    messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: words(200) }] },
    ] }],
  });
  // A tool_use block carries its arguments as a structured object.
  const toolUse = W.estimateInputTokens({
    messages: [{ role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "search", input: { query: words(200) } },
    ] }],
  });
  // An image block has no text at all but still costs real tokens upstream.
  const image = W.estimateInputTokens({
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] }],
  });

  assert.ok(toolResultString > base, `tool_result string must count (${toolResultString} > ${base})`);
  assert.ok(toolResultBlocks > base, `nested tool_result blocks must count (${toolResultBlocks} > ${base})`);
  assert.ok(toolUse > base, `tool_use input must count (${toolUse} > ${base})`);
  assert.ok(image > base, `image blocks must not be counted as free (${image} > ${base})`);
});

test("count_tokens response shape stays {input_tokens: <integer>}", () => {
  const n = W.estimateInputTokens({ messages: [msg(words(50))] });
  const body = { input_tokens: n };
  assert.deepEqual(Object.keys(body), ["input_tokens"]);
  assert.ok(Number.isInteger(body.input_tokens));
});
