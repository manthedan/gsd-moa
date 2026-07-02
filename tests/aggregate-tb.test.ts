import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { aggregateTbResults, renderMarkdown } from "../scripts/aggregate-tb-results.ts";

const fixtureDir = join(process.cwd(), "tests", "fixtures", "tb-jobs");

describe("Terminal-Bench results aggregation", () => {
  it("groups trials and summarizes pass rate, exceptions, and MoA telemetry", () => {
    const report = aggregateTbResults(fixtureDir);

    assert.equal(report.trialCount, 2);
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].task, "terminal-bench/demo-task");

    const group = report.tasks[0].groups.find((candidate) => candidate.alias === "model-a");
    assert.ok(group);
    assert.equal(group.trials, 2);
    assert.equal(group.passes, 1);
    assert.equal(group.passRate, 0.5);
    assert.equal(group.exceptionsByClass.AgentTimeoutError, 1);
    assert.equal(group.timeouts, 1);
    assert.equal(group.moa.checkpointRuns.drift, 1);
    assert.equal(group.moa.cacheHits, 1);
    assert.equal(group.moa.cacheLookups, 1);
    assert.equal(group.moa.combinedUsage.input, 15);
    assert.equal(group.moa.combinedUsage.output, 26);
    assert.equal(group.moa.combinedUsage.cost, 0.03);

    const markdown = renderMarkdown(report);
    assert.match(markdown, /## terminal-bench\/demo-task/);
    assert.match(markdown, /model-a/);
  });
});
