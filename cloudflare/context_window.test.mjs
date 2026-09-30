// Regression suite for the context window published on /v1/models.
//
// Run:  node --test cloudflare/context_window.test.mjs
//
// Regression suite for the explicit 1M context catalog override. The override
// controls client-side context sizing only; Kiro upstream may still enforce a
// lower request threshold, which the resilience path handles separately.

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
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-ctx-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(
    file,
    src + `
export { contextWindowForModel, normalizeTokenLimits, syncKiroModels, FALLBACK_MODELS, FORCED_CONTEXT_WINDOW };
`,
  );
  return import(file);
}

test("Claude and auto models always advertise the forced 1M window", async () => {
  const { contextWindowForModel, FORCED_CONTEXT_WINDOW } = await loadWorker();
  assert.equal(FORCED_CONTEXT_WINDOW, 1_000_000);

  for (const model of [
    "claude-opus-5",
    "claude-opus-5-thinking",
    "CLAUDE-OPUS-5",
    "claude-opus-5.1",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4.8",
    "claude-opus-4-8",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "claude-opus-4.5",
    "claude-3-5-sonnet",
    "auto",
  ]) {
    assert.equal(contextWindowForModel(model), 1_000_000, `${model} should advertise 1M`);
  }
});

test("forced Claude window wins while non-Claude still honors upstream tokenLimits", async () => {
  const { contextWindowForModel, normalizeTokenLimits } = await loadWorker();
  const info = { tokenLimits: { maxInputTokens: 196_000, maxOutputTokens: 16_384 } };

  assert.deepEqual(normalizeTokenLimits(info), {
    maxInputTokens: 196_000,
    maxOutputTokens: 16_384,
  });
  assert.equal(contextWindowForModel("claude-opus-4.7", info), 1_000_000);
  assert.equal(contextWindowForModel("claude-opus-4.7-thinking", info), 1_000_000);
  assert.equal(
    contextWindowForModel("gpt-5.6-sol", info),
    196_000,
    "non-Claude models should keep a real upstream limit",
  );
});

test("model sync preserves upstream tokenLimits in KV", async () => {
  const worker = await loadWorker();
  const store = new Map([
    ["config:accounts", JSON.stringify([{
      id: "acc-test",
      enabled: true,
      authMethod: "api_key",
      region: "us-east-1",
      accessToken: "ksk_test",
    }])],
  ]);
  const env = {
    KIRO_KV: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => store.set(key, value),
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    models: [{
      modelId: "claude-opus-4.7",
      modelName: "Claude Opus 4.7",
      tokenLimits: { maxInputTokens: 196_000, maxOutputTokens: 16_384 },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const result = await worker.syncKiroModels(env);
    assert.equal(result.ok, true);
    const stored = JSON.parse(store.get("config:models"));
    for (const id of ["claude-opus-4.7", "claude-opus-4.7-thinking"]) {
      const model = stored.find((item) => item.modelId === id);
      assert.ok(model, `${id} was not synced`);
      assert.deepEqual(model.tokenLimits, {
        maxInputTokens: 196_000,
        maxOutputTokens: 16_384,
      });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("unrecognised models publish nothing rather than a guess", async () => {
  const { contextWindowForModel } = await loadWorker();

  // Advertising a guessed-low window would cap clients that would otherwise use
  // the model's own default, so these must return null (field omitted).
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "kimi-k3-free", "", null, undefined]) {
    assert.equal(contextWindowForModel(model), null, `${model} should be omitted`);
  }
});

test("every advertised Claude model in the catalog carries a window", async () => {
  const { contextWindowForModel, FALLBACK_MODELS } = await loadWorker();

  const claudeModels = FALLBACK_MODELS.filter((id) => id.startsWith("claude-") || id === "auto");
  assert.ok(claudeModels.length > 0, "catalog should list Claude models");

  for (const id of claudeModels) {
    const window = contextWindowForModel(id);
    assert.ok(window > 0, `${id} must publish a context window, got ${window}`);
  }
});

test("/v1/models publishes forced 1M under every client alias", async () => {
  const worker = await loadWorker();

  const env = {
    // No synced catalog in KV → the explicit Claude override still applies.
    KIRO_KV: { get: async () => null, put: async () => {} },
  };

  const resp = await worker.default.fetch(
    new Request("https://gateway.test/v1/models", { headers: { authorization: "Bearer test" } }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(resp.status, 200, `expected 200, got ${resp.status}`);
  const body = await resp.json();
  const opus5 = body.data.find((m) => m.id === "claude-opus-5");
  assert.ok(opus5, "claude-opus-5 missing from /v1/models");

  for (const key of ["context_window", "context_length", "max_input_tokens"]) {
    assert.equal(opus5[key], 1_000_000, `${key} = ${opus5[key]}, want forced 1000000`);
  }

  // Models with no known window must not carry a fabricated one.
  const gpt = body.data.find((m) => m.id === "gpt-5.6-sol");
  if (gpt) {
    assert.equal(gpt.context_window, undefined, "gpt-5.6-sol should not advertise a window");
  }
});

test("/v1/models forces 1M for base/thinking while preserving output limits", async () => {
  const worker = await loadWorker();
  const synced = [{
    modelId: "claude-opus-4.7",
    modelName: "Claude Opus 4.7",
    tokenLimits: { maxInputTokens: 196_000, maxOutputTokens: 16_384 },
  }];
  const env = {
    KIRO_KV: {
      get: async (key) => key === "config:models" ? JSON.stringify(synced) : null,
      put: async () => {},
    },
  };

  const resp = await worker.default.fetch(
    new Request("https://gateway.test/v1/models", { headers: { authorization: "Bearer test" } }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(resp.status, 200);
  const body = await resp.json();

  for (const id of ["claude-opus-4.7", "claude-opus-4.7-thinking"]) {
    const model = body.data.find((m) => m.id === id);
    assert.ok(model, `${id} missing`);
    assert.equal(model.context_window, 1_000_000, `${id} should use the forced 1M window`);
    assert.equal(model.max_output_tokens, 16_384, `${id} should inherit maxOutputTokens`);
  }
});
