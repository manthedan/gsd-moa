import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Context } from "../src/pi-compat.js";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { chooseTypedCheckpoint, normalizeVerifyFailureGuidance, recordTypedCheckpoint, resetTypedCheckpoints } from "../src/typed-checkpoint.ts";
import type { MoaAction, PolicyDecision, ToolObservationSummary } from "../src/types.ts";

const policy: PolicyDecision = {
  requestedMode: "auto",
  mode: "single",
  reason: "auto default",
  strippedText: "fix the task",
  markers: [],
};
const baseAction: MoaAction = { kind: "single", reason: "auto default" };
const context: Context = { messages: [{ role: "user", content: "fix the task", timestamp: 1 }] };
const summary: ToolObservationSummary = {
  toolResultCount: 2,
  totalToolResultCount: 2,
  failedToolResultCount: 1,
  latestFailureSignals: ["test failure"],
  failureSignals: ["test failure"],
  successSignals: [],
  filesMentioned: ["src/a.ts"],
  likelyStateChange: true,
  trailingFailureStreak: 1,
  digest: "digest",
  text: "Recent tool observations: test failed",
};

beforeEach(() => resetTypedCheckpoints());

describe("M3 typed checkpoints", () => {
  it("adds one deterministic strategy contract on a fresh task", () => {
    const decision = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, false,
      { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] },
      undefined, DEFAULT_CONFIG.timeAware, undefined, "session",
    );
    assert.equal(decision.injectStrategyNote, true);
    assert.equal(decision.action.typedCheckpoint?.type, "strategy");
    assert.equal(decision.action.typedCheckpoint?.mode, "deterministic-note");
    assert.ok(decision.ledgerKey);
    recordTypedCheckpoint(decision.ledgerKey!);
    for (let index = 0; index < 200; index += 1) recordTypedCheckpoint(`other-task-${index}`);
    const repeated = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, false,
      { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] },
      undefined, DEFAULT_CONFIG.timeAware, undefined, "session",
    );
    assert.equal(repeated.injectStrategyNote, false);
    assert.equal(repeated.action.typedCheckpoint?.status, "suppressed");

    const withoutSession = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, false,
      { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] },
      undefined, DEFAULT_CONFIG.timeAware, undefined,
    );
    assert.equal(withoutSession.injectStrategyNote, true);
  });

  it("runs one failed-verifier advisor and then suppresses repeats", () => {
    const state = {
      filesModified: true,
      modifiedFiles: ["src/a.ts"],
      confirmedModifiedFiles: ["src/a.ts"],
      commandsRun: 2,
      verifierRan: true,
      lastVerifierPassed: false,
      lastVerifierHadPrecedingMutation: true,
      lastVerifierCommand: "npm test",
      lastVerifierCommandClass: "npm test",
      verifierEvidence: ["npm test"],
    };
    const first = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, true, state, summary,
      DEFAULT_CONFIG.timeAware, undefined, "session",
    );
    assert.equal(first.action.kind, "run");
    assert.equal(first.action.typedCheckpoint?.type, "verify_failure");
    assert.ok(first.ledgerKey);
    recordTypedCheckpoint(first.ledgerKey!);

    const repeated = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, true, state, summary,
      DEFAULT_CONFIG.timeAware, undefined, "session",
    );
    assert.equal(repeated.action.kind, "single");
    assert.equal(repeated.action.typedCheckpoint?.status, "suppressed");

    const rescueAction: MoaAction = { kind: "run", mode: "advisor", scope: "failure", reason: "ordinary rescue", observationSummary: summary };
    const rescueAfterCap = chooseTypedCheckpoint(
      true, "typed", context, policy, rescueAction, true, state, summary,
      DEFAULT_CONFIG.timeAware, undefined, "session",
    );
    assert.equal(rescueAfterCap.action.kind, "run");
    assert.equal(rescueAfterCap.action.reason, "ordinary rescue");
    assert.equal(rescueAfterCap.action.typedCheckpoint?.status, "suppressed");

    const reserveAfterCap = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, true, state, summary,
      DEFAULT_CONFIG.timeAware, { remainingMs: 1, inReserve: true, phase: "reserve" }, "session",
    );
    assert.equal(reserveAfterCap.action.typedCheckpoint?.reason, "insufficient reference time budget");
  });

  it("suppresses compacted checkpoints after session-task identity eviction", () => {
    const emptyState = { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] };
    for (let index = 0; index < 513; index += 1) {
      chooseTypedCheckpoint(
        true, "typed", { messages: [{ role: "user", content: `task ${index}`, timestamp: index + 10 }] },
        policy, baseAction, false, emptyState, undefined, DEFAULT_CONFIG.timeAware, undefined, `identity-session-${index}`,
      );
    }
    const compacted: Context = { messages: [{
      role: "user",
      content: "The conversation history before this point was compacted into the following summary:\n\n<summary>task</summary>",
      timestamp: 999,
    }] };
    const decision = chooseTypedCheckpoint(
      true, "typed", compacted, policy, baseAction, true,
      {
        filesModified: true,
        modifiedFiles: ["a.ts"],
        confirmedModifiedFiles: ["a.ts"],
        commandsRun: 2,
        verifierRan: true,
        lastVerifierPassed: false,
        lastVerifierHadPrecedingMutation: true,
        lastVerifierCommand: "npm test",
        lastVerifierCommandClass: "npm test",
        verifierEvidence: ["npm test"],
      },
      summary, DEFAULT_CONFIG.timeAware, undefined, "identity-session-0",
    );
    assert.equal(decision.action.typedCheckpoint?.status, "suppressed");
    assert.match(decision.action.typedCheckpoint?.reason ?? "", /identity/);
  });

  it("validates the four-field verify-failure contract without retrying", () => {
    const valid = normalizeVerifyFailureGuidance("Diagnosis: x\nNext command: npm test\nExpected signal: pass\nStop condition: green");
    assert.equal(valid.valid, true);
    const invalid = normalizeVerifyFailureGuidance("try npm test");
    assert.equal(invalid.valid, false);
    assert.equal(normalizeVerifyFailureGuidance("Diagnosis:\nNext command:\nExpected signal:\nStop condition:").valid, false);
    assert.equal(normalizeVerifyFailureGuidance("Diagnosis: x\n\nNext command: one\nExpected signal: y\nStop condition: z").valid, false);
    assert.equal(normalizeVerifyFailureGuidance("\nDiagnosis: x\nNext command: one\nExpected signal: y\nStop condition: z\n").valid, false);
    assert.equal(normalizeVerifyFailureGuidance("diagnosis: x\nNext command: one\nExpected signal: y\nStop condition: z").valid, false);
    assert.equal(normalizeVerifyFailureGuidance(" Diagnosis: x\nNext command: one\nExpected signal: y\nStop condition: z").valid, false);
    assert.equal(normalizeVerifyFailureGuidance("Diagnosis: x\nNext command: one\nNext command: two\nExpected signal: y\nStop condition: z").valid, false);
    assert.match(invalid.text, /Structured verify-failure contract invalid/);
  });

  it("does not fire for passing, stale, explicit, or reserve states", () => {
    const passing = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, true,
      { filesModified: true, modifiedFiles: ["a.ts"], commandsRun: 1, verifierRan: true, lastVerifierPassed: true, verifierEvidence: ["npm test"] },
      summary, DEFAULT_CONFIG.timeAware, undefined,
    );
    assert.equal(passing.action.typedCheckpoint, undefined);

    const explicit = chooseTypedCheckpoint(
      true, "typed", context, { ...policy, markers: ["<!-- gsd-moa:advisor -->"] }, baseAction, true,
      { filesModified: true, modifiedFiles: ["a.ts"], commandsRun: 1, verifierRan: true, lastVerifierPassed: false, lastVerifierHadPrecedingMutation: true, lastVerifierCommand: "npm test", lastVerifierCommandClass: "npm test", verifierEvidence: ["npm test"] },
      summary, DEFAULT_CONFIG.timeAware, undefined,
    );
    assert.equal(explicit.action.typedCheckpoint, undefined);

    const compacted: Context = {
      messages: [{
        role: "user",
        content: "The conversation history before this point was compacted into the following summary:\n\n<summary>task</summary>",
        timestamp: 99,
      }],
    };
    const noSession = chooseTypedCheckpoint(
      true, "typed", compacted, policy, baseAction, true,
      { filesModified: true, modifiedFiles: ["a.ts"], commandsRun: 1, verifierRan: true, lastVerifierPassed: false, lastVerifierHadPrecedingMutation: true, lastVerifierCommand: "npm test", lastVerifierCommandClass: "npm test", verifierEvidence: ["npm test"] },
      summary, DEFAULT_CONFIG.timeAware, undefined,
    );
    assert.equal(noSession.action.typedCheckpoint?.status, "suppressed");
    assert.match(noSession.action.typedCheckpoint?.reason ?? "", /identity/);
    const compactedStrategy = chooseTypedCheckpoint(
      true, "typed", compacted, policy, baseAction, false,
      { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] },
      undefined, DEFAULT_CONFIG.timeAware, undefined, "compacted-session",
    );
    assert.equal(compactedStrategy.injectStrategyNote, false);
    assert.equal(compactedStrategy.action.typedCheckpoint?.status, "suppressed");
    assert.match(compactedStrategy.action.typedCheckpoint?.reason ?? "", /compaction/);

    const strategyReserve = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, false,
      { filesModified: false, modifiedFiles: [], commandsRun: 0, verifierRan: false, verifierEvidence: [] },
      undefined, DEFAULT_CONFIG.timeAware,
      { remainingMs: 1, inReserve: true, phase: "reserve" }, "strategy-reserve",
    );
    assert.equal(strategyReserve.injectStrategyNote, true);
    assert.equal(strategyReserve.action.typedCheckpoint?.status, "fired");

    const reserve = chooseTypedCheckpoint(
      true, "typed", context, policy, baseAction, true,
      { filesModified: true, modifiedFiles: ["a.ts"], commandsRun: 1, verifierRan: true, lastVerifierPassed: false, lastVerifierHadPrecedingMutation: true, lastVerifierCommand: "npm test", lastVerifierCommandClass: "npm test", verifierEvidence: ["npm test"] },
      summary, DEFAULT_CONFIG.timeAware,
      { remainingMs: 1, inReserve: true, phase: "reserve" }, "session",
    );
    assert.equal(reserve.action.kind, "single");
    assert.equal(reserve.action.typedCheckpoint?.status, "suppressed");
    assert.match(reserve.action.typedCheckpoint?.reason ?? "", /time budget/);
  });
});
