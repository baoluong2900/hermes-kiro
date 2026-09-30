// Regression suite for upstream failures that arrived inside a 200 response.
//
// Run:  node --test cloudflare/upstream_error.test.mjs
//
// Symptom these all share: an AWS event stream carried a failure, the gateway
// could not see it, and the client received a well formed empty answer. Clients
// treat an empty assistant turn as a transient glitch and retry immediately, so
// one upstream rejection became a multi-hundred-request loop. Upstream never
// metered those attempts, so no quota or rate limit ever stopped them, and the
// dashboard showed all of them as "200 OK" with a fabricated 30 output tokens.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-upstream-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  parseAwsEventStream, parseFrameHeaders, extractEventType, dispatchEvent,
  KiroUpstreamException, EmptyUpstreamResponse,
  upstreamErrorStatus, upstreamErrorMessage, anthropicErrorType, openaiErrorType,
  streamClaudeResponse, streamOpenAIResponse,
  nonStreamClaudeResponse, nonStreamOpenAIResponse,
};
`);
  return (await import(file)).__internals;
}

const W = await loadWorker();

// ------------------------------------------------------------- frame encoding

// Builds one AWS event-stream frame. Prelude is total length, headers length,
// prelude CRC; then headers, payload, message CRC. The CRCs are never verified
// by the parser under test, so they are left zero.
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
    h[o++] = 7;                        // string value type
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
  view.setUint32(8, 0, false);         // prelude CRC (unchecked)
  let off = 12;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  buf.set(payload, off); off += payload.length;
  view.setUint32(off, 0, false);       // message CRC (unchecked)
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

async function readAll(resp) {
  try { return await resp.text(); } catch { return ""; }
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), drain: () => Promise.allSettled(pending) };
}

// ------------------------------------------------------------- header parsing

test("prelude headers other than :event-type are decoded", async () => {
  // Symptom: extractEventType returned on the first :event-type match, so
  // :message-type / :exception-type were never even read.
  const f = frame({
    ":message-type": "exception",
    ":exception-type": "ThrottlingException",
    ":content-type": "application/json",
  }, { message: "slow down" });

  const view = new DataView(f.buffer);
  const headerLen = view.getUint32(4, false);
  const headers = W.parseFrameHeaders(f.subarray(12, 12 + headerLen));

  assert.equal(headers[":message-type"], "exception");
  assert.equal(headers[":exception-type"], "ThrottlingException");
  assert.equal(headers[":content-type"], "application/json");
  assert.equal(W.extractEventType(f.subarray(12, 12 + headerLen)), "",
    "an exception frame has no :event-type");
});

// ---------------------------------------------------------- exception surfacing

test("an exception frame is raised instead of dropped", async () => {
  // Symptom: the frame had no :event-type, dispatchEvent hit `default: break`,
  // and the failure vanished. The stream then ended cleanly with no content.
  const body = bodyOf(
    textFrame("partial"),
    frame({ ":message-type": "exception", ":exception-type": "ValidationException" },
      { message: "Input is too long for requested model" }),
  );

  let seen = "";
  await assert.rejects(
    () => W.parseAwsEventStream(body.body, { onAssistantChunk(t) { seen += t; } }),
    (err) => {
      assert.ok(err instanceof W.KiroUpstreamException, "must be a typed upstream exception");
      assert.equal(err.exceptionType, "ValidationException");
      assert.match(err.upstreamMessage, /too long/);
      return true;
    },
  );
  assert.equal(seen, "partial", "content before the exception is still delivered");
});

test("exception frames are classified into real HTTP statuses", async () => {
  const cases = [
    ["ThrottlingException", 429, "rate_limit_error", true],
    ["ValidationException", 400, "invalid_request_error", false],
    ["AccessDeniedException", 401, "authentication_error", false],
    ["ExpiredTokenException", 401, "authentication_error", false],
    ["InternalServerException", 503, "overloaded_error", true],
    ["SomethingElseException", 502, "api_error", true],
  ];
  for (const [name, status, anthropicType, retryable] of cases) {
    const err = new W.KiroUpstreamException(name, "boom");
    assert.equal(err.status, status, name + " status");
    assert.equal(W.anthropicErrorType(err.status), anthropicType, name + " type");
    assert.equal(err.retryable, retryable, name + " retryable");
  }
});

test("an :event-type ending in Exception is also treated as a failure", async () => {
  // Belt and braces: some frames arrive with the error as the union member name.
  await assert.rejects(
    () => W.parseAwsEventStream(
      bodyOf(frame({ ":event-type": "throttlingException", ":message-type": "event" }, { message: "nope" })).body,
      {},
    ),
    (err) => err instanceof W.KiroUpstreamException && err.status === 429,
  );
});

test("a normal event stream still parses", async () => {
  // Guard against the exception check swallowing healthy traffic.
  let text = "";
  let credits = 0;
  await W.parseAwsEventStream(bodyOf(textFrame("hello "), textFrame("world"), meterFrame(0.5)).body, {
    onAssistantChunk(t) { text += t; },
    onMetering(c) { credits += c; },
  });
  assert.equal(text, "hello world");
  assert.equal(credits, 0.5);
});

// ------------------------------------------------------------ empty responses

test("an empty Claude stream reports an error instead of an empty turn", async () => {
  // Symptom: message_start / message_delta / message_stop with zero content
  // blocks. The client saw a valid but empty answer and retried at ~2 req/s.
  const ctx = fakeCtx();
  let observed = null;
  const resp = W.streamClaudeResponse(
    bodyOf(), "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => { observed = { credits, tokens, isSuccess }; },
    ctx,
  );
  const sse = await readAll(resp);
  await ctx.drain();

  assert.equal(observed.isSuccess, false, "the pump must report failure");
  assert.equal(observed.tokens, 0, "no tokens may be invented");
  assert.match(sse, /event: error/, "client must receive an SSE error event");
  assert.doesNotMatch(sse, /message_stop/, "must not look like a completed turn");
});

test("an exception mid Claude stream becomes an SSE error event", async () => {
  const ctx = fakeCtx();
  let observed = null;
  const resp = W.streamClaudeResponse(
    bodyOf(textFrame("thinking"), frame({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, { message: "slow down" })),
    "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => { observed = { credits, tokens, isSuccess }; },
    ctx,
  );
  const sse = await readAll(resp);
  await ctx.drain();

  assert.equal(observed.isSuccess, false);
  assert.match(sse, /event: error/);
  assert.match(sse, /rate_limit_error/);
  assert.match(sse, /ThrottlingException/);
});

test("an empty OpenAI stream reports an error instead of a clean stop", async () => {
  const ctx = fakeCtx();
  let observed = null;
  const resp = W.streamOpenAIResponse(
    bodyOf(), "gpt-4o", {},
    async (credits, tokens, isSuccess) => { observed = { credits, tokens, isSuccess }; },
    ctx,
  );
  const sse = await readAll(resp);
  await ctx.drain();

  assert.equal(observed.isSuccess, false);
  assert.equal(observed.tokens, 0);
  assert.match(sse, /"error"/, "an error payload must reach the client");
});

test("a Claude stream that produced real output still succeeds", async () => {
  const ctx = fakeCtx();
  let observed = null;
  const resp = W.streamClaudeResponse(
    bodyOf(textFrame("hi there"), meterFrame(0.25)), "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => { observed = { credits, tokens, isSuccess }; },
    ctx,
  );
  const sse = await readAll(resp);
  await ctx.drain();

  assert.equal(observed.isSuccess, true);
  assert.equal(observed.credits, 0.25);
  assert.ok(observed.tokens > 0);
  assert.match(sse, /message_stop/);
  assert.doesNotMatch(sse, /event: error/);
});

test("a metered response with no text is not treated as empty", async () => {
  // Upstream charged for it, so it did work. Only a response with no content,
  // no tokens and no metering counts as nothing.
  const ctx = fakeCtx();
  let observed = null;
  const resp = W.streamClaudeResponse(
    bodyOf(meterFrame(0.1)), "claude-opus-4.7", {},
    async (credits, tokens, isSuccess) => { observed = { credits, tokens, isSuccess }; },
    ctx,
  );
  await readAll(resp);
  await ctx.drain();

  assert.equal(observed.isSuccess, true);
  assert.equal(observed.credits, 0.1);
});

// -------------------------------------------------------- non-stream responses

test("an empty non-stream Claude response throws", async () => {
  // Symptom: it returned a 200 with content: [] and a hardcoded 30 output
  // tokens, recorded as success.
  await assert.rejects(
    () => W.nonStreamClaudeResponse(bodyOf(), "claude-opus-4.7", {}),
    (err) => err instanceof W.EmptyUpstreamResponse,
  );
});

test("an empty non-stream OpenAI response throws", async () => {
  await assert.rejects(
    () => W.nonStreamOpenAIResponse(bodyOf(), "gpt-4o", {}),
    (err) => err instanceof W.EmptyUpstreamResponse,
  );
});

test("a non-stream response with content is returned normally", async () => {
  const res = await W.nonStreamClaudeResponse(bodyOf(textFrame("answer"), meterFrame(0.2)), "claude-opus-4.7", {});
  assert.equal(res.credits, 0.2);
  const json = await res.response.json();
  assert.equal(json.content[0].text, "answer");
});

// --------------------------------------------------------------- no fabrication

test("the hardcoded 30-token fallback is gone", async () => {
  // Symptom: every empty response logged exactly 30 output tokens, which is why
  // hundreds of consecutive rows showed an identical 30 with no credits.
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  assert.doesNotMatch(src, /tokens > 0 \? tokens : 30/, "streaming fallback removed");
  assert.doesNotMatch(src, /nonStreamRes\.tokens \|\| 30/, "non-stream fallback removed");
  assert.doesNotMatch(src, /^\s*metered: true,\s*$/m, "metered must be derived from credits");
});
