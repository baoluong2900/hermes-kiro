// Regression suite for broken tool calling in the Cloudflare Worker gateway.
//
// Run:  node --test cloudflare/tool_calling.test.mjs
//
// The Go implementation in proxy/translator.go + proxy/kiro.go is the WORKING
// reference. These tests encode that reference behaviour and are expected to
// FAIL against the current worker until the tool-calling bugs are fixed. They
// must PASS once the worker matches the Go reference.
//
// Bugs under test (numbers match the task brief):
//   1. Schema not cleaned: Go cleanSchema() RECURSIVELY deletes
//      additionalProperties and deletes required when null/empty; ensureObjectSchema()
//      forces type:object and deep-clones. Worker only deletes top-level $schema.
//   2. Empty tool description: Go normalizeToolDesc() returns "Tool: <name>";
//      worker sends "".
//   3. Description length: Go truncates at 10237 + "..."; worker does not.
//   4. Tool name handling: Go shortenToolName() collapses mcp__server__tool to
//      mcp__tool (else hard 64-cut); Claude path camelCases via sanitizeToolName()
//      and keeps a reverse map to RESTORE the original name on responses; blank
//      names are skipped. Worker mangles names with a lossy regex, has no reverse
//      map, and re-mangles names coming back from upstream.
//   5. Streamed toolUseEvent fragments: Kiro streams one tool call across several
//      frames (first has id+name, continuations carry only partial-JSON `input`,
//      last carries stop:true). The worker builders drop/duplicate fragments.
//   6. Stop-reason override: a trailing metadataEvent{stopReason:END_TURN} must
//      NOT clobber the tool_calls/tool_use stop reason once a tool was emitted.
//
// ---------------------------------------------------------------------------
// IMPLEMENTER NOTE — required internal exports
// ---------------------------------------------------------------------------
// This harness appends an `export const __internals = { ... }` naming worker
// internals. The following must exist / be reachable as named function
// declarations in worker.gateway.js for these tests to load:
//
//   convertTools, convertClaudeTools          (already exist)
//   sanitizeToolName                          (already exists)
//   streamOpenAIResponse, streamClaudeResponse,
//   nonStreamOpenAIResponse, nonStreamClaudeResponse   (already exist)
//   EmptyUpstreamResponse                     (already exists)
//
// For the tool-name ROUND TRIP (bug 4) the worker must expose the reverse
// mapping it builds during convert*Tools so a tool_use returned by upstream can
// be reported under the client's ORIGINAL name. The Go reference stores this on
// the payload as ToolNameMap and applies it in the OnToolUse wrapper
// (proxy/kiro.go:555-566). Since the worker has no such map today, the
// round-trip test below drives the real response builders and passes the
// declared tools as a 4th argument so the builder can restore original names.
// The implementer must:
//   - build a sanitized->original map in convert*Tools, and
//   - thread it into the response builders (e.g. an extra arg / shared context)
//     so onToolUse restores the original name.
// If the builder signature must change, update the round-trip test call to
// match. The assertion (original name preserved) must not change.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-tools-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = {
  convertTools, convertClaudeTools, sanitizeToolName,
  streamOpenAIResponse, streamClaudeResponse,
  nonStreamOpenAIResponse, nonStreamClaudeResponse,
  EmptyUpstreamResponse,
  buildOpenAIKiroPayload, shortenToolName,
};
`);
  return (await import(file)).__internals;
}

const W = await loadWorker();

// ------------------------------------------------------------- frame encoding
// Builds one AWS event-stream frame. Prelude is total length, headers length,
// prelude CRC; then headers, payload, message CRC. The CRCs are never verified
// by the parser under test, so they are left zero. (Same builder shape as
// upstream_error.test.mjs.)
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

const toolFrame = (payload) => frame({ ":event-type": "toolUseEvent", ":message-type": "event" }, payload);
const metaFrame = (payload) => frame({ ":event-type": "metadataEvent", ":message-type": "event" }, payload);

async function readAll(resp) {
  try { return await resp.text(); } catch { return ""; }
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), drain: () => Promise.allSettled(pending) };
}

// The realistic multi-frame tool sequence from the brief: one tool call split
// across three input fragments, then a stop frame, then a metadata frame that
// claims END_TURN (bug 6 bait).
function toolSequenceBody() {
  return bodyOf(
    toolFrame({ toolUseId: "toolu_1", name: "get_weather", input: '{"ci' }),
    toolFrame({ input: 'ty":"Ha' }),
    toolFrame({ input: 'noi"}' }),
    toolFrame({ stop: true }),
    metaFrame({ stopReason: "END_TURN" }),
  );
}

// =========================================================================
// convertTools / convertClaudeTools  (bugs 1, 2, 3, 4-skip)
// =========================================================================

test("convertTools recursively strips additionalProperties (bug 1)", () => {
  const tools = [{
    type: "function",
    function: {
      name: "search",
      description: "d",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: { type: "string", additionalProperties: false },
          items: { type: "array", items: { type: "object", additionalProperties: false } },
        },
      },
    },
  }];
  const out = W.convertTools(tools);
  const schema = out[0].toolSpecification.inputSchema.json;
  assert.ok(!("additionalProperties" in schema), "top-level additionalProperties must be removed");
  assert.ok(!("additionalProperties" in schema.properties.q), "nested property additionalProperties must be removed");
  assert.ok(!("additionalProperties" in schema.properties.items.items),
    "additionalProperties inside array items must be removed");
});

test("convertTools drops empty/null required, keeps non-empty (bug 1)", () => {
  const out = W.convertTools([
    { function: { name: "a", description: "d", parameters: { type: "object", required: [] } } },
    { function: { name: "b", description: "d", parameters: { type: "object", required: null } } },
    { function: { name: "c", description: "d", parameters: { type: "object", required: ["x"] } } },
  ]);
  const [a, b, c] = out.map((t) => t.toolSpecification.inputSchema.json);
  assert.ok(!("required" in a), "empty-array required must be removed");
  assert.ok(!("required" in b), "null required must be removed");
  assert.deepEqual(c.required, ["x"], "non-empty required must be preserved");
});

test("convertTools defaults missing type to object (bug 1)", () => {
  const out = W.convertTools([{ function: { name: "a", description: "d", parameters: { properties: {} } } }]);
  assert.equal(out[0].toolSpecification.inputSchema.json.type, "object");
});

test("convertTools removes $schema", () => {
  const out = W.convertTools([{
    function: { name: "a", description: "d", parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } },
  }]);
  assert.ok(!("$schema" in out[0].toolSpecification.inputSchema.json));
});

test("convertTools normalizes a blank description to 'Tool: <name>' (bug 2)", () => {
  const out = W.convertTools([{ function: { name: "get_weather", description: "", parameters: { type: "object" } } }]);
  assert.equal(out[0].toolSpecification.description, "Tool: get_weather");
});

test("convertTools truncates an over-long description to 10237 + '...' (bug 3)", () => {
  const long = "x".repeat(20000);
  const out = W.convertTools([{ function: { name: "a", description: long, parameters: { type: "object" } } }]);
  const desc = out[0].toolSpecification.description;
  assert.equal(desc.length, 10237 + 3, "must be truncated to 10237 then '...' appended");
  assert.ok(desc.endsWith("..."));
  assert.equal(desc.slice(0, 10237), "x".repeat(10237));
});

test("convertTools skips a tool with a blank name (bug 4)", () => {
  const out = W.convertTools([
    { function: { name: "", description: "d", parameters: { type: "object" } } },
    { function: { name: "keep", description: "d", parameters: { type: "object" } } },
  ]);
  assert.equal(out.length, 1, "blank-named tool must be skipped, not renamed to 'unknown'");
  // whatever transform is applied, it must derive from "keep", never "unknown".
  assert.notEqual(out[0].toolSpecification.name, "unknown");
});

test("convertTools parses an input schema supplied as a JSON string", () => {
  const out = W.convertTools([{
    function: { name: "a", description: "d", parameters: JSON.stringify({ type: "object", additionalProperties: false, required: [] }) },
  }]);
  const schema = out[0].toolSpecification.inputSchema.json;
  assert.equal(schema.type, "object");
  assert.ok(!("additionalProperties" in schema), "string-parsed schema must still be cleaned");
  assert.ok(!("required" in schema));
});

test("convertTools does not mutate the caller-supplied schema object (bug 1)", () => {
  const params = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: { q: { type: "string", additionalProperties: false } },
  };
  const before = JSON.stringify(params);
  W.convertTools([{ function: { name: "a", description: "d", parameters: params } }]);
  assert.equal(JSON.stringify(params), before, "the original schema object must be left untouched (deep clone)");
});

test("convertClaudeTools recursively strips additionalProperties and cleans required (bug 1)", () => {
  const out = W.convertClaudeTools([{
    name: "search",
    description: "d",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { q: { type: "string", additionalProperties: false } },
    },
  }]);
  const schema = out[0].toolSpecification.inputSchema.json;
  assert.ok(!("additionalProperties" in schema));
  assert.ok(!("additionalProperties" in schema.properties.q));
  assert.ok(!("required" in schema));
});

test("convertClaudeTools normalizes a blank description (bug 2)", () => {
  const out = W.convertClaudeTools([{ name: "get_weather", description: "", input_schema: { type: "object" } }]);
  assert.equal(out[0].toolSpecification.description, "Tool: get_weather");
});

// =========================================================================
// shortenToolName-equivalent behaviour  (bug 4)
// =========================================================================

test("an mcp__server__tool name over 64 chars collapses to mcp__<tool> (bug 4)", () => {
  const name = "mcp__" + "s".repeat(60) + "__weather"; // > 64 chars, collapses to "mcp__weather"
  assert.ok(name.length > 64);
  const out = W.convertTools([{ function: { name, description: "d", parameters: { type: "object" } } }]);
  const sent = out[0].toolSpecification.name;
  assert.equal(sent.length <= 64, true, "sent name must fit in 64 chars");
  assert.equal(sent, "mcp__weather", "must collapse to mcp__<tool>, not hard-cut mid-server-name");
});

test("a >64-char name that cannot collapse is hard-cut to 64 (bug 4)", () => {
  const name = "z".repeat(100);
  const out = W.convertTools([{ function: { name, description: "d", parameters: { type: "object" } } }]);
  assert.equal(out[0].toolSpecification.name.length, 64);
});

// =========================================================================
// Tool-name round trip  (bug 4)
// =========================================================================

test("convertClaudeTools camelCases a snake_case tool name for Kiro (bug 4)", () => {
  // Kiro tool names must be pure camelCase (Go sanitizeToolName, translator.go:1020).
  // The current worker leaves underscores intact, so this fails today.
  const out = W.convertClaudeTools([{ name: "get_weather", description: "d", input_schema: { type: "object" } }]);
  const sent = out[0].toolSpecification.name;
  assert.equal(sent, "getWeather",
    "Claude-path tool names must be camelCased (get_weather -> getWeather), no underscores");
});

test("Claude non-stream restores the client's ORIGINAL tool name on the way back (bug 4)", async () => {
  // Client registers a snake_case tool "get_weather". The gateway sends the
  // camelCased "getWeather" to Kiro (per the Go reference) and upstream echoes
  // that back. The tool_use returned to the client MUST carry the client's
  // ORIGINAL "get_weather" so the client can match its registry — which requires
  // a sanitized->original reverse map (Go ToolNameMap, kiro.go:555-566). The
  // current worker has no such map, so the client would receive the mangled
  // camelCase name (or, since the worker doesn't even camelCase, the raw upstream
  // name) instead of the original.
  //
  // We drive the real builder and give it the declared tools (4th arg) so the
  // implementer can build/consult the reverse map. Upstream returns the
  // camelCased name the Go reference would have sent.
  const original = "get_weather";
  const upstreamName = "getWeather"; // what Kiro echoes back after the Go camelCase transform
  const body = bodyOf(
    toolFrame({ toolUseId: "toolu_1", name: upstreamName, input: '{}' }),
    toolFrame({ stop: true }),
  );
  const res = await W.nonStreamClaudeResponse(body, "claude-opus-4.7", {},
    { tools: [{ name: original, description: "d", input_schema: { type: "object" } }] });
  const json = await res.response.json();
  const toolUse = json.content.find((b) => b.type === "tool_use");
  assert.ok(toolUse, "a tool_use block must be present");
  assert.equal(toolUse.name, original,
    "the tool_use returned to the client must use the client's ORIGINAL name (get_weather), not the transformed camelCase name");
});

// =========================================================================
// Multi-frame tool-use assembly — NON-STREAM  (bugs 5, 6)
// =========================================================================

test("non-stream OpenAI assembles one tool call from fragmented frames (bugs 5,6)", async () => {
  const res = await W.nonStreamOpenAIResponse(toolSequenceBody(), "gpt-4o", {});
  const json = await res.response.json();
  const calls = json.choices[0].message.tool_calls || [];
  assert.equal(calls.length, 1, "exactly one tool call expected");
  assert.equal(calls[0].id, "toolu_1");
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Hanoi" },
    "fragmented input frames must be concatenated into valid JSON");
  assert.equal(json.choices[0].finish_reason, "tool_calls",
    "finish_reason must stay tool_calls despite the trailing END_TURN metadata");
});

test("non-stream Claude assembles one tool_use from fragmented frames (bugs 5,6)", async () => {
  const res = await W.nonStreamClaudeResponse(toolSequenceBody(), "claude-opus-4.7", {});
  const json = await res.response.json();
  const toolUses = json.content.filter((b) => b.type === "tool_use");
  assert.equal(toolUses.length, 1, "exactly one tool_use expected");
  assert.equal(toolUses[0].id, "toolu_1");
  assert.equal(toolUses[0].name, "get_weather");
  assert.deepEqual(toolUses[0].input, { city: "Hanoi" },
    "fragmented input frames must be concatenated and parsed (worker's `if(!id)return` drops them -> {})");
  assert.equal(json.stop_reason, "tool_use",
    "stop_reason must stay tool_use despite the trailing END_TURN metadata");
});

// =========================================================================
// Multi-frame tool-use assembly — STREAM  (bugs 5, 6)
// =========================================================================

// Parse OpenAI SSE chunks out of the streamed body.
function parseOpenAIChunks(sse) {
  const chunks = [];
  for (const line of sse.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (data === "[DONE]") continue;
    try { chunks.push(JSON.parse(data)); } catch {}
  }
  return chunks;
}

test("stream OpenAI assembles one tool call and emits no phantom empty call (bugs 5,6)", async () => {
  const ctx = fakeCtx();
  const resp = W.streamOpenAIResponse(toolSequenceBody(), "gpt-4o", {}, async () => {}, ctx);
  const sse = await readAll(resp);
  await ctx.drain();

  const chunks = parseOpenAIChunks(sse);

  // Collect every tool_call delta emitted across chunks.
  const toolDeltas = [];
  let finish = null;
  for (const c of chunks) {
    const choice = c.choices && c.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const tcs = choice.delta && choice.delta.tool_calls;
    if (Array.isArray(tcs)) toolDeltas.push(...tcs);
  }

  // No phantom call: the current worker emits a second tool_call with id ""
  // and name "unknown" when the continuation frame has no id.
  for (const tc of toolDeltas) {
    if (tc.id !== undefined) {
      assert.notEqual(tc.id, "", "no tool_call with an empty id may be emitted");
    }
    if (tc.function && tc.function.name !== undefined) {
      assert.notEqual(tc.function.name, "unknown", "no tool_call named 'unknown' may be emitted");
    }
  }

  // Distinct indexes tell us how many logical calls were emitted.
  const indexes = new Set(toolDeltas.map((tc) => tc.index));
  assert.equal(indexes.size, 1, "exactly one logical tool call (one index) expected");

  // Reassemble the streamed arguments and the name.
  let name = "";
  let id = "";
  let args = "";
  for (const tc of toolDeltas) {
    if (tc.id) id = tc.id;
    if (tc.function && tc.function.name) name = tc.function.name;
    if (tc.function && typeof tc.function.arguments === "string") args += tc.function.arguments;
  }
  assert.equal(id, "toolu_1");
  assert.equal(name, "get_weather");
  assert.deepEqual(JSON.parse(args), { city: "Hanoi" });

  assert.equal(finish, "tool_calls",
    "streamed finish_reason must remain tool_calls despite the END_TURN metadata (bug 6)");
});

test("stream Claude assembles one tool_use with full input despite fragmentation (bugs 5,6)", async () => {
  const ctx = fakeCtx();
  const resp = W.streamClaudeResponse(toolSequenceBody(), "claude-opus-4.7", {}, async () => {}, ctx);
  const sse = await readAll(resp);
  await ctx.drain();

  // Count tool_use content_block_start events and reassemble input_json_delta.
  let toolStarts = 0;
  let toolId = "";
  let toolName = "";
  let partial = "";
  let stopReason = null;
  for (const block of sse.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.trim().startsWith("data:"));
    if (!dataLine) continue;
    let ev;
    try { ev = JSON.parse(dataLine.trim().slice(5).trim()); } catch { continue; }
    if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
      toolStarts += 1;
      toolId = ev.content_block.id;
      toolName = ev.content_block.name;
    }
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "input_json_delta") {
      partial += ev.delta.partial_json || "";
    }
    if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
      stopReason = ev.delta.stop_reason;
    }
  }

  assert.equal(toolStarts, 1, "exactly one tool_use block must be opened");
  assert.equal(toolId, "toolu_1");
  assert.equal(toolName, "get_weather");
  assert.deepEqual(JSON.parse(partial), { city: "Hanoi" },
    "the streamed input_json_delta fragments must reassemble to full JSON (worker drops continuations -> truncated)");
  assert.equal(stopReason, "tool_use",
    "stop_reason must remain tool_use despite the trailing END_TURN metadata (bug 6)");
});

// ------------------------------------------- request path: replayed tool names
//
// The OpenAI tool SPEC goes out through convertTools, which only shortens names
// and never camelCases them (matching Go convertOpenAITools, translator.go:2130).
// buildOpenAIKiroPayload replays the previous assistant turn's tool_calls into
// Kiro history, and used to run those names through sanitizeToolName — turning
// get_weather into getWeather while the spec still said get_weather. Kiro then saw
// a tool_use naming a tool it had never been given, which breaks the second turn
// of every tool conversation.

test("a replayed assistant tool_call keeps the name the spec used (bug 4)", () => {
  const payload = W.buildOpenAIKiroPayload({
    model: "claude-sonnet-5",
    tools: [{
      type: "function",
      function: { name: "get_weather", description: "d", parameters: { type: "object" } },
    }],
    messages: [
      { role: "user", content: "weather in Hanoi?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "31C" },
    ],
  }, "claude-sonnet-5", false);

  const history = payload.conversationState.history;
  const assistantTurn = history.find((h) => h.assistantResponseMessage);
  assert.ok(assistantTurn, "expected the assistant turn to be replayed into history");

  const replayed = assistantTurn.assistantResponseMessage.toolUses[0];
  assert.equal(replayed.name, "get_weather");
  assert.deepEqual(replayed.input, { city: "Hanoi" });

  // And it must agree with the spec name sent in the same request.
  const specName = W.convertTools([{
    type: "function",
    function: { name: "get_weather", description: "d", parameters: { type: "object" } },
  }])[0].toolSpecification.name;
  assert.equal(replayed.name, specName);
});

test("a replayed tool_call name is shortened the same way the spec is (bug 4)", () => {
  const longName = "mcp__some_really_long_server_name__doTheThingWithAVeryLongSuffix";
  const padded = longName + "_padded_out_beyond_sixty_four_characters";
  const specName = W.shortenToolName(padded);

  const payload = W.buildOpenAIKiroPayload({
    model: "claude-sonnet-5",
    messages: [{
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_2", type: "function", function: { name: padded, arguments: "{}" } }],
    }],
  }, "claude-sonnet-5", false);

  const assistantTurn = payload.conversationState.history.find((h) => h.assistantResponseMessage);
  assert.equal(assistantTurn.assistantResponseMessage.toolUses[0].name, specName);
  assert.ok(specName.length <= 64);
});
