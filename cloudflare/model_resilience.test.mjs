// Regression suite for per-credential model resilience in worker.gateway.js.
//
// Run:  node --test cloudflare/model_resilience.test.mjs
//
// WRITTEN BEFORE IMPLEMENTATION. These tests describe the behavior the
// architecture requires and are expected to FAIL until it is built. They guard
// the live failure: production runs exactly ONE enabled IdC account, Kiro
// mislabels a per-credential model throttle as HTTP 400 INVALID_MODEL_ID, and
// fetchWithModelRetry only ever retries the SAME credential. After the ramp the
// user still gets rate_limit_error even though the identical request succeeds
// seconds later. The fix must ELIMINATE the failure under burst, not relabel it:
//
//   Layer 1 — a per-credential, per-model concurrency gate on the EXISTING
//             ApiKeyQuota DO (instance name `model-gate:<account identity>`),
//             holding a permit until the Response body reaches EOF/cancel, with
//             stale leases that self-expire.
//   Layer 2 — a bounded fallback chain + 30s cooldown recorded in the same DO,
//             triggered ONLY by INVALID_MODEL_ID (never a genuine 4xx), exposing
//             X-Kiro-Actual-Model / X-Kiro-Model-Fallback while keeping the
//             response JSON `model` as the client-requested id.
//
// The worker only exports its Durable Object and default fetch handler, so a
// temp copy is loaded with the internals re-exported. Each planned internal is
// exported through a `typeof` guard so a not-yet-implemented symbol arrives as
// `undefined` — that turns "missing behavior" into a clean per-test failure
// instead of a single import-time ReferenceError that hides which piece is gone.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-resilience-"));
  const file = path.join(dir, "worker.mjs");
  // `g(name)` yields the symbol if the worker defines it, else undefined. This
  // lets the suite import cleanly and fail test-by-test on the specific missing
  // helper, rather than aborting the whole module load.
  await writeFile(file, src + `
const g = (name) => { try { return eval(name); } catch { return undefined; } };
export const __internals = {
  // --- reused, already present ---
  isTransientModelRejection: g("isTransientModelRejection"),
  normalizeUpstreamFailure: g("normalizeUpstreamFailure"),
  mapKiroModel: g("mapKiroModel"),
  MODEL_REJECTION_BACKOFF_MS: g("MODEL_REJECTION_BACKOFF_MS"),

  // --- Layer 2: fallback chain (to be implemented) ---
  MODEL_FALLBACK_CHAIN: g("MODEL_FALLBACK_CHAIN"),
  resolveFallbackCandidates: g("resolveFallbackCandidates"),

  // --- Layer 1: model-gate policy constants (to be implemented) ---
  MODEL_GATE: g("MODEL_GATE"),
  isPremiumModel: g("isPremiumModel"),
  modelGateInstanceName: g("modelGateInstanceName"),
  MODEL_GATE_LEASE_TTL_MS: g("MODEL_GATE_LEASE_TTL_MS"),
  MODEL_COOLDOWN_MS: g("MODEL_COOLDOWN_MS"),

  // --- Layer 1: client-side gate helper (to be implemented) ---
  acquireModelPermit: g("acquireModelPermit"),
  releaseModelPermit: g("releaseModelPermit"),
  withReleaseOnBodyEnd: g("withReleaseOnBodyEnd"),

  // --- Layer C: payload rebuild (to be implemented) ---
  rebuildPayloadWithModel: g("rebuildPayloadWithModel"),

  // --- Layer D: resilient dispatch (to be implemented) ---
  callKiroResilient: g("callKiroResilient"),
  preflightKiroEventStream: g("preflightKiroEventStream"),
};
export const __ApiKeyQuota = g("ApiKeyQuota");
`);
  const mod = await import(file);
  return { ...mod.__internals, ApiKeyQuota: mod.__ApiKeyQuota, worker: mod.default };
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

// ------------------------------------------------------------- test doubles

// Minimal DO storage: adds the delete([...]) / delete(k) the model-gate needs
// on top of the get/put/deleteAll the quota paths already use.
class DOStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.get(k); }
  async put(a, b) {
    if (typeof a === "object" && a !== null && !Array.isArray(a)) {
      for (const [k, v] of Object.entries(a)) this.map.set(k, v);
    } else this.map.set(a, b);
  }
  async delete(k) {
    if (Array.isArray(k)) { for (const kk of k) this.map.delete(kk); return; }
    this.map.delete(k);
  }
  async deleteAll() { this.map.clear(); }
}

function newQuota() {
  assert.ok(W.ApiKeyQuota, "ApiKeyQuota must be exported");
  return new W.ApiKeyQuota({ storage: new DOStorage() });
}

// Drive a model-gate endpoint on a DO instance with a direct Request.
async function gate(instance, pathname, body) {
  const resp = await instance.fetch(new Request("https://gate" + pathname, {
    method: "POST",
    body: JSON.stringify(body || {}),
  }));
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

// A body-consumable Response backed by a stream we can drive frame by frame,
// so a test can assert the permit is still held while bytes remain unread.
function makeStreamingResponse(chunks, { status = 200 } = {}) {
  let cancelled = false;
  let errored = false;
  const state = { get cancelled() { return cancelled; }, get errored() { return errored; } };
  const stream = new ReadableStream({
    start(controller) {
      state.push = (c) => controller.enqueue(new TextEncoder().encode(c));
      state.close = () => controller.close();
      state.error = (e) => { errored = true; controller.error(e); };
      for (const c of chunks || []) controller.enqueue(new TextEncoder().encode(c));
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(stream, { status }), state };
}

// -------------------------------------------------- 1. fallback chain shape

const LIVE_MODELS = [
  "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7",
  "claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "auto",
];

// Exact chains from the architecture. First entry is always the requested model
// itself (it gets tried before any fallback).
const EXPECTED_CHAINS = {
  "claude-opus-5": ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol"],
  "claude-opus-4.8": ["claude-opus-4.8", "claude-sonnet-5", "gpt-5.6-sol"],
  "claude-opus-4.7": ["claude-opus-4.7", "claude-sonnet-5", "gpt-5.6-sol"],
  "claude-sonnet-5": ["claude-sonnet-5", "gpt-5.6-sol"],
  "auto": ["auto", "gpt-5.6-sol", "claude-sonnet-5"],
  "gpt-5.6-terra": ["gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5"],
  "gpt-5.6-luna": ["gpt-5.6-luna", "gpt-5.6-sol", "claude-sonnet-5"],
  "gpt-5.6-sol": ["gpt-5.6-sol", "claude-sonnet-5"],
};

test("fallback chain has the exact ordering the architecture specifies", () => {
  assert.ok(W.resolveFallbackCandidates, "resolveFallbackCandidates must be exported");
  for (const [model, expected] of Object.entries(EXPECTED_CHAINS)) {
    assert.deepEqual(
      W.resolveFallbackCandidates(model), expected,
      `chain for ${model}`,
    );
  }
});

test("fallback chain never repeats a model (de-dup, no cycles) for any live model", () => {
  assert.ok(W.resolveFallbackCandidates, "resolveFallbackCandidates must be exported");
  for (const model of LIVE_MODELS) {
    const chain = W.resolveFallbackCandidates(model);
    assert.ok(Array.isArray(chain) && chain.length >= 1, `chain for ${model} is a non-empty list`);
    assert.equal(new Set(chain).size, chain.length, `chain for ${model} has no duplicates`);
    assert.equal(chain[0], model, `chain for ${model} starts with the requested model`);
    // No candidate may point back to something earlier in the chain.
    assert.ok(!chain.slice(1).includes(model), `chain for ${model} does not cycle back`);
  }
});

// ------------------------------------- 2. only INVALID_MODEL_ID triggers fallback

test("only INVALID_MODEL_ID is treated as a throttle that may fall back", () => {
  assert.ok(W.isTransientModelRejection, "isTransientModelRejection must be exported");
  assert.equal(W.isTransientModelRejection(400, THROTTLE_BODY), true);
  assert.equal(W.isTransientModelRejection(400, GENUINE_VALIDATION_BODY), false, "a malformed 400 must not fall back");
  assert.equal(W.isTransientModelRejection(422, THROTTLE_BODY), false, "non-400 status must not fall back");
});

test("resilient dispatch does NOT fall back on a genuine 400 and reports it verbatim", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  const tried = [];
  const send = async ({ model }) => {
    tried.push(model);
    return { response: new Response(GENUINE_VALIDATION_BODY, { status: 400 }) };
  };
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: { conversationState: { currentMessage: { userInputMessage: { modelId: "claude-opus-5" } }, history: [] } },
    send,
    acquire: async () => ({ ok: true, release: async () => {} }),
    markCooldown: async () => {},
    isCooledDown: async () => false,
    sleep: async () => {},
  });
  assert.equal(out.response.status, 400, "genuine 400 passes through");
  assert.deepEqual(tried, ["claude-opus-5"], "no fallback candidate attempted on a genuine 400");
  assert.equal(out.fallbackApplied, false);
});

// ------------------------------------------------- 3. cooldown skip + expiry

test("active cooldown skips the original model and expiry restores it", async () => {
  const q = newQuota();
  const inst = "model-gate:acc-A";
  // Mark opus cooled down on this account.
  const marked = await gate(q, "/model-gate/cooldown", { instance: inst, model: "claude-opus-5" });
  assert.equal(marked.status, 200, "/model-gate/cooldown responds ok");

  const during = await gate(q, "/model-gate/status", { instance: inst, model: "claude-opus-5" });
  assert.equal(during.json.cooledDown, true, "model is cooled down immediately after marking");

  // A different model on the same account is unaffected.
  const other = await gate(q, "/model-gate/status", { instance: inst, model: "gpt-5.6-sol" });
  assert.equal(other.json.cooledDown, false, "cooldown is per-model");

  // The DO must expose the remaining cooldown so the client can decide to skip.
  assert.ok(Number(during.json.cooldownMs) > 0, "status returns a positive remaining cooldownMs");
  assert.ok(W.MODEL_COOLDOWN_MS === 30000, "cooldown window is 30 seconds");
});

test("resilient dispatch consults cooldown BEFORE calling and skips straight to fallback", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  const tried = [];
  const send = async ({ model }) => {
    tried.push(model);
    return { response: new Response("ok", { status: 200 }) };
  };
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: { conversationState: { currentMessage: { userInputMessage: { modelId: "claude-opus-5" } }, history: [] } },
    send,
    acquire: async () => ({ ok: true, release: async () => {} }),
    markCooldown: async () => {},
    // opus is already cooling down; the first live attempt must be the fallback.
    isCooledDown: async (model) => model === "claude-opus-5",
    sleep: async () => {},
  });
  assert.equal(out.response.status, 200);
  assert.equal(tried[0], "claude-sonnet-5", "cooled-down original is skipped without an upstream call");
  assert.ok(!tried.includes("claude-opus-5"), "the cooled-down model is never called");
});

// ------------------------------ 4. premium gate serializes, isolates, expires

test("premium model gate serializes a second concurrent request via waitMs", async () => {
  assert.ok(W.isPremiumModel, "isPremiumModel must be exported");
  assert.equal(W.isPremiumModel("claude-opus-5"), true);
  assert.equal(W.isPremiumModel("claude-opus-4.8"), true);
  assert.equal(W.isPremiumModel("gpt-5.6-sol"), false);

  const q = newQuota();
  const inst = "model-gate:acc-A";
  const real = Date.now;
  try {
    let now = 2_000_000;
    Date.now = () => now;
    const first = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(first.json.ok, true, "first premium acquire is granted");
    assert.ok(first.json.leaseId, "acquire returns a leaseId to release later");

    const second = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(second.json.ok, false, "second premium acquire is denied while one is in flight");
    assert.ok(Number(second.json.waitMs) > 0);

    await gate(q, "/model-gate/release", { instance: inst, model: "claude-opus-5", leaseId: first.json.leaseId });
    const tooSoon = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(tooSoon.json.ok, false, "release frees concurrency but does not bypass start spacing");

    now += 1200;
    const third = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(third.json.ok, true, "granted after both slot and spacing are available");
  } finally {
    Date.now = real;
  }
});

test("non-premium gate allows two spaced in-flight requests then makes the third wait", async () => {
  const q = newQuota();
  const inst = "model-gate:acc-A";
  const real = Date.now;
  try {
    let now = 3_000_000;
    Date.now = () => now;
    const a = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    const tooSoon = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    assert.equal(a.json.ok, true);
    assert.equal(tooSoon.json.ok, false, "second slot cannot start in the same burst");

    now += 300;
    const b = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    const c = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    assert.equal(b.json.ok, true, "second in-flight slot opens after spacing");
    assert.equal(c.json.ok, false, "the third is throttled by max in-flight");
    assert.ok(Number(c.json.waitMs) > 0);
  } finally {
    Date.now = real;
  }
});

test("different account DO identities isolate their gates", async () => {
  // Two DO instances model two accounts. Filling one must not affect the other.
  const qA = newQuota();
  const qB = newQuota();
  const fillA = await gate(qA, "/model-gate/acquire", { instance: "model-gate:acc-A", model: "claude-opus-5" });
  const denyA = await gate(qA, "/model-gate/acquire", { instance: "model-gate:acc-A", model: "claude-opus-5" });
  const okB = await gate(qB, "/model-gate/acquire", { instance: "model-gate:acc-B", model: "claude-opus-5" });
  assert.equal(fillA.json.ok, true);
  assert.equal(denyA.json.ok, false, "account A is at capacity");
  assert.equal(okB.json.ok, true, "account B has its own independent slot");
});

test("model-gate instance name derives from a stable account identity", () => {
  assert.ok(W.modelGateInstanceName, "modelGateInstanceName must be exported");
  const name = W.modelGateInstanceName({ id: "acc-123", authMethod: "idc" });
  assert.match(name, /^model-gate:/, "instance name is namespaced under model-gate:");
  // Same account -> same instance name (stable); different account -> different.
  assert.equal(name, W.modelGateInstanceName({ id: "acc-123", authMethod: "idc" }));
  assert.notEqual(name, W.modelGateInstanceName({ id: "acc-999", authMethod: "idc" }));
});

test("a stale premium lease self-expires so a crashed worker cannot deadlock", async () => {
  assert.ok(W.MODEL_GATE_LEASE_TTL_MS, "MODEL_GATE_LEASE_TTL_MS must be exported");
  assert.ok(W.MODEL_GATE_LEASE_TTL_MS <= 2 * 60 * 1000 + 1, "lease TTL is around 2 minutes");

  const q = newQuota();
  const inst = "model-gate:acc-A";
  const real = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const first = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(first.json.ok, true);
    const denied = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(denied.json.ok, false, "held while lease is fresh");

    // Jump past the lease TTL without ever calling /release (simulated crash).
    now += W.MODEL_GATE_LEASE_TTL_MS + 1;
    const afterExpiry = await gate(q, "/model-gate/acquire", { instance: inst, model: "claude-opus-5" });
    assert.equal(afterExpiry.json.ok, true, "the stale lease has expired and the slot is reclaimed");
  } finally {
    Date.now = real;
  }
});

test("premium start spacing is at least ~1200ms and non-premium ~300ms", () => {
  assert.ok(W.MODEL_GATE, "MODEL_GATE policy table must be exported");
  const prem = W.MODEL_GATE.premium ?? W.MODEL_GATE["claude-opus"] ?? W.MODEL_GATE.opus;
  const other = W.MODEL_GATE.default ?? W.MODEL_GATE.other;
  assert.ok(prem && other, "policy has a premium and a default entry");
  assert.equal(prem.maxInFlight, 1, "premium max in-flight = 1");
  assert.ok(prem.spacingMs >= 1200, "premium spacing >= 1200ms");
  assert.equal(other.maxInFlight, 2, "non-premium max in-flight = 2");
  assert.ok(other.spacingMs >= 300 && other.spacingMs < 1200, "non-premium spacing ~300ms");
});

test("acquire enforces minimum start spacing between grants on the same model", async () => {
  const q = newQuota();
  const inst = "model-gate:acc-A";
  const real = Date.now;
  try {
    let now = 5_000_000;
    Date.now = () => now;
    // Acquire and immediately release, so in-flight count is 0 but a grant just happened.
    const g1 = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    assert.equal(g1.json.ok, true);
    await gate(q, "/model-gate/release", { instance: inst, model: "gpt-5.6-sol", leaseId: g1.json.leaseId });

    // A second acquire 10ms later must be spaced out even though nothing is in flight.
    now += 10;
    const g2 = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    assert.equal(g2.json.ok, false, "too soon after the previous grant");
    assert.ok(Number(g2.json.waitMs) > 0, "spacing violation returns waitMs");

    // Past the spacing window it is granted.
    now += 400;
    const g3 = await gate(q, "/model-gate/acquire", { instance: inst, model: "gpt-5.6-sol" });
    assert.equal(g3.json.ok, true, "granted once the spacing window has passed");
  } finally {
    Date.now = real;
  }
});

// ------------------- 5. permit held to EOF, released exactly once on end/cancel

test("permit is held while the body is unread and released exactly once at EOF", async () => {
  assert.ok(W.withReleaseOnBodyEnd, "withReleaseOnBodyEnd must be exported");
  let releases = 0;
  const release = async () => { releases++; };

  const { response, state } = makeStreamingResponse();
  const wrapped = W.withReleaseOnBodyEnd(response, release);

  // Not read yet: the permit must still be held.
  assert.equal(releases, 0, "permit is held before the body is consumed");

  // Push a frame then close: releases exactly once on EOF.
  state.push("hello");
  state.close();
  const text = await wrapped.text();
  assert.equal(text, "hello", "wrapper is transparent to the body content");
  assert.equal(releases, 1, "released exactly once at EOF");

  // Draining an already-finished body must not release again.
  assert.equal(releases, 1, "no double release after EOF");
});

test("permit is released exactly once on body cancellation", async () => {
  assert.ok(W.withReleaseOnBodyEnd, "withReleaseOnBodyEnd must be exported");
  let releases = 0;
  const { response } = makeStreamingResponse(["partial"]);
  const wrapped = W.withReleaseOnBodyEnd(response, async () => { releases++; });

  const reader = wrapped.body.getReader();
  await reader.read();            // consume one chunk
  await reader.cancel();          // client disconnects mid-stream
  // Cancel is one terminal event; release must fire once and only once.
  assert.equal(releases, 1, "released exactly once on cancel");
});

test("permit is released exactly once on a stream error", async () => {
  assert.ok(W.withReleaseOnBodyEnd, "withReleaseOnBodyEnd must be exported");
  let releases = 0;
  const { response, state } = makeStreamingResponse();
  const wrapped = W.withReleaseOnBodyEnd(response, async () => { releases++; });

  const reader = wrapped.body.getReader();
  state.error(new Error("upstream reset"));
  await reader.read().catch(() => {});
  assert.equal(releases, 1, "released exactly once on error");
});

// -------------------------------- 6. payload rebuild without mutation

function samplePayload(modelId) {
  return {
    conversationState: {
      conversationId: "fixed-id",
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      history: [
        { userInputMessage: { content: "prior", modelId, userInputMessageContext: {} } },
        { assistantResponseMessage: { content: "reply" } },
      ],
      currentMessage: {
        userInputMessage: {
          content: "now",
          modelId,
          userInputMessageContext: {
            tools: [{ toolSpecification: { name: "get_weather" } }],
          },
        },
      },
    },
  };
}

test("rebuild changes every modelId field consistently without mutating the original", () => {
  assert.ok(W.rebuildPayloadWithModel, "rebuildPayloadWithModel must be exported");
  const original = samplePayload("claude-opus-5");
  const snapshot = JSON.parse(JSON.stringify(original));

  const rebuilt = W.rebuildPayloadWithModel(original, "gpt-5.6-sol");

  // Original object is untouched (no mutation / no reuse of a consumed body).
  assert.deepEqual(original, snapshot, "original payload is not mutated");
  assert.notEqual(rebuilt, original, "rebuild returns a fresh object");

  // Every modelId in the rebuilt payload is the new model.
  assert.equal(rebuilt.conversationState.currentMessage.userInputMessage.modelId, "gpt-5.6-sol");
  assert.equal(rebuilt.conversationState.history[0].userInputMessage.modelId, "gpt-5.6-sol");

  // Tools / history / structure are preserved.
  assert.deepEqual(
    rebuilt.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools,
    original.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools,
    "tools are preserved",
  );
  assert.equal(rebuilt.conversationState.history.length, 2, "history is preserved");
  assert.equal(rebuilt.conversationState.chatTriggerType, "MANUAL");
});

test("rebuild preserves thinking configuration when present", () => {
  assert.ok(W.rebuildPayloadWithModel, "rebuildPayloadWithModel must be exported");
  const original = samplePayload("claude-opus-5");
  original.conversationState.currentMessage.userInputMessage.userInputMessageContext.thinking =
    { type: "enabled", budget_tokens: 2048 };
  const rebuilt = W.rebuildPayloadWithModel(original, "claude-sonnet-5");
  assert.deepEqual(
    rebuilt.conversationState.currentMessage.userInputMessage.userInputMessageContext.thinking,
    { type: "enabled", budget_tokens: 2048 },
    "thinking config survives the rebuild",
  );
});

// -------------------- 7. exhaustion -> normalized 429; success -> metadata

test("all candidate models throttling yields a normalized 429 with Retry-After", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  const send = async () => ({ response: new Response(THROTTLE_BODY, { status: 400 }) });
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: samplePayload("claude-opus-5"),
    send,
    acquire: async () => ({ ok: true, release: async () => {} }),
    markCooldown: async () => {},
    isCooledDown: async () => false,
    sleep: async () => {},
  });
  assert.equal(out.response.status, 429, "exhaustion is normalized to 429, never a raw 400");
  assert.equal(out.response.headers.get("Retry-After"), "3", "Retry-After is preserved");
});

test("a successful fallback carries requested/actual metadata for response headers", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  const send = async ({ model }) => {
    if (model === "claude-opus-5") return { response: new Response(THROTTLE_BODY, { status: 400 }) };
    return { response: new Response("ok", { status: 200 }) };
  };
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: samplePayload("claude-opus-5"),
    send,
    acquire: async () => ({ ok: true, release: async () => {} }),
    markCooldown: async () => {},
    isCooledDown: async () => false,
    sleep: async () => {},
  });
  assert.equal(out.response.status, 200);
  assert.equal(out.requestedModel, "claude-opus-5");
  assert.equal(out.actualModel, "claude-sonnet-5", "actual model is the successful fallback");
  assert.equal(out.fallbackApplied, true, "fallbackApplied flag is set so headers can be added");
});

test("cooling down the throttled model is recorded before falling back", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  const cooled = [];
  const send = async ({ model }) => {
    if (model === "claude-opus-5") return { response: new Response(THROTTLE_BODY, { status: 400 }) };
    return { response: new Response("ok", { status: 200 }) };
  };
  await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: samplePayload("claude-opus-5"),
    send,
    acquire: async () => ({ ok: true, release: async () => {} }),
    markCooldown: async (model) => { cooled.push(model); },
    isCooledDown: async () => false,
    sleep: async () => {},
  });
  assert.deepEqual(cooled, ["claude-opus-5"], "the throttled model is cooled down exactly once");
});

// ---------------------- 8. no permit leaks on failure / token refresh

test("a failed candidate releases its permit before trying the next model", async () => {
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  let acquired = 0;
  let released = 0;
  const send = async ({ model }) => {
    if (model === "claude-opus-5") return { response: new Response(THROTTLE_BODY, { status: 400 }) };
    return { response: new Response("ok", { status: 200 }) };
  };
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: samplePayload("claude-opus-5"),
    send,
    acquire: async () => { acquired++; return { ok: true, release: async () => { released++; } }; },
    markCooldown: async () => {},
    isCooledDown: async () => false,
    sleep: async () => {},
  });
  assert.equal(out.response.status, 200);
  // Two candidates attempted (opus throttled, sonnet ok) => two permits, and the
  // throttled one must be released before the sonnet permit is acquired.
  assert.equal(acquired, 2, "one permit per candidate attempt");
  // The failed candidate's permit is released synchronously; the successful
  // candidate's permit is handed to the body-end wrapper, so at least the
  // failed one has been released by return.
  assert.ok(released >= 1, "the failed candidate's permit is released, not leaked");
});

test("a reactive token refresh retry does not acquire a second permit for the same attempt", async () => {
  // Token refresh is an inner retry of the SAME model attempt; it must reuse the
  // permit already held, never leak or double-acquire. We model send() as first
  // returning a 403 bearer-token rejection then succeeding after refresh.
  assert.ok(W.callKiroResilient, "callKiroResilient must be exported");
  let acquired = 0;
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) return { response: new Response("The bearer token included in the request is invalid", { status: 403 }) };
    return { response: new Response("ok", { status: 200 }) };
  };
  const out = await W.callKiroResilient({
    requestedModel: "claude-sonnet-5",
    payload: samplePayload("claude-sonnet-5"),
    send,
    acquire: async () => { acquired++; return { ok: true, release: async () => {} }; },
    markCooldown: async () => {},
    isCooledDown: async () => false,
    sleep: async () => {},
    // The dispatcher is told this attempt did a reactive refresh; it is still ONE
    // logical candidate attempt and must hold ONE permit.
    onTokenRefresh: async () => true,
  });
  assert.equal(out.response.status, 200);
  assert.equal(acquired, 1, "the reactive refresh retry reuses the single permit for that candidate");
});

// ======================= production wiring integration regression ===========
// The unit tests above deliberately inject acquire/send/cooldown functions. That
// is not enough: a previous implementation made every helper pass but forgot to
// call it from /v1/messages and /v1/chat/completions. This section drives the
// exported default Worker handler and real ApiKeyQuota instances so dead wiring
// can never look green again.

function integrationFrame(eventType, payloadObj, extraHeaders = {}) {
  const enc = new TextEncoder();
  const payload = enc.encode(JSON.stringify(payloadObj));
  const headers = { ":event-type": eventType, ":message-type": "event", ...extraHeaders };
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
  const headerLen = parts.reduce((sum, part) => sum + part.length, 0);
  const totalLen = 12 + headerLen + payload.length + 4;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLen, false);
  view.setUint32(4, headerLen, false);
  view.setUint32(8, 0, false);
  let offset = 12;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  out.set(payload, offset); offset += payload.length;
  view.setUint32(offset, 0, false);
  return out;
}

function integrationEventStream() {
  const frames = [
    integrationFrame("assistantResponseEvent", { content: "fallback ok" }),
    integrationFrame("metadataEvent", { stopReason: "END_TURN", inputTokenCount: 9, outputTokenCount: 3 }),
  ];
  const size = frames.reduce((sum, f) => sum + f.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const f of frames) { bytes.set(f, offset); offset += f.length; }
  return bytes;
}


function integrationEmptyEventStream() {
  return integrationFrame("metadataEvent", {
    stopReason: "END_TURN",
    inputTokenCount: 0,
    outputTokenCount: 0,
  });
}
function integrationThrottleEventStream() {
  return integrationFrame("", {
    message: "Invalid model. Please select a different model to continue.",
    reason: "INVALID_MODEL_ID",
  }, {
    ":message-type": "exception",
    ":exception-type": "ValidationException",
  });
}

function makeIntegrationNamespace() {
  const instances = new Map();
  const operations = [];
  const namespace = {
    instances,
    operations,
    idFromName(name) { return String(name); },
    get(id) {
      if (!instances.has(id)) {
        const storage = new DOStorage();
        instances.set(id, { storage, object: new W.ApiKeyQuota({ storage }) });
      }
      const instance = instances.get(id).object;
      return {
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          let body = {};
          if (request.method === "POST") {
            try { body = await request.clone().json(); } catch {}
          }
          operations.push({ id: String(id), path: new URL(request.url).pathname, body });
          return instance.fetch(request);
        },
      };
    },
  };
  return namespace;
}

function makeIntegrationEnv() {
  const account = {
    id: "acc-integration",
    email: "integration@example.test",
    authMethod: "api_key",
    region: "us-east-1",
    kiroApiKey: "ksk_integration",
    accessToken: "ksk_integration",
    enabled: true,
    usageCurrent: 0,
    usageLimit: 10000,
  };
  const clientKey = {
    id: "key-integration",
    name: "integration",
    key: "client-integration",
    enabled: true,
    creditLimit: 0,
    creditsUsed: 0,
    modelUsage: {},
  };
  const values = new Map([
    ["config:accounts", JSON.stringify([account])],
    ["config:api_keys", JSON.stringify([clientKey])],
    ["config:settings", JSON.stringify({ requireApiKey: true })],
  ]);
  const kv = {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
  };
  const namespace = makeIntegrationNamespace();
  return { env: { KIRO_KV: kv, API_KEY_QUOTA: namespace }, namespace };
}

function integrationCtx() {
  const pending = [];
  return {
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    async drain() { await Promise.allSettled(pending); },
  };
}

async function runProductionFallbackScenario(endpoint, stream, { inStreamThrottle = false, emptyOriginal = false } = {}) {
  assert.ok(W.worker?.fetch, "default Worker fetch handler must be loaded");
  const { env, namespace } = makeIntegrationEnv();
  const ctx = integrationCtx();
  const upstreamModels = [];
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(String(init.body || "{}"));
    const model = payload?.conversationState?.currentMessage?.userInputMessage?.modelId;
    upstreamModels.push(model);
    if (model === "claude-opus-5") {
      if (emptyOriginal) {
        return new Response(integrationEmptyEventStream(), {
          status: 200,
          headers: { "Content-Type": "application/vnd.amazon.eventstream" },
        });
      }
      if (inStreamThrottle) {
        return new Response(integrationThrottleEventStream(), {
          status: 200,
          headers: { "Content-Type": "application/vnd.amazon.eventstream" },
        });
      }
      return new Response(THROTTLE_BODY, { status: 400 });
    }
    return new Response(integrationEventStream(), {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    });
  };

  try {
    const isClaude = endpoint === "/v1/messages";
    const requestBody = isClaude
      ? { model: "claude-opus-5", max_tokens: 128, stream, messages: [{ role: "user", content: "hello" }] }
      : { model: "claude-opus-5", stream, messages: [{ role: "user", content: "hello" }] };
    const response = await W.worker.fetch(new Request(`https://gateway.test${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer client-integration",
        ...(isClaude ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(requestBody),
    }), env, ctx);

    assert.equal(response.status, 200, `${endpoint} stream=${stream} status`);
    assert.equal(response.headers.get("X-Kiro-Actual-Model"), "claude-sonnet-5");
    assert.equal(
      response.headers.get("X-Kiro-Model-Fallback"),
      "claude-opus-5 -> claude-sonnet-5",
      "fallback is transparent in headers",
    );
    const output = await response.text();
    if (stream) {
      assert.match(output, /fallback ok/);
      assert.match(output, /"model":"claude-opus-5"/, "stream JSON keeps requested model");
    } else {
      const parsed = JSON.parse(output);
      assert.equal(parsed.model, "claude-opus-5", "non-stream JSON keeps requested model");
      assert.match(JSON.stringify(parsed), /fallback ok/);
    }
    await ctx.drain();

    assert.deepEqual(
      upstreamModels,
      ["claude-opus-5", "claude-opus-5", "claude-opus-5", "claude-opus-5", "claude-sonnet-5"],
      inStreamThrottle
        ? "HTTP-200 exception frames use the bounded same-model ramp before fallback"
        : emptyOriginal
          ? "metadata-only empty streams retry the same model before fallback"
          : "HTTP model throttles use the bounded same-model ramp before fallback",
    );
    const gateOps = namespace.operations.filter((op) => op.id === "model-gate:acc-integration");
    assert.ok(gateOps.some((op) => op.path === "/model-gate/acquire" && op.body.model === "claude-opus-5"));
    const cooledOriginal = gateOps.some(
      (op) => op.path === "/model-gate/cooldown" && op.body.model === "claude-opus-5",
    );
    assert.equal(cooledOriginal, !emptyOriginal, "only INVALID_MODEL_ID writes model cooldown");
    assert.ok(gateOps.some((op) => op.path === "/model-gate/acquire" && op.body.model === "claude-sonnet-5"));
    assert.equal(
      gateOps.filter((op) => op.path === "/model-gate/release").length,
      2,
      "failed original and successful fallback each release exactly one permit",
    );

    const gate = namespace.get("model-gate:acc-integration");
    for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
      const state = await gate.fetch("https://model-gate/model-gate/status", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      });
      assert.equal((await state.json()).inFlight, 0, `${model} has no leaked permit`);
    }
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
}

test("production handlers really wire gate + cooldown + fallback in all API modes", async (t) => {
  for (const endpoint of ["/v1/chat/completions", "/v1/messages"]) {
    for (const stream of [false, true]) {
      await t.test(`${endpoint} stream=${stream}`, async () => {
        await runProductionFallbackScenario(endpoint, stream);
      });
    }
  }
});


test("production preflight falls back before exposing an HTTP-200 exception stream", async () => {
  await runProductionFallbackScenario("/v1/chat/completions", true, { inStreamThrottle: true });
});


test("direct /generateAssistantResponse acquires and releases a model-gate permit", async () => {
  const { env, namespace } = makeIntegrationEnv();
  const ctx = integrationCtx();
  const realFetch = globalThis.fetch;
  const seenModels = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(String(init.body || "{}"));
    seenModels.push(payload?.conversationState?.currentMessage?.userInputMessage?.modelId);
    return new Response(integrationEventStream(), {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    });
  };

  try {
    const response = await W.worker.fetch(new Request("https://gateway.test/generateAssistantResponse", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "Authorization": "Bearer client-integration",
      },
      body: JSON.stringify({
        conversationState: {
          currentMessage: { userInputMessage: { content: "hi", modelId: "claude-opus-5" } },
          history: [],
        },
      }),
    }), env, ctx);

    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await ctx.drain();
    assert.deepEqual(seenModels, ["claude-opus-5"]);

    const gateOps = namespace.operations.filter((op) => op.id === "model-gate:acc-integration");
    assert.ok(gateOps.some((op) => op.path === "/model-gate/acquire" && op.body.model === "claude-opus-5"));
    assert.equal(gateOps.filter((op) => op.path === "/model-gate/release").length, 1);

    const status = await namespace.get("model-gate:acc-integration").fetch(
      "https://model-gate/model-gate/status",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5" }) },
    );
    assert.equal((await status.json()).inFlight, 0, "direct path leaves no permit after body EOF");
  } finally {
    globalThis.fetch = realFetch;
  }
});


test("production preflight falls back on metadata-only empty stream before 502", async () => {
  await runProductionFallbackScenario("/v1/chat/completions", false, { emptyOriginal: true });
});


test("all empty fallback candidates return overloaded 503 without model cooldown", async () => {
  let cooldowns = 0;
  let releases = 0;
  const out = await W.callKiroResilient({
    requestedModel: "claude-opus-5",
    payload: samplePayload("claude-opus-5"),
    send: async () => ({
      response: new Response('{"error":"empty"}', {
        status: 503,
        headers: { "X-Kiro-Transient-Empty": "1" },
      }),
    }),
    acquire: async () => ({ ok: true, release: async () => { releases++; } }),
    markCooldown: async () => { cooldowns++; },
    isCooledDown: async () => false,
  });
  assert.equal(out.response.status, 503);
  assert.equal(out.response.headers.get("Retry-After"), "3");
  assert.equal(cooldowns, 0, "empty capacity symptom is not INVALID_MODEL_ID cooldown");
  assert.equal(releases, 3, "each candidate releases its own permit");
});


function fragmentedEventResponse(bytes, cuts = [3, 11, 19]) {
  const chunks = [];
  let start = 0;
  for (const end of cuts) {
    if (start < bytes.length) chunks.push(bytes.slice(start, Math.min(end, bytes.length)));
    start = Math.min(end, bytes.length);
  }
  if (start < bytes.length) chunks.push(bytes.slice(start));
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
}

test("preflight replays fragmented housekeeping + productive frames byte-for-byte", async () => {
  assert.ok(W.preflightKiroEventStream);
  const first = integrationEmptyEventStream();
  const second = integrationFrame("assistantResponseEvent", { content: "hello" });
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first, 0); bytes.set(second, first.length);
  const replayed = await W.preflightKiroEventStream(fragmentedEventResponse(bytes));
  assert.equal(replayed.status, 200);
  assert.deepEqual(new Uint8Array(await replayed.arrayBuffer()), bytes);
});

test("preflight marks true zero-output EOF empty but preserves billable output metadata", async () => {
  const empty = await W.preflightKiroEventStream(new Response(integrationEmptyEventStream(), {
    headers: { "Content-Type": "application/vnd.amazon.eventstream" },
  }));
  assert.equal(empty.status, 503);
  assert.equal(empty.headers.get("X-Kiro-Transient-Empty"), "1");

  const meteredBytes = integrationFrame("meteringEvent", { outputTokenCount: 3 });
  const metered = await W.preflightKiroEventStream(fragmentedEventResponse(meteredBytes, [1, 7, 13, 27]));
  assert.equal(metered.status, 200, "nonzero output tokens are productive/billable");
  assert.deepEqual(new Uint8Array(await metered.arrayBuffer()), meteredBytes);
});

test("a bare tool input fragment without id/name is not a completed tool call", async () => {
  const bare = integrationFrame("toolUseEvent", { input: '{"city":"Hanoi"}' });
  const response = await W.preflightKiroEventStream(new Response(bare, {
    headers: { "Content-Type": "application/vnd.amazon.eventstream" },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Kiro-Transient-Empty"), "1");
});

test("an id-only tool fragment is empty but a name-only tool remains productive", async () => {
  const idOnly = integrationFrame("toolUseEvent", { toolUseId: "toolu_orphan" });
  const empty = await W.preflightKiroEventStream(new Response(idOnly, {
    headers: { "Content-Type": "application/vnd.amazon.eventstream" },
  }));
  assert.equal(empty.status, 503, "the parser cannot emit a tool call without its name");
  assert.equal(empty.headers.get("X-Kiro-Transient-Empty"), "1");

  const nameOnly = integrationFrame("toolUseEvent", { name: "read_file" });
  const productive = await W.preflightKiroEventStream(new Response(nameOnly, {
    headers: { "Content-Type": "application/vnd.amazon.eventstream" },
  }));
  assert.equal(productive.status, 200, "the assembler can generate a missing tool ID");
  assert.deepEqual(new Uint8Array(await productive.arrayBuffer()), nameOnly);
});

test("preflight scans Kiro streams mislabeled as x-amz-json", async () => {
  const response = await W.preflightKiroEventStream(new Response(integrationEmptyEventStream(), {
    headers: { "Content-Type": "application/x-amz-json-1.0" },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Kiro-Transient-Empty"), "1");
});

test("structured assistant/reasoning placeholders are not productive output", async () => {
  for (const [eventType, payload] of [
    ["assistantResponseEvent", { content: [] }],
    ["assistantResponseEvent", { content: {} }],
    ["reasoningContentEvent", { reasoningContent: {} }],
    ["meteringEvent", { credits: "1" }],
  ]) {
    const response = await W.preflightKiroEventStream(new Response(integrationFrame(eventType, payload), {
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    }));
    assert.equal(response.status, 503, `${eventType} ${JSON.stringify(payload)} must be retried`);
    assert.equal(response.headers.get("X-Kiro-Transient-Empty"), "1");
  }
});

test("preflight scans valid event streams under a generic JSON Content-Type", async () => {
  const bytes = integrationFrame("assistantResponseEvent", { content: "hello" });
  const response = await W.preflightKiroEventStream(new Response(bytes, {
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("malformed HTTP-200 body becomes retryable before client SSE starts", async () => {
  const response = await W.preflightKiroEventStream(new Response('{"status":"ok"}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Kiro-Transient-Empty"), "1");
  assert.match(await response.text(), /invalid AWS event-stream prelude/i);
});
