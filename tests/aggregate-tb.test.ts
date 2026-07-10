import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { TBENCH_INTEGRITY_PATTERNS, aggregateTbResults, parseMoaTelemetry, renderMarkdown, scanTrialIntegrity } from "../scripts/aggregate-tb-results.ts";

const fixtureDir = join(process.cwd(), "tests", "fixtures", "tb-jobs");

function makeTempTrial(): string {
  return mkdtempSync(join(tmpdir(), "gsd-moa-droid-integrity-"));
}

function writeAgentFile(trialDir: string, path: string, text: string): string {
  const file = join(trialDir, "agent", ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("Terminal-Bench results aggregation", () => {
  it("groups trials and summarizes pass rate, exceptions, and MoA telemetry", () => {
    const report = aggregateTbResults(fixtureDir);

    assert.equal(TBENCH_INTEGRITY_PATTERNS.some((pattern) => pattern.label === "tbench.ai"), true);
    assert.equal(report.trialCount, 6);
    assert.ok(report.trialRecords.some((trial) => trial.trialName === "demo-task__env-timeout-no-result"));
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].task, "terminal-bench/demo-task");
    assert.equal(report.tasks[0].groups.length, 2);

    const group = report.tasks[0].groups.find((candidate) => candidate.alias === "model-a" && candidate.label === "-");
    assert.ok(group);
    assert.equal(group.trials, 3);
    assert.equal(group.voids, 2);
    assert.equal(group.passes, 1);
    assert.equal(group.passRate, 1 / 3);
    assert.equal(group.integrity.tainted, 1);
    assert.equal(group.integrity.wouldPassZeroed, 1);
    assert.equal(group.integrity.patterns["tbench.ai"], 1);
    assert.equal(group.integrity.patterns["laude-institute/terminal-bench"], 1);
    assert.equal(group.voidReasons["Trial demo-task__env-timeout failed: Environment start timed out after 600.0 seconds"], 1);
    assert.equal(group.exceptionsByClass.AgentTimeoutError, 1);
    assert.equal(group.timeouts, 1);
    assert.equal(group.moa.checkpointRuns.drift, 1);
    assert.equal(group.moa.cacheHits, 1);
    assert.equal(group.moa.cacheLookups, 1);
    assert.equal(group.moa.combinedUsage.input, 15);
    assert.equal(group.moa.combinedUsage.output, 26);
    assert.equal(group.moa.combinedUsage.cost, 0.02);
    assert.equal(group.moa.pricedInnerCalls, 1);
    assert.equal(group.moa.unpricedInnerCalls, 1);
    assert.equal(group.moa.doneGateEvents, 1);
    assert.equal(group.moa.doneGateTrials, 1);
    assert.equal(group.moa.doneGateModifiedTrials, 1);
    assert.equal(group.moa.doneGateVerifierRunTrials, 0);
    assert.equal(group.moa.doneGateFireTrials, 1);
    assert.equal(group.moa.doneGateArmed, 1);
    assert.equal(group.moa.doneGateFired, 1);
    assert.equal(group.moa.doneGateModifiedTurns, 1);
    assert.equal(group.moa.doneGateVerifierPassTrials, 0);
    assert.equal(group.moa.doneGateVerifierFailureTrials, 0);
    assert.equal(group.moa.doneGatePostBehavior["verification-requested"], 1);
    assert.equal(group.moa.doneGateOutcomes["verification-requested"], 1);
    assert.equal(group.time.toolMeanMs, 7000);
    assert.equal(group.time.referenceMeanMs, 10000);
    assert.equal(group.time.modelOtherMeanMs, 62000);

    const nested = report.tasks[0].groups.find((candidate) => candidate.alias === "model-a" && candidate.label === "matrix-e1-single");
    assert.ok(nested);
    assert.equal(nested.trials, 1);
    assert.equal(nested.passes, 1);
    assert.equal(nested.passRate, 1);
    assert.equal(nested.integrity.unknown, 1);

    const markdown = renderMarkdown(report);
    assert.match(markdown, /## terminal-bench\/demo-task/);
    assert.match(markdown, /model-a/);
    assert.match(markdown, /matrix-e1-single/);
    assert.match(markdown, /Time tool\/refΣ\/non-tool/);
    assert.match(markdown, /Done gate/);
    assert.match(markdown, /1\/3 trials fired; 0\/3 trials verified/);
    assert.match(markdown, /partial \$0\.0200/);
    assert.match(markdown, /pricing coverage \{priced calls: 1, unpriced calls: 1\}/);
    assert.match(markdown, /done gate \{trials: 1, modified trials: 1, fire trials: 1, verifier-run trials: 0, verifier-pass trials: 0, verifier-failure trials: 0, armed events: 1, fired events: 1, outcomes: verification-requested: 1, post snapshots: verification-requested: 1\}/);
    assert.match(markdown, /Integrity/);
    assert.match(markdown, /tainted: 1/);
    assert.match(markdown, /integrity: 1 tainted 3 unknown \(1 would-pass zeroed\) \{laude-institute\/terminal-bench: 1, tbench\.ai: 1\}/);
    assert.match(markdown, /integrity: 1 unknown/);
    assert.match(markdown, /efforts \{primary: unset, proposer: unset\}/);
    assert.match(markdown, /Voids/);
  });

  it("counts typed checkpoint events and trials separately", () => {
    const trialDir = makeTempTrial();
    try {
      const diagnostic = (typedCheckpoint: Record<string, unknown>) => ({
        type: "message_end",
        message: { diagnostics: [{ type: "gsd-moa.details", details: { typedCheckpoint, innerCalls: [] } }] },
      });
      writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
        JSON.stringify(diagnostic({ type: "strategy", status: "fired", mode: "deterministic-note", reason: "initial" })),
        JSON.stringify(diagnostic({ type: "verify_failure", status: "fired", mode: "advisor", reason: "failed verifier", structuredOutputValid: true })),
        JSON.stringify(diagnostic({ type: "verify_failure", status: "fired", mode: "advisor", reason: "failed verifier", structuredOutputValid: false })),
        JSON.stringify(diagnostic({ type: "verify_failure", status: "suppressed", mode: "advisor", reason: "maxPerTask" })),
      ].join("\n"));
      const telemetry = parseMoaTelemetry(trialDir);
      assert.equal(telemetry.typedCheckpointEvents["strategy:fired"], 1);
      assert.equal(telemetry.typedCheckpointEvents["verify_failure:fired"], 2);
      assert.equal(telemetry.typedCheckpointTrials["verify_failure:fired"], 1);
      assert.equal(telemetry.typedCheckpointSuppressions["verify_failure:maxPerTask"], 1);
      assert.equal(telemetry.typedCheckpointStructuredOutputEvents.valid, 1);
      assert.equal(telemetry.typedCheckpointStructuredOutputEvents.invalid, 1);
      assert.equal(telemetry.typedCheckpointStructuredOutputTrials.valid, 1);
      assert.equal(telemetry.typedCheckpointStructuredOutputTrials.invalid, 1);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("does not combine unrelated verifier-only and modified snapshots", () => {
    const trialDir = makeTempTrial();
    try {
      const diagnostic = (doneGate: Record<string, unknown>) => ({
        type: "message_end",
        message: { diagnostics: [{ type: "gsd-moa.details", details: { doneGate, innerCalls: [] } }] },
      });
      writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
        JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: false, verifierRan: true, lastVerifierPassed: true })),
        JSON.stringify(diagnostic({ armed: true, fired: true, filesModified: true, verifierRan: false, postGateBehavior: "ignored" })),
      ].join("\n"));
      const telemetry = parseMoaTelemetry(trialDir);
      assert.equal(telemetry.doneGateTrials, 1);
      assert.equal(telemetry.doneGateModifiedTrials, 1);
      assert.equal(telemetry.doneGateVerifierRunTrials, 0);
      assert.equal(telemetry.doneGateOutcomes.ignored, 1);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("keeps post-fire verification out of the pre-done verifier metric", () => {
    const trialDir = makeTempTrial();
    try {
      const diagnostic = (doneGate: Record<string, unknown>) => ({
        type: "message_end",
        message: { diagnostics: [{ type: "gsd-moa.details", details: { doneGate, innerCalls: [] } }] },
      });
      writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
        JSON.stringify(diagnostic({ armed: true, fired: true, filesModified: true, verifierRan: false })),
        JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: true, verifierRan: true, lastVerifierPassed: true })),
      ].join("\n"));
      const telemetry = parseMoaTelemetry(trialDir);
      assert.equal(telemetry.doneGateVerifierRunTrials, 0);
      assert.equal(telemetry.doneGateVerifierPassTrials, 0);
      assert.equal(telemetry.doneGateOutcomes.verified, 1);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("distinguishes failed and unknown post-fire verification outcomes", () => {
    for (const [lastVerifierPassed, expected] of [[false, "verification-failed"], [undefined, "verification-unknown"]] as const) {
      const trialDir = makeTempTrial();
      try {
        const diagnostic = (doneGate: Record<string, unknown>) => ({
          type: "message_end",
          message: { diagnostics: [{ type: "gsd-moa.details", details: { doneGate, innerCalls: [] } }] },
        });
        writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
          JSON.stringify(diagnostic({ armed: true, fired: true, filesModified: true, verifierRan: false })),
          JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: true, verifierRan: true, ...(lastVerifierPassed === undefined ? {} : { lastVerifierPassed }) })),
        ].join("\n"));
        const telemetry = parseMoaTelemetry(trialDir);
        assert.equal(telemetry.doneGateOutcomes[expected], 1);
        assert.equal(telemetry.doneGateOutcomes.verified, undefined);
      } finally {
        rmSync(trialDir, { recursive: true, force: true });
      }
    }
  });

  it("does not carry verifier evidence across later mutations", () => {
    const trialDir = makeTempTrial();
    try {
      const diagnostic = (doneGate: Record<string, unknown>) => ({
        type: "message_end",
        message: { diagnostics: [{ type: "gsd-moa.details", details: { doneGate, innerCalls: [] } }] },
      });
      writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
        JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: true, verifierRan: true, lastVerifierPassed: true })),
        JSON.stringify(diagnostic({ armed: true, fired: true, filesModified: true, verifierRan: false, postGateBehavior: "verification-requested" })),
        JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: true, verifierRan: true, lastVerifierPassed: true })),
        JSON.stringify(diagnostic({ armed: false, fired: false, filesModified: true, verifierRan: false })),
      ].join("\n"));
      const telemetry = parseMoaTelemetry(trialDir);
      assert.equal(telemetry.doneGateVerifierRunTrials, 0);
      assert.equal(telemetry.doneGateVerifierPassTrials, 0);
      assert.equal(telemetry.doneGateOutcomes.verified, undefined);
      assert.equal(telemetry.doneGateOutcomes["verification-requested"], 1);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("counts cumulative verifier snapshots once per trial", () => {
    const trialDir = makeTempTrial();
    try {
      const diagnostic = {
        type: "gsd-moa.details",
        details: {
          doneGate: { armed: false, fired: false, filesModified: true, verifierRan: true, lastVerifierPassed: true },
          innerCalls: [],
        },
      };
      writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", [
        JSON.stringify({ type: "message_end", message: { diagnostics: [diagnostic] } }),
        JSON.stringify({ type: "message_end", message: { diagnostics: [diagnostic] } }),
      ].join("\n"));
      const telemetry = parseMoaTelemetry(trialDir);
      assert.equal(telemetry.doneGateEvents, 2);
      assert.equal(telemetry.doneGateVerifierRunTrials, 1);
      assert.equal(telemetry.doneGateVerifierPassTrials, 1);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("scans clean Droid stream-jsonl logs when Pi logs are absent", () => {
    const trialDir = makeTempTrial();
    try {
      const droidStream = writeAgentFile(trialDir, "droid/output.stream-jsonl", "{\"type\":\"message\",\"content\":\"all good\"}\n");

      const integrity = scanTrialIntegrity(trialDir);

      assert.equal(integrity.status, "clean");
      assert.deepEqual(integrity.scannedFiles, [droidStream]);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("marks Droid stream-jsonl logs tainted and would-pass zeroed", () => {
    const trialDir = makeTempTrial();
    try {
      const droidStream = writeAgentFile(trialDir, "droid/output.stream-jsonl", "Droid mentioned tbench.ai in output\n");

      const integrity = scanTrialIntegrity(trialDir, 1);

      assert.equal(integrity.status, "tainted");
      assert.equal(integrity.wouldPassZeroed, true);
      assert.deepEqual(integrity.matchedPatterns, ["tbench.ai"]);
      assert.deepEqual(integrity.scannedFiles, [droidStream]);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("falls back to Droid output.txt when stream-jsonl is missing", () => {
    const trialDir = makeTempTrial();
    try {
      const droidText = writeAgentFile(trialDir, "droid/output.txt", "plain stdout without benchmark leakage\n");

      const integrity = scanTrialIntegrity(trialDir);

      assert.equal(integrity.status, "clean");
      assert.deepEqual(integrity.scannedFiles, [droidText]);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });

  it("preserves Pi log priority over Droid logs", () => {
    const trialDir = makeTempTrial();
    try {
      const piLog = writeAgentFile(trialDir, "pi-gsd-moa/pi-output.jsonl", "clean Pi transcript\n");
      writeAgentFile(trialDir, "droid/output.stream-jsonl", "Droid mentioned tbench.ai in output\n");
      writeAgentFile(trialDir, "droid/output.txt", "Droid mentioned tbench.ai in output\n");

      const integrity = scanTrialIntegrity(trialDir, 1);

      assert.equal(integrity.status, "clean");
      assert.equal(integrity.wouldPassZeroed, false);
      assert.deepEqual(integrity.scannedFiles, [piLog]);
    } finally {
      rmSync(trialDir, { recursive: true, force: true });
    }
  });
});
