#!/usr/bin/env python3
"""Mutation test for the worker regression suites.

Reverts each fix in worker.gateway.js one at a time and asserts the suites turn
red. A fix whose removal keeps them green is not actually covered, so it reports
that as a blind spot.

Usage:  python3 cloudflare/mutation_test.py
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE / "worker.gateway.js"
SUITES = [
    HERE / "quota.test.mjs",
    HERE / "upstream_error.test.mjs",
    HERE / "upstream_credits.test.mjs",
    HERE / "model_resilience.test.mjs",
    HERE / "model_throttle.test.mjs",
    HERE / "content_length.test.mjs",
]

# label -> list of (needle, replacement, expected_count)
MUTATIONS = [
    (
        "reserve re-seeds used from stale KV",
        [
            ("const used = seeded ? storedUsed : Math.max(storedUsed, sourceUsed);",
             "const used = sourceUsed > 0 ? sourceUsed : storedUsed;", 1),
            ("const rawUsed = Math.max(storedUsed, stats.credits, Math.max(0, Number(body.usedFloor) || 0));",
             "const rawUsed = storedUsed;", 1),
            ("k.credits = parseFloat(Math.max(settledCredits, meteredTotal).toFixed(6));",
             "k.credits = settledCredits;", 1),
            ("const creditsUsed = Math.max(kvCreditsUsed, liveCreditsUsed, meteredCreditsUsed);",
             "const creditsUsed = Math.max(kvCreditsUsed, liveCreditsUsed);", 1),
        ],
    ),
    (
        "stream pump not registered on waitUntil",
        [("  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);", "  // pump abandoned", 2)],
    ),
    (
        "aborted stream releases instead of billing",
        [("  return Boolean(isSuccess) || (Number(meteredCredits) || 0) > 0;",
          "  return Boolean(isSuccess);", 1)],
    ),
    (
        "dropHold steals a live hold on a miss",
        [("    if (idx < 0) return holds;",
          "    if (idx < 0) return holds.filter((_, i) => i !== 0);", 1)],
    ),
    (
        "holds never expire (TTL removed)",
        [("return holds.filter((h) => h && Number(h.amount) > 0 && now - (Number(h.atMs) || 0) < HOLD_TTL_MS);",
          "return holds.filter((h) => h && Number(h.amount) > 0);", 1)],
    ),
    (
        "modelUsage reconciliation removed",
        [("k.credits = parseFloat(Math.max(settledCredits, meteredTotal).toFixed(6));",
          "k.credits = settledCredits;", 1),
         ("const creditsUsed = Math.max(kvCreditsUsed, liveCreditsUsed, meteredCreditsUsed);",
          "const creditsUsed = Math.max(kvCreditsUsed, liveCreditsUsed);", 1)],
    ),
    (
        "retired models advertised again",
        [('  "claude-opus-4.7-thinking",',
          '  "claude-opus-4.7-thinking",\n  "claude-sonnet-4.6",\n  "glm-5",', 1)],
    ),
    (
        "thinking variants dropped from /v1/models",
        [("  for (const id of [...FALLBACK_MODELS, ...synced]) {",
          "  for (const id of [...synced]) {", 1)],
    ),
    # --- upstream failures hidden inside a 200 event stream ---
    (
        "exception frames swallowed again",
        [('        const isExceptionFrame = messageType === "exception" || messageType === "error" ||\n'
          '          Boolean(exceptionType) || /Exception$/.test(eventType);',
          "        const isExceptionFrame = false;", 1)],
    ),
    (
        "header parser only reads :event-type",
        [("        out[name] = new TextDecoder().decode(headersBytes.subarray(offset, offset + valLen));",
          '        if (name === ":event-type") out[name] = new TextDecoder().decode(headersBytes.subarray(offset, offset + valLen));', 1)],
    ),
    (
        "empty Claude stream guard removed",
        [("      if (nextIndex === 0 && tokenCount === 0 && outputTokens === 0 && meteredCredits === 0) {\n"
          "        throw new EmptyUpstreamResponse();\n      }",
          "      // guard removed", 1)],
    ),
    (
        "empty OpenAI stream guard removed",
        [("      if (tokenCount === 0 && outputTokens === 0 && toolIndex === 0 && meteredCredits === 0) {\n"
          "        throw new EmptyUpstreamResponse();\n      }",
          "      // guard removed", 1)],
    ),
    (
        "empty non-stream Claude guard removed",
        [("  if (!text && !reasoning && toolOrder.length === 0 && outputTokens === 0 && credits === 0) {\n"
          "    throw withPartialUsage(new EmptyUpstreamResponse(), credits, inputTokens, outputTokens);\n  }",
          "  // guard removed", 1)],
    ),
    (
        "empty non-stream OpenAI guard removed",
        [("  if (!content && !reasoning && toolOrder.length === 0 && outputTokens === 0 && credits === 0) {\n"
          "    throw withPartialUsage(new EmptyUpstreamResponse(), credits, inputTokens, outputTokens);\n  }",
          "  // guard removed", 1)],
    ),
    (
        "hardcoded 30-token fallback restored",
        [("          const finalOut = tokens > 0 ? tokens : 0;",
          "          const finalOut = tokens > 0 ? tokens : 30;", 2)],
    ),
    (
        "metered flag hardcoded true again",
        [("            metered: finalCredits > 0,", "            metered: true,", 2),
         ("        metered: finalCredits > 0,", "        metered: true,", 2)],
    ),
    (
        "mid-stream SSE error event not emitted",
        [(r'        await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify(errEv)}\n\n`));',
          "        // error event suppressed", 1)],
    ),
    # --- pre-response empty-stream resilience ---
    (
        "preflight skips generic content types again",
        [("  if (!response?.ok || !response.body) return response;",
          "  if (!response?.ok || !response.body) return response;\n"
          "  const contentType = String(response.headers.get(\"Content-Type\") || \"\").toLowerCase();\n"
          "  if (contentType && !contentType.includes(\"eventstream\") && !contentType.includes(\"octet-stream\")) return response;", 1)],
    ),
    (
        "structured assistant placeholder becomes productive again",
        [("          nonEmptyString(payloadJson.content) ||",
          "          payloadJson.content ||", 1)],
    ),
    (
        "invalid event-stream prelude leaks to client parser",
        [('        return transientEmpty(`invalid AWS event-stream prelude (total=${totalLen}, headers=${headersLen})`);',
          "        productive = true;\n        break;", 1)],
    ),
    (
        "same-model retry no longer preflights empty streams",
        [("function callKiroWithModelRetry(credential, payload) {\n"
          "  return fetchWithModelRetry(async () => preflightKiroEventStream(\n"
          "    await callKiro(credential, payload),\n"
          "  ));\n"
          "}",
          "function callKiroWithModelRetry(credential, payload) {\n"
          "  return fetchWithModelRetry(() => callKiro(credential, payload));\n"
          "}", 1)],
    ),
    # --- credit accounting on the new failure paths ---
    (
        "partial credits dropped on a failed non-stream request",
        [("    throw withPartialUsage(parseErr, credits, inputTokens, outputTokens);",
          "    throw parseErr;", 2)],
    ),
    (
        "withPartialUsage stops carrying the charge",
        [("    err.partialCredits = Math.max(0, Number(credits) || 0);",
          "    err.partialCredits = 0;", 1)],
    ),
    (
        "failed request releases instead of settling what it owes",
        [("  const settled = owed > 0\n"
          "    ? await settleApiKeyQuota(env, opts.apiKeyId, opts.reservation, owed)\n"
          "    : (await releaseApiKeyQuota(env, opts.apiKeyId, opts.reservation), null);",
          "  await releaseApiKeyQuota(env, opts.apiKeyId, opts.reservation);\n  const settled = null;", 1)],
    ),
    (
        "failed request charges even when nothing was produced",
        [("  const owed = Math.max(0, Number(opts.owedCredits) || 0);",
          "  const owed = Math.max(0.5, Number(opts.owedCredits) || 0);", 1)],
    ),
    (
        "failed request leaves no log row",
        [("  await recordRequestStats(env, ctx, false, inTok, 0, owed, {",
          "  if (false) await recordRequestStats(env, ctx, false, inTok, 0, owed, {", 1)],
    ),
    (
        "retry underpays by dropping owed credits",
        [("  return parseFloat((own + owed).toFixed(6));",
          "  return own;", 1)],
    ),
    (
        "content length exceeded returns raw AWS JSON",
        [("  if (isContentLengthExceeded(status, text)) {",
          "  if (false) {", 1)],
    ),
]


def run_suite(workdir: Path):
    # A mutation can make the suite hang rather than fail: an abandoned promise
    # keeps the runner alive with no result. That is still a red suite, so bound
    # it and report the timeout as a failure rather than waiting forever.
    try:
        proc = subprocess.run(
            ["node", "--test"] + [s.name for s in SUITES],
            cwd=workdir, capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return (0, 1, ["<suite hung, killed after 180s>"])
    failed = re.findall(r"^not ok \d+ - (.+)$", proc.stdout, re.M)
    npass = re.search(r"^# pass (\d+)$", proc.stdout, re.M)
    nfail = re.search(r"^# fail (\d+)$", proc.stdout, re.M)
    return (int(npass.group(1)) if npass else -1,
            int(nfail.group(1)) if nfail else -1,
            failed)


def main():
    src = WORKER.read_text()
    blind_spots = []

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        for s in SUITES:
            shutil.copy(s, work / s.name)

        # Baseline must be green.
        (work / WORKER.name).write_text(src)
        npass, nfail, failed = run_suite(work)
        print(f"baseline                                   pass={npass} fail={nfail}")
        if nfail != 0:
            print("  baseline is not green; aborting")
            return 1

        print()
        print("reverting each fix (each must turn a test red):")
        for label, edits in MUTATIONS:
            mutated = src
            ok = True
            for needle, repl, count in edits:
                found = mutated.count(needle)
                if found < count:
                    print(f"  {label:<42} SKIP anchor missing ({found}/{count})")
                    ok = False
                    break
                mutated = mutated.replace(needle, repl, count)
            if not ok:
                continue

            (work / WORKER.name).write_text(mutated)
            npass, nfail, failed = run_suite(work)
            status = "CAUGHT" if nfail > 0 else "BLIND SPOT"
            names = "; ".join(failed)[:96] if failed else "-"
            print(f"  {label:<42} {status:<11} fail={nfail}  {names}")
            if nfail == 0:
                blind_spots.append(label)

    print()
    if blind_spots:
        print(f"{len(blind_spots)} uncovered mutation(s):")
        for b in blind_spots:
            print(f"  - {b}")
        return 1
    print(f"all {len(MUTATIONS)} mutations caught by the suite")
    return 0


if __name__ == "__main__":
    sys.exit(main())
