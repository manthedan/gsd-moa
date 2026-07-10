import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { doneGateLedgerKey, readDoneGateLedger, recordDoneGateFire, releaseDoneGateReservation, reserveDoneGate, resetDoneGateLedger, shouldArmDoneGate } from "../src/done-gate.ts";
import type { Context } from "../src/pi-compat.js";
import type { SessionStateSummary } from "../src/session-state.ts";
import type { GsdMoaConfig, TimeState } from "../src/types.ts";

const modifiedNoVerify: SessionStateSummary = { filesModified: true, modifiedFiles: ["f.py"], commandsRun: 1, verifierRan: false, verifierEvidence: [] };
const modifiedVerified: SessionStateSummary = { filesModified: true, modifiedFiles: ["f.py"], commandsRun: 2, verifierRan: true, lastVerifierPassed: true, verifierEvidence: ["python3 f.py"] };
const noModified: SessionStateSummary = { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] };

function cfg(enabled = true): GsdMoaConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.doneGate.enabled = enabled;
  config.doneGate.maxPerTask = 1;
  config.doneGate.minRemainingMs = 90_000;
  return config;
}

function continuation(toolCallId = "c1", toolTimestamp = 3): Context {
  return {
    messages: [
      { role: "user", content: "task", timestamp: 1 },
      { role: "assistant", content: [], api: "openai-completions", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } as any,
      { role: "toolResult", toolName: "bash", toolCallId, content: [{ type: "text", text: "created f.py" }], isError: false, timestamp: toolTimestamp } as any,
    ],
  };
}

const fresh: Context = { messages: [{ role: "user", content: "task", timestamp: 1 }] };
const plenty: TimeState = { remainingMs: 100_000, inReserve: false };

describe("done gate", () => {
  it("reports the arming matrix reasons", () => {
    assert.deepEqual(shouldArmDoneGate(cfg(false), continuation(), modifiedNoVerify, 0, plenty), { armed: false, reason: "disabled" });
    assert.deepEqual(shouldArmDoneGate(cfg(), fresh, modifiedNoVerify, 0, plenty), { armed: false, reason: "not-tool-loop-continuation" });
    assert.deepEqual(shouldArmDoneGate(cfg(), continuation(), noModified, 0, plenty), { armed: false, reason: "no-files-modified" });
    assert.deepEqual(shouldArmDoneGate(cfg(), continuation(), modifiedVerified, 0, plenty), { armed: false, reason: "verifier-ran" });
    assert.deepEqual(shouldArmDoneGate(cfg(), continuation(), modifiedNoVerify, 1, plenty), { armed: false, reason: "ledger-cap" });
    assert.deepEqual(shouldArmDoneGate(cfg(), continuation(), modifiedNoVerify, 0, { remainingMs: 10_000, inReserve: false }), { armed: false, reason: "time-floor" });
    assert.deepEqual(shouldArmDoneGate(cfg(), continuation(), modifiedNoVerify, 0, plenty), { armed: true, reason: "armed" });
  });

  it("keeps stable ledger keys and resets", () => {
    resetDoneGateLedger();
    const key1 = doneGateLedgerKey("alias", continuation());
    const key2 = doneGateLedgerKey("alias", continuation());
    const key3 = doneGateLedgerKey("other", continuation());
    assert.equal(key1, key2);
    assert.notEqual(key1, key3);
    assert.equal(readDoneGateLedger(key1), undefined);
    recordDoneGateFire(key1);
    assert.deepEqual(readDoneGateLedger(key1), { count: 1 });
    for (let index = 0; index < 100; index += 1) recordDoneGateFire(`other-${index}`);
    assert.ok((readDoneGateLedger(key1)?.count ?? 0) >= 1);
    resetDoneGateLedger();
    assert.equal(readDoneGateLedger(key1), undefined);
  });

  it("reserves a done gate atomically while a stream is in flight", () => {
    resetDoneGateLedger();
    const key = doneGateLedgerKey("alias", continuation(), "reservation-session");
    assert.equal(reserveDoneGate(key, 1), true);
    assert.equal(reserveDoneGate(key, 1), false);
    releaseDoneGateReservation(key);
    assert.equal(reserveDoneGate(key, 1), true);
    recordDoneGateFire(key);
    assert.equal(reserveDoneGate(key, 1), false);
  });

  it("separates repeated same-prompt sessions by tool-loop identity", () => {
    const key1 = doneGateLedgerKey("alias", continuation("c1", 3));
    const key2 = doneGateLedgerKey("alias", continuation("c2", 3));
    const key3 = doneGateLedgerKey("alias", continuation("c1", 4));
    assert.notEqual(key1, key2);
    assert.notEqual(key1, key3);
  });

  it("keeps the pre-done ledger stable across compaction with a session id", () => {
    const before = continuation("compact-call", 30);
    const after: Context = { messages: [
      {
        role: "user",
        content: "The conversation history before this point was compacted into the following summary:\n\n<summary>task</summary>",
        timestamp: 40,
      },
      ...before.messages.slice(1),
    ] };
    assert.equal(doneGateLedgerKey("alias", before, "compact-session"), doneGateLedgerKey("alias", after, "compact-session"));
  });

  it("keys the ledger to the current user turn", () => {
    const firstTask = continuation("c1", 3);
    const secondTask: Context = { messages: [
      ...firstTask.messages,
      { role: "user", content: "task", timestamp: 4 },
      { role: "assistant", content: [], api: "openai-completions", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 5 } as any,
      { role: "toolResult", toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "created f.py" }], isError: false, timestamp: 6 } as any,
    ] };
    assert.notEqual(doneGateLedgerKey("alias", firstTask), doneGateLedgerKey("alias", secondTask));
  });
});
