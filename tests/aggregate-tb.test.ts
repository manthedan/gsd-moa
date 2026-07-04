import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { TBENCH_INTEGRITY_PATTERNS, aggregateTbResults, renderMarkdown, scanTrialIntegrity } from "../scripts/aggregate-tb-results.ts";

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
    assert.equal(group.moa.combinedUsage.cost, 0.03);
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
    assert.match(markdown, /Integrity/);
    assert.match(markdown, /tainted: 1/);
    assert.match(markdown, /integrity: 1 tainted 3 unknown \(1 would-pass zeroed\) \{laude-institute\/terminal-bench: 1, tbench\.ai: 1\}/);
    assert.match(markdown, /integrity: 1 unknown/);
    assert.match(markdown, /efforts \{primary: unset, proposer: unset\}/);
    assert.match(markdown, /Voids/);
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
