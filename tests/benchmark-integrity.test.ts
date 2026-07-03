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
import { buildAdvisorContext } from "../src/advisor.ts";
import { buildProposerContext } from "../src/moa.ts";
import { BENCHMARK_INTEGRITY_PUBLIC_NOTE } from "../src/context.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { streamGsdMoa } from "../src/stream.ts";
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

function cfg(enabled: boolean): GsdMoaConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.cache.enabled = false;
  config.primary.apiKey = "primary";
  config.reference.apiKey = "reference";
  config.benchmarkIntegrity = enabled;
  return config;
}

function countNeedle(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("benchmark integrity provider note", () => {
  it("injects the final acting note once when enabled and omits it when disabled", async () => {
    let enabledContext = "";
    const upstream: UpstreamClient = {
      async complete() { throw new Error("not used"); },
      stream(seenModel, seenContext) {
        enabledContext = JSON.stringify(seenContext.messages);
        return streamText(seenModel, "ok");
      },
    };
    const events = await collect(streamGsdMoa(model("gpt55-glm52-single"), { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, undefined, { config: cfg(true), upstream }));
    assert.equal(countNeedle(enabledContext, BENCHMARK_INTEGRITY_PUBLIC_NOTE), 1);
    const details = (events.at(-1) as any).message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
    assert.equal(details.benchmarkIntegrity, true);

    let disabledContext = "";
    const disabledUpstream: UpstreamClient = {
      async complete() { throw new Error("not used"); },
      stream(seenModel, seenContext) {
        disabledContext = JSON.stringify(seenContext.messages);
        return streamText(seenModel, "ok");
      },
    };
    const disabledEvents = await collect(streamGsdMoa(model("gpt55-glm52-single"), { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, undefined, { config: cfg(false), upstream: disabledUpstream }));
    assert.equal(disabledContext.includes(BENCHMARK_INTEGRITY_PUBLIC_NOTE), false);
    const disabledDetails = (disabledEvents.at(-1) as any).message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
    assert.equal(disabledDetails.benchmarkIntegrity, undefined);
  });

  it("does not accumulate the fixed note across tool-loop continuations", async () => {
    let finalContext = "";
    const upstream: UpstreamClient = {
      async complete() { throw new Error("not used"); },
      stream(seenModel, seenContext) {
        finalContext = JSON.stringify(seenContext.messages);
        return streamText(seenModel, "ok");
      },
    };
    const context: Context = {
      messages: [
        { role: "user", content: `solve\n\n${BENCHMARK_INTEGRITY_PUBLIC_NOTE}`, timestamp: 1 },
        { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "done" }], timestamp: 2 } as any,
      ],
    };
    await collect(streamGsdMoa(model("gpt55-glm52-single"), context, undefined, { config: cfg(true), upstream }));
    assert.equal(countNeedle(finalContext, BENCHMARK_INTEGRITY_PUBLIC_NOTE), 1);
  });

  it("adds reference-layer one-liners only when enabled", () => {
    const policy = { requestedMode: "advisor" as const, mode: "advisor" as const, reason: "test", strippedText: "x", markers: [] };
    const context: Context = { messages: [{ role: "user", content: "x", timestamp: 1 }] };
    const enabledAdvisor = buildAdvisorContext(cfg(true), context, policy);
    assert.match(enabledAdvisor.systemPrompt ?? "", /Benchmark integrity/);
    const disabledAdvisor = buildAdvisorContext(cfg(false), context, policy);
    assert.doesNotMatch(disabledAdvisor.systemPrompt ?? "", /Benchmark integrity/);

    const proposer = cfg(true).fullMoa.proposers[0];
    const enabledProposer = buildProposerContext(cfg(true), context, { ...policy, mode: "full_moa" }, proposer);
    assert.match(enabledProposer.systemPrompt ?? "", /Benchmark integrity/);
  });
});
