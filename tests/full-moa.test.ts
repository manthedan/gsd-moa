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
  const dir = mkdtempSync(join(tmpdir(), "gsd-moa-full-test-"));
  return { cfg: { ...structuredClone(DEFAULT_CONFIG), cache: { enabled: true, dir, ttlSeconds: 60 } }, dir };
}

describe("full MoA orchestration", () => {
  it("honors full MoA prompt markers through the real streaming entry point", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      let completeCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          completeCalls++;
          assert.equal(seenContext.tools, undefined);
          assert.doesNotMatch(JSON.stringify(seenContext), /gsd-moa:full/);
          return message(seenModel, `reference-${completeCalls}`, usage(1, 1));
        },
        stream(seenModel, seenContext) {
          assert.equal(seenModel.provider, "factory-codex");
          assert.match(seenContext.systemPrompt ?? "", /Mixture of Agents reference context/);
          assert.match(seenContext.systemPrompt ?? "", /call tools as needed/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-single"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.equal(completeCalls, cfg.fullMoa.proposers.length + 1);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "full_moa");
      assert.equal(details.reason, "explicit full MoA marker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses reference and synthesis cache on identical repeated requests", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "deep review this architecture", timestamp: 1 }] };
      let completeCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeCalls++;
          return message(seenModel, `reference-${completeCalls}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const firstRunCalls = completeCalls;
      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(completeCalls, firstRunCalls);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.cacheHit, true);
      assert.equal(details.innerCalls.filter((call: any) => call.cacheHit === true).length, cfg.fullMoa.proposers.length + 1);

      const gptReference = cfg.fullMoa.proposers.find((p) => p.id === "gpt55");
      assert.ok(gptReference?.route);
      gptReference.route.baseUrl = "http://other-gpt-reference/v1";
      assert.ok(cfg.fullMoa.synthesis.route);
      cfg.fullMoa.synthesis.route.baseUrl = "http://other-gpt-synthesis/v1";
      await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      assert.ok(completeCalls > firstRunCalls, "route changes should not reuse stale full-MoA cache entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs multiple tool-less references, a tool-less synthesis layer, then one tool-capable primary call", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review this architecture", timestamp: 1 }],
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
      };
      const completePrompts: string[] = [];
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          assert.ok(["zai", "factory-codex"].includes(seenModel.provider));
          assert.equal(seenContext.tools, undefined);
          if ((seenContext.systemPrompt ?? "").includes("private synthesizer layer")) {
            assert.match(seenContext.systemPrompt ?? "", /private execution memo/);
            assert.match(seenContext.systemPrompt ?? "", /not a user-facing answer/);
          } else {
            assert.match(seenContext.systemPrompt ?? "", /NOT the acting agent/);
            assert.match(seenContext.systemPrompt ?? "", /private guidance handed to the final acting model/);
          }
          assert.doesNotMatch(JSON.stringify(seenContext), /gsd-moa:full/);
          completePrompts.push(seenContext.systemPrompt ?? "");
          return message(seenModel, `reference-${completePrompts.length}`, usage(10, 5));
        },
        stream(seenModel, seenContext) {
          primaryCalls++;
          assert.equal(seenModel.provider, "factory-codex");
          assert.equal(seenContext.tools?.[0]?.name, "Bash");
          assert.doesNotMatch(JSON.stringify(seenContext), /gsd-moa:full/);
          assert.match(seenContext.systemPrompt ?? "", /Mixture of Agents reference context/);
          assert.match(seenContext.systemPrompt ?? "", /Reference responses/);
          assert.match(seenContext.systemPrompt ?? "", /reference-1/);
          assert.match(seenContext.systemPrompt ?? "", /Synthesis \/ execution memo/);
          assert.match(seenContext.systemPrompt ?? "", /call tools rather than merely describing commands/);
          assert.match(JSON.stringify(seenContext.messages), /Execution note from provider/);
          return streamText(seenModel, "final", usage(1, 2));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      assert.equal(events.at(-1)?.type, "done", JSON.stringify(events.at(-1)));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(completePrompts.length, cfg.fullMoa.proposers.length + 1);
      assert.equal(primaryCalls, 1);
      assert.equal(done.message.usage.totalTokens, 48);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "full_moa");
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "synthesizer").length, 1);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "primary").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
