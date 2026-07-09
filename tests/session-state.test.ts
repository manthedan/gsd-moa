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

  it("detects bash redirection file modifications", () => {
    const summary = buildSessionStateSummary(ctx([assistantTool("c1", "bash", { command: "echo x > f.py" })]));
    assert.equal(summary.filesModified, true);
    assert.deepEqual(summary.modifiedFiles, ["f.py"]);
    assert.equal(summary.commandsRun, 1);
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
  });
});
