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
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.primary.apiKey = "test-primary-key";
  cfg.reference.apiKey = "test-reference-key";
  for (const preset of Object.values(cfg.routePresets)) preset.apiKey = "test-preset-key";
  return { cfg: { ...cfg, cache: { enabled: true, dir, ttlSeconds: 60 } }, dir };
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
          assert.doesNotMatch(seenContext.systemPrompt ?? "", /Mixture of Agents reference context/);
          assert.match(JSON.stringify(seenContext.messages), /Mixture of Agents reference context/);
          assert.match(JSON.stringify(seenContext.messages), /call tools as needed/);
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

  it("skips conditional Gemini specialists for routine coding prompts", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> review this TypeScript module", timestamp: 1 }] };
      const completeProviders: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeProviders.push(seenModel.provider);
          return message(seenModel, `reference-${completeProviders.length}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      const events = await collect(streamGsdMoa(model("gpt55-gemini35flash-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.deepEqual(completeProviders, ["zai", "factory-codex", "factory-codex"]);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.portfolio.find((p: any) => p.id === "gemini35flash")?.selected, false);
      assert.equal(details.portfolio.find((p: any) => p.id === "claude46")?.selected, false);
      assert.equal(details.portfolio.find((p: any) => p.id === "claude46")?.reason, "disabled");
      assert.equal(details.innerCalls.some((call: any) => call.provider === "antigravity"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not select Gemini on OCR substrings inside unrelated words", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> review the democracy-related data model", timestamp: 1 }] };
      const completeProviders: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeProviders.push(seenModel.provider);
          return message(seenModel, `reference-${completeProviders.length}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      const events = await collect(streamGsdMoa(model("gpt55-gemini35flash-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.deepEqual(completeProviders, ["zai", "factory-codex", "factory-codex"]);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.portfolio.find((p: any) => p.id === "gemini35flash")?.selected, false);
      assert.equal(details.portfolio.find((p: any) => p.id === "gemini35flash")?.reason, "conditional predicates did not match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves image blocks for selected image-capable specialists", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "<!-- gsd-moa:full --> analyze this screenshot" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as any,
          ],
          timestamp: 1,
        }],
      };
      let geminiSawImage = false;
      const textOnlyProvidersWithImage: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          const sawImage = JSON.stringify(seenContext.messages).includes('"type":"image"');
          if (seenModel.provider === "antigravity") geminiSawImage = sawImage;
          if (!seenModel.input.includes("image") && sawImage) textOnlyProvidersWithImage.push(seenModel.provider);
          return message(seenModel, "reference", usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      await collect(streamGsdMoa(model("gpt55-gemini35flash-full"), context, undefined, { config: cfg, upstream }));
      assert.equal(geminiSawImage, true);
      assert.deepEqual(textOnlyProvidersWithImage, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes conditional Gemini specialists for multimodal prompts", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> transcribe this YouTube video and extract terminal moves", timestamp: 1 }] };
      const completeProviders: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          completeProviders.push(seenModel.provider);
          if (seenModel.provider === "antigravity") {
            assert.match(seenContext.systemPrompt ?? "", /Portfolio selection: keyword: youtube|Portfolio selection: capability: video/i);
          }
          return message(seenModel, `reference-${completeProviders.length}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      const events = await collect(streamGsdMoa(model("gpt55-gemini35flash-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.deepEqual(completeProviders, ["zai", "factory-codex", "antigravity", "factory-codex"]);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.portfolio.find((p: any) => p.id === "gemini35flash")?.selected, true);
      assert.equal(details.portfolio.find((p: any) => p.id === "claude46")?.selected, false);
      assert.equal(details.portfolio.find((p: any) => p.id === "claude46")?.reason, "disabled");
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues full MoA with successful proposers when one selected proposer fails", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          if (seenModel.provider === "zai") throw new Error("glm unavailable");
          return message(seenModel, seenModel.id === "gpt-5.5" ? "gpt reference" : "synthesis", usage(1, 1));
        },
        stream(seenModel, seenContext) {
          assert.match(JSON.stringify(seenContext.messages), /gpt reference/);
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /glm unavailable/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.guidanceInjected, true);
      assert.match(details.portfolio.find((p: any) => p.id === "glm52")?.reason, /failed: glm unavailable/);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues without synthesis when synthesis fails after successful proposals", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      let completeCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeCalls++;
          if (completeCalls === 3) throw new Error("synthesis down");
          return message(seenModel, `proposal-${completeCalls}`, usage(1, 1));
        },
        stream(seenModel, seenContext) {
          assert.match(JSON.stringify(seenContext.messages), /proposal-1/);
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /Synthesis \/ execution memo/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
      assert.equal(details.innerCalls.some((call: any) => call.role === "synthesizer"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to single primary call when all full MoA proposers fail", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete() { throw new Error("reference outage"); },
        stream(seenModel, seenContext) {
          primaryCalls++;
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /Mixture of Agents reference context/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.equal(primaryCalls, 1);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "single");
      assert.equal(details.guidanceInjected, false);
      assert.match(details.guidanceSkippedReason, /full_moa failed:/);
      assert.equal(details.innerCalls.filter((call: any) => call.role !== "primary").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scopes portfolio keywords to the latest user request instead of older history", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [
          { role: "user", content: "previously inspect demo.mp4 and moa:include=gemini35flash", timestamp: 1 },
          message(model("gpt55-gemini35flash-full"), "previous answer"),
          { role: "user", content: "<!-- gsd-moa:full --> review this TypeScript module", timestamp: 3 },
        ],
      };
      const completeProviders: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeProviders.push(seenModel.provider);
          return message(seenModel, `reference-${completeProviders.length}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      const events = await collect(streamGsdMoa(model("gpt55-gemini35flash-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.deepEqual(completeProviders, ["zai", "factory-codex", "factory-codex"]);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.portfolio.find((p: any) => p.id === "gemini35flash")?.selected, false);
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

  it("can skip reinjecting identical cached full-MoA guidance on tool-result continuations", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const initialContext: Context = {
        messages: [{ role: "user", content: "<!-- gsd-moa:full --> create a tiny file then read it back", timestamp: 1 }],
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
      };
      let completeCalls = 0;
      const primarySystemPrompts: string[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeCalls++;
          return message(seenModel, `reference-${completeCalls}`, usage(1, 1));
        },
        stream(seenModel, seenContext) {
          primarySystemPrompts.push(seenContext.systemPrompt ?? "");
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-full"), initialContext, undefined, { config: cfg, upstream }));
      assert.doesNotMatch(primarySystemPrompts[0], /Mixture of Agents reference context/);
      const firstRunCalls = completeCalls;

      const continuationContext: Context = {
        messages: [
          initialContext.messages[0],
          { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "created file" }], timestamp: 2 } as any,
        ],
        tools: initialContext.tools,
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), continuationContext, undefined, { config: cfg, upstream }));
      assert.equal(completeCalls, firstRunCalls, "ordinary continuation should not call references/synthesis again");
      assert.doesNotMatch(primarySystemPrompts[1], /Mixture of Agents reference context/);
      assert.doesNotMatch(primarySystemPrompts[1], /Reference responses/);
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "single");
      assert.equal(details.guidanceInjected, false);
      assert.match(details.guidanceSkippedReason, /tool-loop continuation without checkpoint signal/);
      assert.equal(details.innerCalls.filter((call: any) => call.role !== "primary").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reruns full MoA with compact observations after a failed tool result", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [
          { role: "user", content: "<!-- gsd-moa:full --> fix the failing test", timestamp: 1 },
          { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "npm test exited with status 1\nAssertionError: expected 2 actual 3\nsrc/example.test.ts" }], isError: true, timestamp: 2 } as any,
        ],
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
      };
      const referenceContexts: Context[] = [];
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          referenceContexts.push(seenContext);
          return message(seenModel, `reference-${referenceContexts.length}`, usage(1, 1));
        },
        stream(seenModel, seenContext) {
          assert.doesNotMatch(seenContext.systemPrompt ?? "", /Mixture of Agents reference context/);
          assert.match(JSON.stringify(seenContext.messages), /Mixture of Agents reference context/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      assert.equal(referenceContexts.length, cfg.fullMoa.proposers.length + 1);
      assert.ok(referenceContexts.every((seenContext) => JSON.stringify(seenContext.messages).includes("Recent tool observations:")));
      assert.ok(referenceContexts.every((seenContext) => JSON.stringify(seenContext.messages).includes("AssertionError")));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "full_moa");
      assert.equal(details.checkpointScope, "failure");
      assert.match(details.reason, /tool failure/);
      assert.equal(details.guidanceInjected, true);
      assert.equal(details.observationToolResultCount, 1);
      assert.ok(details.observationDigest);
      assert.ok(details.observationLatestFailureSignals.includes("tool-result-error"));
      assert.ok(details.observationFilesMentioned.includes("src/example.test.ts"));
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
          assert.doesNotMatch(seenContext.systemPrompt ?? "", /Mixture of Agents reference context/);
          assert.match(JSON.stringify(seenContext.messages), /Mixture of Agents reference context/);
          assert.match(JSON.stringify(seenContext.messages), /Reference responses/);
          assert.match(JSON.stringify(seenContext.messages), /reference-1/);
          assert.match(JSON.stringify(seenContext.messages), /Synthesis \/ execution memo/);
          assert.match(JSON.stringify(seenContext.messages), /call tools rather than merely describing commands/);
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
