import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "../src/pi-compat.js";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildAdvisorContext } from "../src/advisor.ts";
import { buildToolObservationSummary, latestUserText } from "../src/context.ts";
import { chooseAction, chooseMode } from "../src/policy.ts";
import { streamGsdMoa } from "../src/stream.ts";
import { computeTimeState } from "../src/time.ts";
import type { GsdMoaConfig } from "../src/types.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function model(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "gsd-moa-api",
    provider: "gsd-moa",
    baseUrl: "gsd-moa://local",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

function message(seenModel: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: seenModel.api,
    provider: seenModel.provider,
    model: seenModel.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamText(seenModel: Model<Api>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = message(seenModel, text);
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
  });
  return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function envGuard(): () => void {
  const oldDeadline = process.env.GSD_MOA_DEADLINE_EPOCH_MS;
  const oldBudget = process.env.GSD_MOA_BUDGET_MS;
  return () => {
    if (oldDeadline === undefined) delete process.env.GSD_MOA_DEADLINE_EPOCH_MS;
    else process.env.GSD_MOA_DEADLINE_EPOCH_MS = oldDeadline;
    if (oldBudget === undefined) delete process.env.GSD_MOA_BUDGET_MS;
    else process.env.GSD_MOA_BUDGET_MS = oldBudget;
  };
}

function cfg(): GsdMoaConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.cache.enabled = false;
  config.primary.apiKey = "primary";
  config.reference.apiKey = "reference";
  return config;
}

describe("time-aware scheduling", () => {
  it("computes undefined, deadline-only, phases, grace bands, and past-deadline reserve", () => {
    const ta = DEFAULT_CONFIG.timeAware;
    assert.equal(computeTimeState(ta, {}, 1_000), undefined);

    assert.deepEqual(computeTimeState(ta, { deadlineEpochMs: 121_000 }, 1_000), { remainingMs: 120_000, inReserve: false });
    assert.deepEqual(computeTimeState(ta, { deadlineEpochMs: 50_000 }, 1_000), { remainingMs: 49_000, inReserve: true });

    const budgetMs = 1_000_000;
    const deadlineEpochMs = 1_000_000;
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 0)?.phase, "explore");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 350_000)?.phase, "explore");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 351_000)?.phase, "implement");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 650_000)?.phase, "implement");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 651_000)?.phase, "validate");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 950_000)?.phase, "validate");
    assert.equal(computeTimeState(ta, { deadlineEpochMs, budgetMs }, 951_000)?.phase, "reserve");

    const past = computeTimeState(ta, { deadlineEpochMs: 1_000, budgetMs }, 2_000);
    assert.equal(past?.remainingMs, 0);
    assert.equal(past?.inReserve, true);
  });

  it("suppresses non-explicit checkpoints in reserve, downgrades drift in validate, and honors explicit markers", () => {
    const reserveTimeState = { remainingMs: 1_000, budgetMs: 100_000, elapsedMs: 99_000, phase: "reserve" as const, inReserve: true };
    const baseContext: Context = {
      messages: [
        { role: "user", content: "fix tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "c1", content: [{ type: "text", text: "AssertionError" }], isError: true, timestamp: 2 } as any,
      ],
    };
    const input = {
      alias: "gpt55-glm52-full",
      latestUserText: latestUserText(baseContext, true),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(baseContext),
      timeState: reserveTimeState,
    };
    assert.deepEqual(chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, input), input), { kind: "single", reason: "time reserve: 1s remaining" });

    const validateContext: Context = {
      messages: [
        { role: "user", content: "continue", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "c1", content: [{ type: "text", text: "done" }], timestamp: 2 } as any,
        { role: "toolResult", toolName: "Bash", toolCallId: "c2", content: [{ type: "text", text: "done" }], timestamp: 3 } as any,
        { role: "toolResult", toolName: "Bash", toolCallId: "c3", content: [{ type: "text", text: "done" }], timestamp: 4 } as any,
      ],
    };
    const validateInput = {
      alias: "gpt55-glm52-full",
      latestUserText: latestUserText(validateContext, true),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(validateContext),
      timeState: { remainingMs: 300_000, budgetMs: 1_000_000, elapsedMs: 700_000, phase: "validate" as const, inReserve: false },
    };
    const validateAction = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, validateInput), validateInput);
    assert.equal(validateAction.kind, "run");
    if (validateAction.kind === "run") assert.equal(validateAction.mode, "advisor");

    const explicitContext: Context = {
      messages: [
        { role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "c1", content: [{ type: "text", text: "AssertionError" }], isError: true, timestamp: 2 } as any,
      ],
    };
    const explicitInput = { ...input, latestUserText: latestUserText(explicitContext, true), hasFreshMoaMarker: true, recentToolSummary: buildToolObservationSummary(explicitContext) };
    const explicitAction = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, explicitInput), explicitInput);
    assert.equal(explicitAction.kind, "run");
    if (explicitAction.kind === "run") assert.equal(explicitAction.mode, "full_moa");
  });

  it("adds time notes, reference prompt lines, and diagnostics only when env supplies a deadline", async () => {
    const restore = envGuard();
    try {
      delete process.env.GSD_MOA_DEADLINE_EPOCH_MS;
      delete process.env.GSD_MOA_BUDGET_MS;
      let sawTimeNote = false;
      const noEnvUpstream: UpstreamClient = {
        async complete() { throw new Error("not used"); },
        stream(seenModel, seenContext) {
          sawTimeNote = JSON.stringify(seenContext.messages).includes("Time budget");
          return streamText(seenModel, "ok");
        },
      };
      const noEnvEvents = await collect(streamGsdMoa(model("gpt55-glm52-single"), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, undefined, { config: cfg(), upstream: noEnvUpstream }));
      assert.equal(sawTimeNote, false);
      const noEnvDetails = (noEnvEvents.at(-1) as any).message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
      assert.equal(noEnvDetails.timeAware, undefined);

      process.env.GSD_MOA_DEADLINE_EPOCH_MS = String(Date.now() + 600_000);
      process.env.GSD_MOA_BUDGET_MS = String(1_000_000);
      let finalContextText = "";
      let referencePrompt = "";
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          referencePrompt = seenContext.systemPrompt ?? "";
          return message(seenModel, "advice");
        },
        stream(seenModel, seenContext) {
          finalContextText = JSON.stringify(seenContext.messages);
          return streamText(seenModel, "ok");
        },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), { messages: [{ role: "user", content: "please review", timestamp: 1 }] }, undefined, { config: cfg(), upstream }));
      assert.match(finalContextText, /Time budget/);
      assert.match(finalContextText, /Strategy:/);
      assert.match(referencePrompt, /keep advice proportionate to the remaining budget/);
      const details = (events.at(-1) as any).message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
      assert.ok(details.timeAware.remainingMs > 0);
      assert.equal(details.timeAware.phase, "implement");

      const built = buildAdvisorContext(cfg(), { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { requestedMode: "advisor", mode: "advisor", reason: "test", strippedText: "x", markers: [] }, undefined, { remainingMs: 60_000, phase: "validate", inReserve: false });
      assert.match(built.systemPrompt ?? "", /phase=validate/);
    } finally {
      restore();
    }
  });
});

describe("time-aware env override", () => {
  it("GSD_MOA_TIME_AWARE=0 disables time-aware via loadConfig even when budget env vars are set", async () => {
    const { loadConfig, resetConfigCache } = await import("../src/config.ts");
    const prev = process.env.GSD_MOA_TIME_AWARE;
    process.env.GSD_MOA_TIME_AWARE = "0";
    try {
      resetConfigCache();
      const cfg = loadConfig("nonexistent-gsd-moa-config.json");
      assert.equal(cfg.timeAware.enabled, false);
    } finally {
      if (prev === undefined) delete process.env.GSD_MOA_TIME_AWARE;
      else process.env.GSD_MOA_TIME_AWARE = prev;
      resetConfigCache();
    }
  });
});
