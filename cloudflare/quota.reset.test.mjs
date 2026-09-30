// Regression tests for the ApiKeyQuota Durable Object's live-usage mirror.
//
// The dashboard at /check reports max(KV, DO stats). That made two admin
// actions silently undo themselves on the next request or poll:
//   1. Reset usage zeroed "used" but left "stats" behind, and /usage treats
//      stats.credits as a floor for "used".
//   2. Editing tokens/requests wrote KV only, so the stale DO mirror won.
//
// Run: node cloudflare/quota.reset.test.mjs
import assert from "node:assert/strict";
import { ApiKeyQuota } from "./worker.gateway.js";

// Minimal stand-in for the DO storage API: get/put/delete over a Map, matching
// the multi-key put({...}) and delete([...]) forms the worker actually uses.
function makeStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key);
    },
    async put(keyOrObj, value) {
      if (typeof keyOrObj === "object" && keyOrObj !== null) {
        for (const [k, v] of Object.entries(keyOrObj)) map.set(k, v);
        return;
      }
      map.set(keyOrObj, value);
    },
    async delete(key) {
      if (Array.isArray(key)) {
        key.forEach((k) => map.delete(k));
        return;
      }
      map.delete(key);
    },
    async deleteAll() {
      map.clear();
    },
  };
}

function makeDO() {
  const storage = makeStorage();
  return { quota: new ApiKeyQuota({ storage }), storage };
}

function post(quota, path, body) {
  return quota.fetch(
    new Request(`https://quota${path}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  );
}

function get(quota, path) {
  return quota.fetch(new Request(`https://quota${path}`));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Simulates a finished request: this is what recordRequestStats mirrors in.
async function meter(quota, { credits = 0, tokensIn = 0, tokensOut = 0 } = {}) {
  return (
    await post(quota, "/usage", {
      inc: { requests: 1, tokensIn, tokensOut, credits },
      applyToUsed: true,
    })
  ).json();
}

test("reset clears the live mirror so usage cannot come back", async () => {
  const { quota } = makeDO();

  await meter(quota, { credits: 0.31, tokensIn: 553, tokensOut: 1474 });
  let state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 0.31, "metered credits should land in used");
  assert.equal(state.stats.requests, 1);

  // Admin presses "Reset usage".
  await post(quota, "/sync", { used: 0, clearStats: true });

  state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 0, "reset must zero used");
  assert.equal(state.stats, null, "reset must drop the stats mirror");
  assert.deepEqual(state.logs, [], "reset must drop the live logs");

  // The next request must start from zero, not resurrect the old 0.31.
  const after = await meter(quota, { credits: 0.02, tokensOut: 10 });
  assert.equal(after.used, 0.02, "usage must resume from zero after a reset");
  assert.equal(after.stats.requests, 1, "request count must restart at 1");
  assert.equal(after.stats.tokensOut, 10);
});

test("reset without clearStats would resurrect usage (documents the old bug)", async () => {
  const { quota } = makeDO();
  await meter(quota, { credits: 0.31 });

  // The pre-fix behaviour: zero "used" but leave "stats" in place.
  await post(quota, "/sync", { used: 0 });
  const state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 0);
  // The fix pulls the credit floor down with the balance, so the next request
  // no longer springs back to 0.31.
  assert.equal(state.stats.credits, 0, "credit floor must follow the new balance");

  const after = await meter(quota, { credits: 0.02 });
  assert.equal(after.used, 0.02, "old balance must not be restored by stats.credits");
});

test("admin balance edit keeps history but moves the credit floor", async () => {
  const { quota } = makeDO();
  await meter(quota, { credits: 5, tokensIn: 100, tokensOut: 200 });

  // Admin edits creditsUsed down to 1 without asking for a full reset.
  await post(quota, "/sync", { used: 1 });

  const state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 1, "edited balance must stick");
  assert.equal(state.stats.requests, 1, "request history must survive an edit");
  assert.equal(state.stats.tokensIn, 100, "token history must survive an edit");
  assert.equal(state.stats.credits, 1, "credit floor must follow the edit");

  const after = await meter(quota, { credits: 0.5 });
  assert.equal(after.used, 1.5, "usage must accumulate from the edited balance");
});

test("admin counter edit is mirrored into the live stats", async () => {
  const { quota } = makeDO();
  await meter(quota, { credits: 1, tokensIn: 553, tokensOut: 1474 });
  await meter(quota, { credits: 1, tokensIn: 100, tokensOut: 200 });

  let state = await (await get(quota, "/state")).json();
  assert.equal(state.stats.requests, 2);
  assert.equal(state.stats.tokens, 553 + 1474 + 100 + 200);

  // Admin zeroes the counters but leaves credits alone.
  await post(quota, "/sync", {
    used: 2,
    stats: { requests: 0, tokensIn: 0, tokensOut: 0 },
  });

  state = await (await get(quota, "/state")).json();
  assert.equal(state.stats.requests, 0, "edited request count must win");
  assert.equal(state.stats.tokensIn, 0);
  assert.equal(state.stats.tokensOut, 0);
  assert.equal(state.stats.tokens, 0, "derived total must follow the edit");
  assert.equal(state.used, 2, "credits must be untouched by a counter edit");
});

test("a credit limit still caps stored usage", async () => {
  const { quota } = makeDO();
  await post(quota, "/reserve", { used: 0, limit: 10, amount: 0.01 });
  await post(quota, "/settle", { reservation: 0.01, charge: 999 });

  const state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 10, "settlement must not run past the ceiling");
});

test("unlimited keys accumulate through the usage mirror", async () => {
  const { quota } = makeDO();
  // No limit set, so /reserve is never called and /settle never advances used.
  await meter(quota, { credits: 0.1 });
  await meter(quota, { credits: 0.25 });

  const state = await (await get(quota, "/state")).json();
  assert.equal(state.used, 0.35, "unlimited usage must still be tracked");
  assert.equal(state.stats.requests, 2);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
