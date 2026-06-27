import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { streamGsdMoa } from "../src/stream.ts";
import type { GsdMoaConfig } from "../src/types.ts";
import type { UpstreamClient } from "../src/upstream.ts";

function usage(input: number, output: number) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } };
}

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

function message(model: Model<Api>, text: string, u = usage(1, 2)): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: u,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamText(model: Model<Api>, text: string, u = usage(1, 2)): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = message(model, text, u);
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

function tempConfig(): { cfg: GsdMoaConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-moa-test-"));
  return { cfg: { ...structuredClone(DEFAULT_CONFIG), cache: { enabled: true, dir, ttlSeconds: 60 } }, dir };
}

describe("advisor orchestration", () => {
  it("runs GLM advisor without tools, then final GPT with tools and combined usage", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [{ role: "user", content: "please review this architecture", timestamp: 1 }],
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
      };
      let advisorCalls = 0;
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          advisorCalls++;
          assert.equal(seenModel.provider, "zai-coding-cn");
          assert.equal(seenModel.id, "glm-5.2");
          assert.equal(seenContext.tools, undefined);
          assert.match(seenContext.systemPrompt ?? "", /private advisor/i);
          return message(seenModel, "Check tests and edge cases.", usage(10, 20));
        },
        stream(seenModel, seenContext) {
          primaryCalls++;
          assert.equal(seenModel.provider, "openai");
          assert.equal(seenContext.tools?.[0]?.name, "Bash");
          assert.match(seenContext.systemPrompt ?? "", /Check tests and edge cases/);
          return streamText(seenModel, "final", usage(1, 2));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(advisorCalls, 1);
      assert.equal(primaryCalls, 1);
      assert.equal(done.message.usage.totalTokens, 33);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "advisor");
      assert.equal(details.cacheHit, false);
      assert.equal(details.innerCalls.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses cached advisor output and does not charge cached usage again", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "please review this plan", timestamp: 1 }] };
      let advisorCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          advisorCalls++;
          return message(seenModel, "Cached advice.", usage(10, 20));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 2)); },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(advisorCalls, 1);
      assert.equal(done.message.usage.totalTokens, 3);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.cacheHit, true);
      assert.equal(details.innerCalls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto mode chooses advisor for high-leverage review prompts", async () => {
    const { cfg, dir } = tempConfig();
    try {
      let advisorCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) { advisorCalls++; return message(seenModel, "advice", usage(1, 1)); },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };
      await collect(streamGsdMoa(model("gpt55-glm52-auto"), { messages: [{ role: "user", content: "review the security design", timestamp: 1 }] }, undefined, { config: cfg, upstream }));
      assert.equal(advisorCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
