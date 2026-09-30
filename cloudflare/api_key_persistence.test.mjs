// Run: node --test cloudflare/api_key_persistence.test.mjs
//
// Cloudflare KV is eventually consistent. A key creation must remain visible
// through the admin API even when the edge still serves the pre-write KV value.
// The admin API must also never report success when no durable store exists.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-api-key-persistence-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __persistenceInternals = { recordRequestStats };
`);
  return import(file);
}

const workerModule = await loadWorker();
const worker = workerModule.default;
const { ApiKeyQuota } = workerModule;
const { recordRequestStats } = workerModule.__persistenceInternals;

function makeStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key);
    },
    async put(keyOrObject, value) {
      if (typeof keyOrObject === "object" && keyOrObject !== null) {
        for (const [key, item] of Object.entries(keyOrObject)) map.set(key, item);
        return;
      }
      map.set(keyOrObject, value);
    },
    async delete(keyOrKeys) {
      if (Array.isArray(keyOrKeys)) {
        keyOrKeys.forEach((key) => map.delete(key));
        return;
      }
      map.delete(keyOrKeys);
    },
    async deleteAll() {
      map.clear();
    },
  };
}

function makeDurableObjectNamespace() {
  const instances = new Map();
  return {
    idFromName(name) {
      return String(name);
    },
    get(id) {
      if (!instances.has(id)) {
        const storage = makeStorage();
        instances.set(id, { storage, object: new ApiKeyQuota({ storage }) });
      }
      const instance = instances.get(id).object;
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return instance.fetch(request);
        },
      };
    },
  };
}

function makeEventuallyConsistentKV(initialApiKeys = []) {
  const initialRaw = JSON.stringify(initialApiKeys);
  const values = new Map([["config:api_keys", initialRaw]]);
  let serveStaleApiKeys = true;
  return {
    values,
    setServeStaleApiKeys(value) {
      serveStaleApiKeys = Boolean(value);
    },
    async get(key) {
      if (key === "config:api_keys" && serveStaleApiKeys) return initialRaw;
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function adminRequest(pathname, { method = "GET", body, source = "kirogo" } = {}) {
  const headers = {
    "X-Admin-Password": "test-password",
    "X-Kiro-Source": source,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://gateway.test/admin/api${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function baseEnv(kv) {
  return {
    ADMIN_PASSWORD: "test-password",
    KIRO_KV: kv,
    KIROPOOL_KV: kv,
    API_KEY_QUOTA: makeDurableObjectNamespace(),
  };
}

const existingKey = {
  id: "key-existing",
  name: "existing",
  key: "sk-existing",
  enabled: true,
  requests: 0,
  requestsCount: 0,
  credits: 0,
  creditsUsed: 0,
  tokens: 0,
  tokensUsed: 0,
  tokensIn: 0,
  tokensOut: 0,
  modelUsage: {},
};

test("a newly created API key survives stale KV reads and background usage writes", async () => {
  const kv = makeEventuallyConsistentKV([existingKey]);
  const env = baseEnv(kv);

  const createdResponse = await worker.fetch(
    adminRequest("/api-keys", { method: "POST", body: { name: "survives-reload", enabled: true } }),
    env,
    {},
  );
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.success, true);
  assert.ok(created.id);

  // A request that started from the old catalog used to write the whole stale
  // array back to KV, deleting the entry created above.
  await recordRequestStats(env, null, true, 12, 34, 0.25, null, existingKey.id, "", "auto");

  // Simulate an immediate F5 at an edge location whose KV cache still contains
  // the value from before POST /api-keys.
  const listResponse = await worker.fetch(adminRequest("/api-keys"), env, {});
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.ok(
    listed.apiKeys.some((entry) => entry.id === created.id && entry.name === "survives-reload"),
    "the created key must be served from strongly consistent storage",
  );

  const existing = listed.apiKeys.find((entry) => entry.id === existingKey.id);
  assert.equal(existing.requestsCount, 1, "usage updates must remain visible without replacing the catalog");
});

test("API-key creation fails instead of reporting success without durable storage", async () => {
  const env = { ADMIN_PASSWORD: "test-password" };
  const response = await worker.fetch(
    adminRequest("/api-keys", { method: "POST", body: { name: "cannot-persist" } }),
    env,
    {},
  );
  const payload = await response.json();
  assert.equal(response.ok, false);
  assert.equal(payload.success, false);
  assert.match(payload.error || "", /storage|KV|persist/i);
});
