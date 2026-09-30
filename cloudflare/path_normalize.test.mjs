//
// Run:  node --test cloudflare/path_normalize.test.mjs
//
// Symptom: the base URL published for this gateway ends in /v1, because that is
// what OpenAI-style clients need. Anthropic clients — Claude Code among them —
// append /v1/messages to whatever base URL they are given, so the published URL
// turned into /v1/v1/messages and the gateway answered 404 "Not Found". Nothing in
// that response points at the prefix, and Claude Code surfaces it as a generic
// connection failure, so the misconfiguration is close to undiagnosable from the
// client side.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const src = await readFile(path.join(HERE, "worker.gateway.js"), "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-path-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, src + `
export const __internals = { normalizePath };
`);
  return (await import(file)).__internals;
}

const W = await loadWorker();

test("a doubled /v1 prefix resolves to the real endpoint", () => {
  assert.equal(W.normalizePath("/v1/v1/messages"), "/v1/messages");
  assert.equal(W.normalizePath("/v1/v1/messages/count_tokens"), "/v1/messages/count_tokens");
  assert.equal(W.normalizePath("/v1/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(W.normalizePath("/v1/v1/models"), "/v1/models");
});

test("a base URL pasted with a trailing slash lands on the same place", () => {
  // ANTHROPIC_BASE_URL=".../v1/" produces "//v1/messages" before collapsing.
  assert.equal(W.normalizePath("/v1//v1/messages"), "/v1/messages");
  assert.equal(W.normalizePath("/v1/v1/messages/"), "/v1/messages");
});

test("a triple prefix collapses too rather than half-resolving", () => {
  assert.equal(W.normalizePath("/v1/v1/v1/messages"), "/v1/messages");
});

test("a correctly configured path is untouched", () => {
  for (const p of [
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/chat/completions",
    "/v1/models",
    "/messages",
    "/admin",
    "/health",
    "/",
  ]) {
    assert.equal(W.normalizePath(p), p);
  }
});

test("a legitimate path containing v1 deeper down is left alone", () => {
  assert.equal(W.normalizePath("/v1/models/v1/detail"), "/v1/models/v1/detail");
  assert.equal(W.normalizePath("/admin/v1/v1"), "/admin/v1/v1");
});

test("the existing duplicate-slash and trailing-slash handling still applies", () => {
  assert.equal(W.normalizePath("//health//"), "/health");
  assert.equal(W.normalizePath("/v1///models"), "/v1/models");
  assert.equal(W.normalizePath(""), "/");
  assert.equal(W.normalizePath("/"), "/");
});
