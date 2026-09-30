//
// Run:  node --test cloudflare/token_refresh.test.mjs
//
// Symptom these all share: the gateway had no way to renew an IdC / Builder ID
// credential. The only refresh implemented was the Kiro desktop endpoint, which
// serves "social" credentials, and nothing on the request path ever called it. AWS
// issues an IdC access token with a one hour lifetime, so once an hour every
// request — every model, every endpoint — started answering
// 403 "The bearer token included in the request is invalid" and stayed broken until
// somebody re-imported the credential by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-refresh-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  refreshOidcAccountCredential, refreshAccountCredential, renewAccountToken,
  ensureFreshAccountToken, persistAccountCredential, callKiroWithAuth,
  isRejectedTokenResponse, isApiKeyCredential, jitteredBackoff,
  MODEL_REJECTION_BACKOFF_MS, TOKEN_REFRESH_SKEW_SECONDS,
};
`);
  return (await import(file)).__internals;
}

const W = await loadWorker();

const REJECTED_TOKEN_BODY = JSON.stringify({
  message: "The bearer token included in the request is invalid.",
  reason: null,
});

function idcAccount(overrides = {}) {
  return {
    id: "acc-1",
    email: "user@example.com",
    authMethod: "idc",
    region: "us-east-1",
    accessToken: "stale-access-token",
    refreshToken: "refresh-token-1",
    clientId: "client-id-1",
    clientSecret: "client-secret-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:111122223333:profile/ABCDEF",
    startUrl: "https://d-90667c527c.awsapps.com/start/",
    ...overrides,
  };
}

// Minimal KV double matching the shape getKV/setKV expect.
function makeEnv(accounts) {
  const store = new Map([["config:accounts", JSON.stringify(accounts)]]);
  return {
    env: {
      KIRO_KV: {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
      },
    },
    readAccounts: () => JSON.parse(store.get("config:accounts")),
  };
}

// Captures fetch calls and replies from a scripted queue.
function withStubbedFetch(handler, body) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };

  return body(calls).finally(() => {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  });
}

function oidcTokenResponse(overrides = {}) {
  return new Response(JSON.stringify({
    accessToken: "fresh-access-token",
    refreshToken: "refresh-token-1",
    expiresIn: 3600,
    tokenType: "Bearer",
    ...overrides,
  }), { status: 200 });
}

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

// -------------------------------------------------------------- OIDC refresh

test("an idc credential renews against the SSO OIDC token endpoint", async () => {
  const acc = idcAccount();

  await withStubbedFetch(() => oidcTokenResponse(), async (calls) => {
    const res = await W.refreshOidcAccountCredential(acc);
    assert.equal(res.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://oidc.us-east-1.amazonaws.com/token");

    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.grantType, "refresh_token");
    assert.equal(sent.clientId, "client-id-1");
    assert.equal(sent.clientSecret, "client-secret-1");
    assert.equal(sent.refreshToken, "refresh-token-1");

    assert.equal(acc.accessToken, "fresh-access-token");
  });
});

test("the refresh records an expiry, which is what the proactive check needs", async () => {
  const acc = idcAccount();
  const before = Math.floor(Date.now() / 1000);

  await withStubbedFetch(() => oidcTokenResponse(), async () => {
    await W.refreshOidcAccountCredential(acc);
  });

  // Accounts arrive with no expiry at all, so this is the field that lets the
  // gateway renew before a request fails rather than after.
  assert.ok(acc.expiresAt >= before + 3600);
  assert.equal(acc.tokenExpires, acc.expiresAt, "both fields are read by callers");
});

test("the region drives the endpoint", async () => {
  const acc = idcAccount({ region: "eu-central-1" });

  await withStubbedFetch(() => oidcTokenResponse(), async (calls) => {
    await W.refreshOidcAccountCredential(acc);
    assert.equal(calls[0].url, "https://oidc.eu-central-1.amazonaws.com/token");
  });
});

test("a response that omits refreshToken and profileArn clobbers neither", async () => {
  const acc = idcAccount();
  const originalRefresh = acc.refreshToken;
  const originalArn = acc.profileArn;

  // The live endpoint returns no profileArn and echoes the same refresh token.
  await withStubbedFetch(
    () => oidcTokenResponse({ refreshToken: undefined, profileArn: undefined }),
    async () => {
      const res = await W.refreshOidcAccountCredential(acc);
      assert.equal(res.ok, true);
      assert.equal(acc.refreshToken, originalRefresh);
      assert.equal(acc.profileArn, originalArn);
    },
  );
});

test("a rotated refresh token replaces the stored one", async () => {
  const acc = idcAccount();

  await withStubbedFetch(() => oidcTokenResponse({ refreshToken: "refresh-token-2" }), async () => {
    await W.refreshOidcAccountCredential(acc);
    assert.equal(acc.refreshToken, "refresh-token-2");
  });
});

test("missing clientId or clientSecret fails with an actionable message", async () => {
  for (const missing of [{ clientId: "" }, { clientSecret: "" }]) {
    const res = await W.refreshOidcAccountCredential(idcAccount(missing));
    assert.equal(res.ok, false);
    assert.match(res.error, /clientId and clientSecret/);
  }
});

test("a missing refreshToken fails without calling out", async () => {
  await withStubbedFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    const res = await W.refreshOidcAccountCredential(idcAccount({ refreshToken: "" }));
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });
});

test("an upstream rejection surfaces the status and body", async () => {
  const acc = idcAccount();

  await withStubbedFetch(() => new Response("invalid_grant", { status: 400 }), async () => {
    const res = await W.refreshOidcAccountCredential(acc);
    assert.equal(res.ok, false);
    assert.match(res.error, /HTTP 400/);
    assert.match(res.error, /invalid_grant/);
    assert.equal(acc.accessToken, "stale-access-token", "a failed refresh must not clear the token");
  });
});

// ------------------------------------------------------------------- routing

test("idc routes to OIDC and social routes to the Kiro desktop endpoint", async () => {
  await withStubbedFetch(() => oidcTokenResponse(), async (calls) => {
    await W.refreshAccountCredential(idcAccount());
    await W.refreshAccountCredential(idcAccount({ authMethod: "social" }));

    assert.equal(calls[0].url, "https://oidc.us-east-1.amazonaws.com/token");
    assert.equal(calls[1].url, "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
  });
});

test("builderid credentials use the OIDC endpoint too", async () => {
  await withStubbedFetch(() => oidcTokenResponse(), async (calls) => {
    const res = await W.refreshAccountCredential(idcAccount({ authMethod: "builderid" }));
    assert.equal(res.ok, true);
    assert.equal(calls[0].url, "https://oidc.us-east-1.amazonaws.com/token");
  });
});

test("an API Key credential is not refreshable and is never sent anywhere", async () => {
  await withStubbedFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    for (const acc of [
      { authMethod: "api_key", accessToken: "ksk_abc" },
      { authMethod: "", accessToken: "ksk_abc" },
      { authMethod: "", kiroApiKey: "ksk_abc" },
    ]) {
      assert.equal(W.isApiKeyCredential(acc), true);
      const res = await W.refreshAccountCredential(acc);
      assert.equal(res.ok, false);
    }
    assert.equal(calls.length, 0);
  });
});

// --------------------------------------------------- rejected-token detection

test("the real 403 body is recognized as a dead credential", () => {
  assert.equal(W.isRejectedTokenResponse(403, REJECTED_TOKEN_BODY), true);
  assert.equal(W.isRejectedTokenResponse(401, REJECTED_TOKEN_BODY), true);
});

test("an unrelated 403 is not treated as a credential problem", () => {
  assert.equal(W.isRejectedTokenResponse(403, `{"message":"not provisioned in this region"}`), false);
});

test("only 401 and 403 qualify", () => {
  assert.equal(W.isRejectedTokenResponse(400, REJECTED_TOKEN_BODY), false);
  assert.equal(W.isRejectedTokenResponse(500, REJECTED_TOKEN_BODY), false);
});

// ------------------------------------------------------------ persist + reuse

test("a renewed token is written back to KV", async () => {
  const acc = idcAccount();
  const { env, readAccounts } = makeEnv([idcAccount()]);

  await withStubbedFetch(() => oidcTokenResponse(), async () => {
    const res = await W.renewAccountToken(env, acc);
    assert.equal(res.ok, true);
  });

  const stored = readAccounts()[0];
  assert.equal(stored.accessToken, "fresh-access-token");
  assert.ok(stored.expiresAt > 0, "the expiry has to persist or the proactive check never engages");
});

test("a token another request already renewed is adopted instead of minting a second", async () => {
  const acc = idcAccount();
  // KV already holds a newer token, as it would when concurrent requests all hit
  // the same expiry and one of them got there first.
  const { env } = makeEnv([idcAccount({ accessToken: "already-renewed", expiresAt: 999 })]);

  await withStubbedFetch(() => { throw new Error("must not refresh again"); }, async (calls) => {
    const res = await W.renewAccountToken(env, acc);
    assert.equal(res.ok, true);
    assert.equal(res.reused, true);
    assert.equal(acc.accessToken, "already-renewed");
    assert.equal(calls.length, 0);
  });
});

// -------------------------------------------------------------- proactive gate

test("a token far from expiry is left alone", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const acc = idcAccount({ expiresAt: future });
  const { env } = makeEnv([idcAccount({ expiresAt: future })]);

  await withStubbedFetch(() => { throw new Error("must not refresh"); }, async (calls) => {
    await W.ensureFreshAccountToken(env, acc);
    assert.equal(calls.length, 0);
    assert.equal(acc.accessToken, "stale-access-token");
  });
});

test("a token inside the expiry skew is renewed before the request goes out", async () => {
  const nearly = Math.floor(Date.now() / 1000) + W.TOKEN_REFRESH_SKEW_SECONDS - 30;
  const acc = idcAccount({ expiresAt: nearly });
  const { env } = makeEnv([idcAccount({ expiresAt: nearly })]);

  await withStubbedFetch(() => oidcTokenResponse(), async (calls) => {
    await W.ensureFreshAccountToken(env, acc);
    assert.equal(calls.length, 1);
    assert.equal(acc.accessToken, "fresh-access-token");
  });
});

test("an unknown expiry is left to the reactive path", async () => {
  // This is how accounts are stored today: no expiry recorded at all. Renewing
  // every request instead would hammer the OIDC endpoint.
  const acc = idcAccount({ expiresAt: 0 });
  const { env } = makeEnv([idcAccount({ expiresAt: 0 })]);

  await withStubbedFetch(() => { throw new Error("must not refresh"); }, async (calls) => {
    const res = await W.ensureFreshAccountToken(env, acc);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0);
  });
});

test("an API Key credential skips the gate entirely", async () => {
  const acc = { id: "k", authMethod: "api_key", accessToken: "ksk_abc", expiresAt: 1 };
  const { env } = makeEnv([acc]);

  await withStubbedFetch(() => { throw new Error("must not refresh"); }, async (calls) => {
    const res = await W.ensureFreshAccountToken(env, acc);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0);
  });
});

// -------------------------------------------------- end to end through dispatch

test("a rejected token is renewed and the request retried once", async () => {
  const acc = idcAccount({ expiresAt: 0 });
  const { env } = makeEnv([idcAccount({ expiresAt: 0 })]);

  await withStubbedFetch((url, init, n) => {
    if (url.includes("oidc.")) return oidcTokenResponse();
    // First upstream attempt carries the dead token, the retry carries the new one.
    return n === 1
      ? new Response(REJECTED_TOKEN_BODY, { status: 403 })
      : new Response(successfulEventStream("ok"), { status: 200 });
  }, async (calls) => {
    const resp = await W.callKiroWithAuth(env, acc, {});
    assert.equal(resp.status, 200);

    const urls = calls.map((c) => c.url);
    assert.equal(urls.filter((u) => u.includes("oidc.")).length, 1, "renewed exactly once");
    assert.equal(calls[calls.length - 1].init.headers.Authorization, "Bearer fresh-access-token");
  });
});

test("a 403 that is not about the token is returned as-is, body intact", async () => {
  const acc = idcAccount({ expiresAt: 0 });
  const { env } = makeEnv([idcAccount({ expiresAt: 0 })]);
  const body = `{"message":"not provisioned in this region"}`;

  await withStubbedFetch((url) => {
    if (url.includes("oidc.")) throw new Error("must not refresh");
    return new Response(body, { status: 403 });
  }, async () => {
    const resp = await W.callKiroWithAuth(env, acc, {});
    assert.equal(resp.status, 403);
    assert.equal(await resp.text(), body);
  });
});

test("a failed renewal reports the original rejection rather than masking it", async () => {
  const acc = idcAccount({ expiresAt: 0 });
  const { env } = makeEnv([idcAccount({ expiresAt: 0 })]);

  await withStubbedFetch((url) => {
    if (url.includes("oidc.")) return new Response("invalid_grant", { status: 400 });
    return new Response(REJECTED_TOKEN_BODY, { status: 403 });
  }, async () => {
    const resp = await W.callKiroWithAuth(env, acc, {});
    assert.equal(resp.status, 403);
    assert.match(await resp.text(), /bearer token/);
  });
});

test("a successful request never touches the refresh endpoint", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const acc = idcAccount({ expiresAt: future });
  const { env } = makeEnv([idcAccount({ expiresAt: future })]);

  await withStubbedFetch((url) => {
    if (url.includes("oidc.")) throw new Error("must not refresh");
    return new Response(successfulEventStream("ok"), { status: 200 });
  }, async (calls) => {
    const resp = await W.callKiroWithAuth(env, acc, {});
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 1);
  });
});

// -------------------------------------------------------------------- jitter

test("jitter keeps each step inside half to one and a half of its base", () => {
  for (const base of W.MODEL_REJECTION_BACKOFF_MS) {
    for (let i = 0; i < 200; i++) {
      const d = W.jitteredBackoff(base);
      assert.ok(d >= Math.floor(base / 2), `${d} below half of ${base}`);
      assert.ok(d <= base * 1.5, `${d} above 1.5x of ${base}`);
    }
  }
});

test("jitter actually varies, otherwise siblings collide again", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(W.jitteredBackoff(1000));
  assert.ok(seen.size > 10, `expected spread, got ${seen.size} distinct delays`);
});
