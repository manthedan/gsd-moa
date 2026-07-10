import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context } from "../src/pi-compat.js";
import { buildSessionStateSummary } from "../src/session-state.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantTool(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string, name: string, text: string, isError = false): any {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 2 };
}

function ctx(messages: Context["messages"]): Context {
  return { messages: [{ role: "user", content: "task", timestamp: 0 }, ...messages] };
}

describe("session state summary", () => {
  it("detects edit-tool file modifications", () => {
    const summary = buildSessionStateSummary(ctx([assistantTool("c1", "edit", { path: "src/a.ts", oldText: "a", newText: "b" })]));
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.modifiedFiles, ["src/a.ts"]);
  });

  it("does not derive confirmed paths from write content", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("write-path", "write", { path: "src/a.ts", content: "documentation mentions src/b.ts" }),
      toolResult("write-path", "write", "wrote src/a.ts", false),
    ]));
    assert.deepEqual(summary.modifiedFiles, ["src/a.ts"]);
    assert.deepEqual(summary.confirmedModifiedFiles, ["src/a.ts"]);
  });

  it("detects common destructive shell mutations", () => {
    for (const command of ["rm src/a.ts", "git rm src/a.ts", "chmod 600 src/a.ts", "truncate -s 0 src/a.ts", "ln -s source.ts src/a.ts"]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`mutation-${command}`, "bash", { command }),
        toolResult(`mutation-${command}`, "bash", "", false),
      ]));
      assert.equal(summary.filesModified, true, command);
      assert.ok(summary.confirmedModifiedFiles?.includes("src/a.ts"), command);
    }
  });

  it("recognizes env-wrapped mutation executables", () => {
    for (const [command, target] of [["env -- rm src/a.ts", "src/a.ts"], ["env MODE=prod mv src/a.ts src/b.ts", "src/b.ts"]] as const) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`env-mutation-${command}`, "bash", { command }),
        toolResult(`env-mutation-${command}`, "bash", "", false),
      ]));
      assert.equal(summary.filesModified, true, command);
      assert.ok(summary.confirmedModifiedFiles?.includes(target), command);
    }
  });

  it("detects package-manager installation mutations", () => {
    for (const command of ["npm install", "npm i", "npm ci", "npm clean-install", "npm ic", "pnpm i", "npm uninstall zod", "pnpm add zod", "yarn add zod", "pip install pytest", "pip uninstall pytest", "python3 -m pip install pytest", "bundle install", "composer update"]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`install-${command}`, "bash", { command }),
        toolResult(`install-${command}`, "bash", "", false),
      ]));
      assert.equal(summary.filesModified, true, command);
    }
  });

  it("attributes multi-source copy and move commands to the destination", () => {
    for (const command of ["cp a.ts b.ts out/", "mv a.ts b.ts out/", "cp -t out/ a.ts b.ts", "  cp a.ts b.ts out/"]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`multi-copy-${command}`, "bash", { command }),
        toolResult(`multi-copy-${command}`, "bash", "", false),
      ]));
      assert.deepEqual(summary.confirmedModifiedFiles, ["out/"], command);
    }
  });

  it("detects adjacent and descriptor-prefixed output redirects", () => {
    for (const [command, target] of [["echo x>src/a.ts", "src/a.ts"], ["cmd 2>errors.log", "errors.log"], ["cmd &>combined.log", "combined.log"]] as const) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`redirect-${command}`, "bash", { command }),
        toolResult(`redirect-${command}`, "bash", "", false),
      ]));
      assert.equal(summary.filesModified, true, command);
      assert.ok(summary.modifiedFiles.includes(target), command);
    }
  });

  it("preserves possible partial success for multi-target rm", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("partial-rm", "bash", { command: "  rm existing.txt missing.txt" }),
      toolResult("partial-rm", "bash", "rm: missing.txt: No such file or directory", true),
    ]));
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.modifiedFiles, ["existing.txt", "missing.txt"]);
  });

  it("detects bash redirection file modifications", () => {
    const summary = buildSessionStateSummary(ctx([assistantTool("c1", "bash", { command: "echo x > f.py" })]));
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.modifiedFiles, ["f.py"]);
    assert.equal(summary.commandsRun, 1);
  });

  it("does not count failed mutation calls as file modifications", () => {
    const editFailure = buildSessionStateSummary(ctx([
      assistantTool("c1", "write", { path: "src/a.ts", content: "x" }),
      toolResult("c1", "write", "EACCES: permission denied", true),
    ]));
    assert.equal(editFailure.filesModified, false);
    assert.deepEqual(editFailure.modifiedFiles, []);

    const partialWriteFailure = buildSessionStateSummary(ctx([
      assistantTool("c1b", "write", { path: "src/a.ts", content: "x" }),
      toolResult("c1b", "write", "Successfully replaced text in src/a.ts; failed to update src/b.ts", true),
    ]));
    assert.equal(partialWriteFailure.filesModified, true);
    assert.deepEqual(partialWriteFailure.modifiedFiles, ["src/a.ts"]);

    const resolvedPartialFailure = buildSessionStateSummary(ctx([
      assistantTool("resolved-partial", "write", { path: "src/a.ts", content: "x" }),
      toolResult("resolved-partial", "write", "Resolved conflicts across src/a.ts; failed src/b.ts", true),
    ]));
    assert.equal(resolvedPartialFailure.filesModified, true);

    for (const failureText of ["file was not modified", "could not be saved", "no files were updated", "Nothing was modified", "0 files updated", "File was modified since it was last read"]) {
      const negatedWrite = buildSessionStateSummary(ctx([
        assistantTool(`negated-${failureText}`, "write", { path: "src/a.ts", content: "x" }),
        toolResult(`negated-${failureText}`, "write", failureText, true),
      ]));
      assert.equal(negatedWrite.filesModified, false, failureText);
    }

    const shellFailure = buildSessionStateSummary(ctx([
      assistantTool("c2", "bash", { command: "echo x > f.py" }),
      toolResult("c2", "bash", "permission denied", true),
    ]));
    assert.equal(shellFailure.filesModified, false);
    assert.deepEqual(shellFailure.modifiedFiles, []);

    const heredocWriteFailure = buildSessionStateSummary(ctx([
      assistantTool("c2-heredoc", "bash", { command: "cat > /protected/a.ts <<'EOF'\nconst x = 1;\nEOF" }),
      toolResult("c2-heredoc", "bash", "/protected/a.ts: Permission denied", true),
    ]));
    assert.equal(heredocWriteFailure.filesModified, false);

    const failedFirstMutation = buildSessionStateSummary(ctx([
      assistantTool("c2b", "bash", { command: "cp missing.txt out.txt && npm test" }),
      toolResult("c2b", "bash", "cp: missing.txt: No such file or directory", true),
    ]));
    assert.equal(failedFirstMutation.filesModified, false);

    const failedCompoundRedirection = buildSessionStateSummary(ctx([
      assistantTool("c2c", "bash", { command: "echo x > /protected/a.txt && npm test" }),
      toolResult("c2c", "bash", "bash: /protected/a.txt: Permission denied", true),
    ]));
    assert.equal(failedCompoundRedirection.filesModified, false);

    const partialShellFailure = buildSessionStateSummary(ctx([
      assistantTool("c3", "bash", { command: "echo x > partial.py; cat missing.txt" }),
      toolResult("c3", "bash", "cat: missing.txt: No such file or directory", true),
    ]));
    assert.equal(partialShellFailure.filesModified, true);
    assert.ok(partialShellFailure.modifiedFiles.includes("partial.py"));

    const multiTargetPartialFailure = buildSessionStateSummary(ctx([
      assistantTool("c3b", "bash", { command: "echo x > a.py; echo y > /protected/b.py" }),
      toolResult("c3b", "bash", "/protected/b.py: Permission denied", true),
    ]));
    assert.equal(multiTargetPartialFailure.filesModified, true);
    assert.ok(multiTargetPartialFailure.modifiedFiles.includes("a.py"));

    const failedThenContinuedMutation = buildSessionStateSummary(ctx([
      assistantTool("c3c", "bash", { command: "touch /protected/a.txt; touch b.txt; exit 1" }),
      toolResult("c3c", "bash", "touch: /protected/a.txt: Permission denied", true),
    ]));
    assert.equal(failedThenContinuedMutation.filesModified, true);
    assert.ok(failedThenContinuedMutation.modifiedFiles.includes("b.txt"));

    const laterAndFailure = buildSessionStateSummary(ctx([
      assistantTool("c3d", "bash", { command: "echo x > a.txt && chmod 000 a.txt && cat a.txt" }),
      toolResult("c3d", "bash", "cat: a.txt: Permission denied", true),
    ]));
    assert.equal(laterAndFailure.filesModified, true);
    assert.ok(laterAndFailure.modifiedFiles.includes("a.txt"));

    const rejectedPatch = buildSessionStateSummary(ctx([
      assistantTool("c4", "bash", { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: rejected.py\n@@\n-x\n+y\n*** End Patch\nPATCH" }),
      toolResult("c4", "bash", "Invalid Context: could not find -x", true),
    ]));
    assert.equal(rejectedPatch.filesModified, false);

    for (const failureText of ["Hunk #1 FAILED at 3", "Failed to find expected lines in rejected.py"]) {
      const standardPatchFailure = buildSessionStateSummary(ctx([
        assistantTool(`patch-${failureText}`, "bash", { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: rejected.py\n@@\n-x\n+y\n*** End Patch\nPATCH" }),
        toolResult(`patch-${failureText}`, "bash", failureText, true),
      ]));
      assert.equal(standardPatchFailure.filesModified, false, failureText);
    }

    const partialPatch = buildSessionStateSummary(ctx([
      assistantTool("partial-patch", "bash", { command: "patch -p0 <<'PATCH'\n--- a.py\n+++ a.py\nPATCH" }),
      toolResult("partial-patch", "bash", "Hunk #1 succeeded\nHunk #2 FAILED", true),
    ]));
    assert.equal(partialPatch.filesModified, true);

    const fullyRejectedPatch = buildSessionStateSummary(ctx([
      assistantTool("rejected-plain-patch", "bash", { command: "patch -p0 < change.patch" }),
      toolResult("rejected-plain-patch", "bash", "0 out of 1 hunk applied", true),
    ]));
    assert.equal(fullyRejectedPatch.filesModified, false);

    const rejectedMkdir = buildSessionStateSummary(ctx([
      assistantTool("c5", "bash", { command: "mkdir /protected/x && cd /protected/x" }),
      toolResult("c5", "bash", "mkdir: cannot create directory '/protected/x': Permission denied", true),
    ]));
    assert.equal(rejectedMkdir.filesModified, false);

    for (const failureText of [
      "error: pathspec 'missing' did not match any file(s) known to git",
      "fatal: not a git repository (or any of the parent directories): .git",
    ]) {
      const failedCheckout = buildSessionStateSummary(ctx([
        assistantTool(`git-${failureText}`, "bash", { command: "git checkout missing" }),
        toolResult(`git-${failureText}`, "bash", failureText, true),
      ]));
      assert.equal(failedCheckout.filesModified, false, failureText);
    }

    const partialTouch = buildSessionStateSummary(ctx([
      assistantTool("c6", "bash", { command: "touch created.txt /protected/denied.txt" }),
      toolResult("c6", "bash", "/protected/denied.txt: Permission denied", true),
    ]));
    assert.equal(partialTouch.filesModified, true);
    assert.ok(partialTouch.modifiedFiles.includes("created.txt"));
  });

  it("does not infer file modifications from arbitrary read-only output", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "rg updated README.md" }),
      toolResult("c1", "bash", "README.md: updated docs", false),
    ]));
    assert.equal(summary.filesModified, false);
    assert.deepEqual(summary.modifiedFiles, []);
  });

  it("detects file modifications from shell-run code", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "python3 - <<'PY'\nfrom pathlib import Path\nPath('f.py').write_text('print(1)')\nPY" }),
      toolResult("c1", "bash", "created f.py", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.ok(summary.modifiedFiles.includes("f.py"));
  });

  it("detects prefixed interpreter mutations", () => {
    for (const command of [
      "/usr/bin/python3 -c \"from pathlib import Path; Path('a').write_text('x')\"",
      ".venv/bin/python -c \"from pathlib import Path; Path('a').write_text('x')\"",
      "/usr/local/bin/python3 -c \"open('a', 'w').write('x')\"",
      "/opt/homebrew/bin/node -e \"require('fs').writeFileSync('a', 'x')\"",
      "sudo python3 -c \"open('a', 'w').write('x')\"",
    ]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`prefixed-code-${command}`, "bash", { command }),
        toolResult(`prefixed-code-${command}`, "bash", "", false),
      ]));
      assert.equal(summary.filesModified, true, command);
    }
  });

  it("detects file modifications from shell apply_patch helpers", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: f.py\n@@\n-x\n+y\n*** End Patch\nPATCH" }),
      toolResult("c1", "bash", "Done!", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.ok(summary.modifiedFiles.includes("f.py"));
  });

  it("detects clean py_compile verifier results", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "python3 -m py_compile f.py" }),
      toolResult("c1", "bash", "", false),
    ]));
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.deepEqual(summary.verifierEvidence, ["python3 -m py_compile f.py"]);
  });

  it("does not treat descriptor-only verifier redirection as a later mutation", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("write-before-fd", "write", { path: "a.ts", content: "x" }),
      toolResult("write-before-fd", "write", "wrote a.ts", false),
      assistantTool("verify-with-fd", "bash", { command: "npm test 2>&1" }),
      toolResult("verify-with-fd", "bash", "1 failed", true),
    ]));
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, false);
    assert.equal(summary.lastVerifierCommand, "npm test 2>&1");
    assert.equal(summary.lastVerifierHadPrecedingMutation, true);
  });

  it("recognizes verifier output redirection and leading environment assignments", () => {
    for (const command of ["npm test >/dev/null 2>&1", "npm test &>test.log", "npm test >&test.log", "CI=1 npm test", "env CI=1 npm test", "/usr/bin/env CI=1 pytest", "env -u NODE_OPTIONS npm test", "env -C /tmp pytest", "env -- npm test"]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`write-${command}`, "write", { path: "a.ts", content: "x" }),
        toolResult(`write-${command}`, "write", "wrote a.ts", false),
        assistantTool(`verify-${command}`, "bash", { command }),
        toolResult(`verify-${command}`, "bash", "1 failed", true),
      ]));
      assert.equal(summary.verifierRan, true, command);
      assert.equal(summary.lastVerifierPassed, false, command);
      assert.equal(summary.lastVerifierCommand, command);
      assert.equal(summary.lastVerifierHadPrecedingMutation, true, command);
    }
    const piped = buildSessionStateSummary(ctx([
      assistantTool("piped-write", "write", { path: "a.ts", content: "x" }),
      toolResult("piped-write", "write", "wrote a.ts", false),
      assistantTool("piped-test", "bash", { command: "npm test |& cat" }),
      toolResult("piped-test", "bash", "1 failed", true),
    ]));
    assert.equal(piped.verifierRan, true);
    assert.equal(piped.lastVerifierCommand, undefined);
  });

  it("does not order sibling tool calls that may execute concurrently", () => {
    const batch = assistantTool("parallel-install", "bash", { command: "npm ci" });
    batch.content = [
      { type: "toolCall", id: "parallel-install", name: "bash", arguments: { command: "npm ci" } },
      { type: "toolCall", id: "parallel-test", name: "bash", arguments: { command: "npm test" } },
    ];
    const summary = buildSessionStateSummary(ctx([
      batch,
      toolResult("parallel-test", "bash", "1 failed", true),
      toolResult("parallel-install", "bash", "", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
  });

  it("rejects background verifier attribution and env-prefixed stale verification", () => {
    const background = buildSessionStateSummary(ctx([
      assistantTool("background-write", "write", { path: "a.ts", content: "x" }),
      toolResult("background-write", "write", "wrote a.ts", false),
      assistantTool("background-test", "bash", { command: "npm test & false" }),
      toolResult("background-test", "bash", "1 failed", true),
    ]));
    assert.equal(background.verifierRan, false);

    const stale = buildSessionStateSummary(ctx([
      assistantTool("env-stale", "bash", { command: "CI=1 npm test && sed -i 's/a/b/' a.ts" }),
      toolResult("env-stale", "bash", "ok", false),
    ]));
    assert.equal(stale.filesModified, true);
    assert.equal(stale.verifierRan, false);
  });

  it("does not mistake verifier arguments for destructive mutations", () => {
    for (const command of ["pytest -k rm", "go test ./cmd/rm", "npm test -- --grep 'x; rm y'", "npm test -- --grep writeFile"]) {
      const summary = buildSessionStateSummary(ctx([
        assistantTool(`write-before-${command}`, "write", { path: "a.ts", content: "x" }),
        toolResult(`write-before-${command}`, "write", "wrote a.ts", false),
        assistantTool(`verify-${command}`, "bash", { command }),
        toolResult(`verify-${command}`, "bash", "1 passed", false),
      ]));
      assert.equal(summary.verifierRan, true, command);
      assert.equal(summary.lastVerifierPassed, true, command);
    }
  });

  it("ties failure categories to the selected verifier result", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("signal-write", "write", { path: "a.ts", content: "x" }),
      toolResult("signal-write", "write", "wrote a.ts", false),
      assistantTool("signal-test", "bash", { command: "npm test" }),
      toolResult("signal-test", "bash", "1 failed", true),
      assistantTool("later-read", "read", { path: "other.txt" }),
      toolResult("later-read", "read", "timeout", true),
    ]));
    assert.ok(summary.lastVerifierFailureSignals?.includes("error-output"));
    assert.equal(summary.lastVerifierFailureSignals?.includes("timeout"), false);
  });

  it("detects failing pytest verifier results", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "pytest tests" }),
      toolResult("c1", "bash", "2 failed, 48 passed", true),
    ]));
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, false);
  });

  it("does not count inspection commands mentioning verifier files or keywords", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "echo x > f.py" }),
      toolResult("c1", "bash", "created f.py", false),
      assistantTool("c2", "bash", { command: "cat scripts/validate.py && rg verify docs" }),
      toolResult("c2", "bash", "validate.py mentions verify", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
    assert.deepEqual(summary.verifierEvidence, []);
  });

  it("detects verifier calls inside interpreter heredocs", () => {
    const command = "python3 - <<'PY'\nimport py_compile\npy_compile.compile('f.py', doraise=True)\nPY";
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "echo x > f.py" }),
      toolResult("c1", "bash", "created f.py", false),
      assistantTool("c2", "bash", { command }),
      toolResult("c2", "bash", "", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.deepEqual(summary.verifierEvidence, [command]);
  });

  it("counts executing a modified artifact as verification", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "echo 'print(1)' > f.py" }),
      toolResult("c1", "bash", "created f.py", false),
      assistantTool("c2", "bash", { command: "python3 f.py" }),
      toolResult("c2", "bash", "1", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.deepEqual(summary.verifierEvidence, ["python3 f.py"]);
  });

  it("detects R workflow verification", () => {
    const scriptRun = buildSessionStateSummary(ctx([
      assistantTool("r1", "bash", { command: "printf 'stopifnot(TRUE)' > analysis.R" }),
      toolResult("r1", "bash", "created analysis.R", false),
      assistantTool("r2", "bash", { command: "Rscript analysis.R" }),
      toolResult("r2", "bash", "", false),
    ]));
    assert.equal(scriptRun.verifierRan, true);
    assert.equal(scriptRun.lastVerifierPassed, true);

    const packageCheck = buildSessionStateSummary(ctx([
      assistantTool("r3", "bash", { command: "R CMD check ." }),
      toolResult("r3", "bash", "Status: OK", false),
    ]));
    assert.equal(packageCheck.verifierRan, true);
    assert.equal(packageCheck.lastVerifierPassed, true);
  });

  it("does not count verifier keywords inside written file contents", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "write", { path: "tests/test_f.py", content: "import pytest\n\ndef test_f():\n    validate()\n" }),
      toolResult("c1", "write", "created tests/test_f.py", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
    assert.deepEqual(summary.verifierEvidence, []);
  });

  it("does not count verifier keywords inside shell-written file contents", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command: "cat > tests/test_f.py <<'PY'\nimport pytest\n\ndef test_f():\n    validate()\nPY" }),
      toolResult("c1", "bash", "created tests/test_f.py", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
    assert.deepEqual(summary.verifierEvidence, []);
  });

  it("still detects verifier commands after shell-written file contents", () => {
    const command = "cat > tests/test_f.py <<'PY'\nimport pytest\nPY\npytest tests";
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command }),
      toolResult("c1", "bash", "1 passed", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.equal(summary.lastVerifierHadPrecedingMutation, false);
    assert.deepEqual(summary.verifierEvidence, [command]);
  });

  it("still detects verifier commands after same-line shell writes", () => {
    const command = "echo 'print(1)' > f.py && python3 -m py_compile f.py";
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "bash", { command }),
      toolResult("c1", "bash", "", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.equal(summary.lastVerifierHadPrecedingMutation, true);
    assert.deepEqual(summary.verifierEvidence, [command]);
  });

  it("does not count verifier keywords inside eval-written file contents", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "eval", { code: "await Bun.write('tests/test_f.py', 'import pytest\\ndef test_f(): validate()')" }),
      toolResult("c1", "eval", "created tests/test_f.py", false),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
    assert.deepEqual(summary.verifierEvidence, []);
  });

  it("detects explicit verifier subprocesses inside eval tools", () => {
    const command = "import subprocess\nsubprocess.run(['pytest', 'tests'], check=True)";
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "eval", { code: command }),
      toolResult("c1", "eval", "1 passed", false),
    ]));
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, true);
    assert.deepEqual(summary.verifierEvidence, [command]);
  });

  it("scopes modifications and verifiers to the latest user turn", () => {
    const summary = buildSessionStateSummary({ messages: [
      { role: "user", content: "first task", timestamp: 0 },
      assistantTool("v1", "bash", { command: "pytest tests" }),
      toolResult("v1", "bash", "1 passed", false),
      { role: "user", content: "second task", timestamp: 3 },
      assistantTool("w1", "bash", { command: "echo x > f.py" }),
      toolResult("w1", "bash", "created f.py", false),
    ] });
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.modifiedFiles, ["f.py"]);
    assert.equal(summary.verifierRan, false);
    assert.deepEqual(summary.verifierEvidence, []);
  });

  it("does not attribute a verifier to a later write in the same compound command", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("compound-order", "bash", { command: "npm test && echo ok > marker.txt" }),
      toolResult("compound-order", "bash", "1 failed", true),
    ]));
    assert.equal(summary.verifierRan, false);
    assert.equal(summary.lastVerifierPassed, undefined);
    assert.equal(summary.lastVerifierHadPrecedingMutation, undefined);
  });

  it("does not confirm an ambiguous compound mutation before typed verifier attribution", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("ambiguous-write", "bash", { command: "cp missing.ts src/a.ts || true" }),
      toolResult("ambiguous-write", "bash", "cp: missing.ts: No such file or directory\ncreated fallback", false),
      assistantTool("later-test", "bash", { command: "npm test" }),
      toolResult("later-test", "bash", "1 failed", true),
    ]));
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.confirmedModifiedFiles, []);
    assert.equal(summary.verifierRan, true);
    assert.equal(summary.lastVerifierPassed, false);
    assert.equal(summary.lastVerifierHadPrecedingMutation, false);
  });

  it("does not count a general verifier that ran before the final mutation", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("test-first", "bash", { command: "npm test" }),
      toolResult("test-first", "bash", "all tests passed"),
      assistantTool("write-later", "write", { path: "a.ts", content: "changed" }),
      toolResult("write-later", "write", "wrote a.ts"),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
  });

  it("does not count verification that occurred before the relevant mutation", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("run-first", "bash", { command: "node a.ts" }),
      toolResult("run-first", "bash", "ok"),
      assistantTool("write-later", "write", { path: "a.ts", content: "changed" }),
      toolResult("write-later", "write", "wrote a.ts"),
    ]));
    assert.equal(summary.filesModified, true);
    assert.equal(summary.verifierRan, false);
  });

  it("does not verify a successful mutation by executing a failed target", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("a-write", "write", { path: "a.ts", content: "ok" }),
      toolResult("a-write", "write", "wrote a.ts"),
      assistantTool("b-write", "write", { path: "b.ts", content: "bad" }),
      toolResult("b-write", "write", "permission denied", true),
      assistantTool("b-run", "bash", { command: "node b.ts" }),
      toolResult("b-run", "bash", "ran b.ts"),
    ]));
    assert.deepEqual(summary.modifiedFiles, ["a.ts"]);
    assert.equal(summary.verifierRan, false);
  });

  it("keeps read-only sessions false", () => {
    const summary = buildSessionStateSummary(ctx([
      assistantTool("c1", "read", { path: "src/a.ts" }),
      toolResult("c1", "read", "contents", false),
    ]));
    assert.equal(summary.filesModified, false);
    assert.equal(summary.verifierRan, false);
    assert.equal(summary.lastVerifierPassed, undefined);
    assert.deepEqual(summary.modifiedFiles, []);
  });

  it("caps evidence and file lists", () => {
    const messages: Context["messages"] = [];
    for (let i = 0; i < 25; i++) messages.push(assistantTool(`w${i}`, "write", { path: `file${i}.py`, content: "x" }));
    for (let i = 0; i < 12; i++) {
      messages.push(assistantTool(`v${i}`, "bash", { command: `python3 -m py_compile file${i}.py` }));
      messages.push(toolResult(`v${i}`, "bash", "", false));
    }
    const summary = buildSessionStateSummary(ctx(messages));
    assert.equal(summary.modifiedFiles.length, 20);
    assert.equal(summary.verifierEvidence.length, 10);
    assert.equal(summary.lastVerifierEvidence, "python3 -m py_compile file11.py");
  });
});
