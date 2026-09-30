#!/usr/bin/env python3
"""Mutation test for the Go proxy's upstream-error handling.

Reverts each fix in proxy/ one at a time and asserts `go test ./proxy/` turns
red. A fix whose removal keeps the suite green is not actually covered, so it is
reported as a blind spot.

Usage:  python3 proxy/mutation_test.py
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# label -> list of (file, needle, replacement, expected_count)
MUTATIONS = [
    (
        "exception frames swallowed again",
        [("proxy/kiro.go",
          'if messageType == "exception" || messageType == "error" || exceptionType != "" ||\n'
          '\t\t\tstrings.HasSuffix(eventType, "Exception") {',
          # Still references every variable so this compiles: the mutation has to be
          # caught by a test observing behaviour, not by the compiler.
          'if messageType == "\\x00never" && exceptionType == "\\x00never" &&\n'
          '\t\t\tstrings.HasSuffix(eventType, "\\x00never") {', 1)],
    ),
    (
        "header parser only reads :event-type",
        [("proxy/kiro.go",
          "\t\t\tout[name] = string(headers[offset : offset+valueLen])",
          '\t\t\tif name == ":event-type" {\n'
          "\t\t\t\tout[name] = string(headers[offset : offset+valueLen])\n"
          "\t\t\t}", 1)],
    ),
    (
        "empty response guard removed",
        [("proxy/kiro.go",
          "\tif !producedOutput && outputTokens == 0 && totalCredits == 0 {",
          "\tif producedOutput && outputTokens < 0 && totalCredits < 0 {", 1)],
    ),
    (
        "empty response guard ignores metering",
        [("proxy/kiro.go",
          "\tif !producedOutput && outputTokens == 0 && totalCredits == 0 {",
          "\tif !producedOutput && outputTokens == 0 {", 1)],
    ),
    (
        "metered credits dropped on the error path",
        [("proxy/kiro.go",
          "\t\tif callback.OnCredits != nil && totalCredits > 0 {",
          "\t\tif false {", 1)],
    ),
    (
        "typed exception ignored for HTTP status",
        [("proxy/account_failover.go",
          "\tif ue, ok := AsUpstreamError(err); ok {\n\t\treturn ue.StatusCode()\n\t}",
          "", 1)],
    ),
    (
        "typed exception ignored for account health",
        [("proxy/account_failover.go",
          '\t\tcase containsAny(t, "throttl", "toomanyrequests", "servicequota", "limitexceed"):\n'
          "\t\t\th.pool.RecordErrorWithCooldown(account.ID, defaultQuotaCooldown)",
          '\t\tcase containsAny(t, "throttl", "toomanyrequests", "servicequota", "limitexceed"):\n'
          "\t\t\th.pool.RecordError(account.ID, false)", 1)],
    ),
    (
        "HTTP-level modeled exception left untyped",
        [("proxy/kiro.go",
          '\t\t\tif name := upstreamExceptionTypeFromBody(errBody); name != "" {',
          '\t\t\tif name := upstreamExceptionTypeFromBody(errBody); name == "\\x00never" {', 1)],
    ),
    (
        "upstream HTTP status ignored in favour of name guess",
        [("proxy/kiro.go",
          "\tif e.HTTPStatus >= 400 && e.HTTPStatus < 600 {\n\t\treturn e.HTTPStatus\n\t}\n",
          "", 1)],
    ),
    (
        "original error text discarded by the wrap",
        [("proxy/kiro.go",
          '\tif e.Text != "" {\n\t\treturn e.Text\n\t}\n',
          "", 1)],
    ),
    (
        "exception name suffix check dropped (any struct becomes an error)",
        [("proxy/kiro.go",
          '\tif !strings.HasSuffix(name, "Exception") {\n\t\treturn ""\n\t}\n',
          "", 1)],
    ),
]


def run_suite(workdir: Path):
    try:
        proc = subprocess.run(
            ["go", "test", "./proxy/"],
            cwd=workdir, capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return (1, ["<suite hung, killed after 300s>"])
    if proc.returncode == 0:
        return (0, [])
    failed = re.findall(r"^\s*--- FAIL: (\S+)", proc.stdout, re.M)
    if not failed:
        # A build failure counts as red too, but say so plainly.
        head = (proc.stderr or proc.stdout).strip().splitlines()
        failed = ["<build failed: " + (head[0] if head else "unknown") + ">"]
    return (1, failed)


def main():
    with tempfile.TemporaryDirectory() as td:
        work = Path(td) / "src"
        shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".wrangler", "data", "web", "cloudflare",
            "*.log", "kiro-go", "kiro-go-test", "kiro-go.bak-*"))

        originals = {}
        for rel in {f for _, edits in MUTATIONS for f, _, _, _ in edits}:
            originals[rel] = (work / rel).read_text()

        rc, failed = run_suite(work)
        print(f"baseline{'':<44} {'GREEN' if rc == 0 else 'RED'}")
        if rc != 0:
            print("  baseline is not green; aborting:", "; ".join(failed)[:200])
            return 1

        print()
        print("reverting each fix (each must turn a test red):")
        blind = []
        for label, edits in MUTATIONS:
            for rel, text in originals.items():
                (work / rel).write_text(text)

            ok = True
            for rel, needle, repl, count in edits:
                src = (work / rel).read_text()
                found = src.count(needle)
                if found < count:
                    print(f"  {label:<48} SKIP anchor missing ({found}/{count}) in {rel}")
                    ok = False
                    break
                (work / rel).write_text(src.replace(needle, repl, count))
            if not ok:
                blind.append(label + " (anchor missing)")
                continue

            rc, failed = run_suite(work)
            status = "CAUGHT" if rc != 0 else "BLIND SPOT"
            names = "; ".join(failed)[:70] if failed else "-"
            print(f"  {label:<48} {status:<11} {names}")
            if rc == 0:
                blind.append(label)

        for rel, text in originals.items():
            (work / rel).write_text(text)

        print()
        if blind:
            print(f"{len(blind)} uncovered mutation(s):")
            for b in blind:
                print("  -", b)
            return 1
        print(f"all {len(MUTATIONS)} mutations caught by the suite")
        return 0


if __name__ == "__main__":
    sys.exit(main())
