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
} from "../src/pi-compat.js";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FullMoaError, runFullMoa } from "../src/moa.ts";
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

  it("continues full MoA with visible redacted failure notes when one selected proposer fails", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      let synthesisInput = "";
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          if (seenModel.provider === "zai") throw new Error("glm unavailable Authorization: Bearer sk-reference-fail1234567890");
          if ((seenContext.systemPrompt ?? "").includes("private synthesizer layer")) {
            synthesisInput = JSON.stringify(seenContext.messages);
            return message(seenModel, "synthesis", usage(1, 1));
          }
          return message(seenModel, "gpt reference", usage(1, 1));
        },
        stream(seenModel, seenContext) {
          const finalMessages = JSON.stringify(seenContext.messages);
          assert.match(finalMessages, /gpt reference/);
          assert.match(finalMessages, /Reference 2: GLM-5\.2 reference — \[failed: glm unavailable Authorization: \[REDACTED_AUTH\]\]/);
          assert.doesNotMatch(finalMessages, /sk-reference-fail/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.match(synthesisInput, /Reference 2: GLM-5\.2 reference — \[failed: glm unavailable Authorization: \[REDACTED_AUTH\]\]/);
      assert.doesNotMatch(synthesisInput, /sk-reference-fail/);
      assert.equal(done.message.usage.totalTokens, 6, "failed proposer usage is excluded from combined usage");
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.guidanceInjected, true);
      assert.match(details.portfolio.find((p: any) => p.id === "glm52")?.reason, /failed: glm unavailable Authorization: \[REDACTED_AUTH\]/);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
      const failedCall = details.innerCalls.find((call: any) => call.role === "proposer" && call.provider === "zai");
      assert.equal(failedCall.usage, undefined);
      assert.match(failedCall.error, /glm unavailable Authorization: \[REDACTED_AUTH\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops aborted proposer output and retains failure latency in diagnostics", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          if (seenModel.provider === "zai") return { ...message(seenModel, "partial aborted advice", usage(1, 1)), stopReason: "aborted" as any };
          if ((seenContext.systemPrompt ?? "").includes("private synthesizer layer")) {
            assert.doesNotMatch(JSON.stringify(seenContext.messages), /partial aborted advice/);
            assert.match(JSON.stringify(seenContext.messages), /\[failed: timed out after 120s \(partial output discarded\)\]/);
            return message(seenModel, "synthesis", usage(1, 1));
          }
          return message(seenModel, "complete advice", usage(1, 1));
        },
        stream(seenModel, seenContext) {
          const finalMessages = JSON.stringify(seenContext.messages);
          assert.match(finalMessages, /complete advice/);
          assert.match(finalMessages, /\[failed: timed out after 120s \(partial output discarded\)\]/);
          assert.doesNotMatch(finalMessages, /partial aborted advice/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(done.message.usage.totalTokens, 8);
      assert.equal(details.referenceFailures[0].provider, "zai");
      assert.equal(typeof details.referenceFailures[0].durationMs, "number");
      const failedCall = details.innerCalls.find((call: any) => call.role === "proposer" && call.provider === "zai");
      assert.equal(failedCall.usage.totalTokens, 2);
      assert.match(failedCall.error, /timed out after 120s/);
      assert.match(details.portfolio.find((p: any) => p.id === "glm52")?.reason, /failed: timed out after 120s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps substantial length-stopped advice with a marker and drops tiny token-limit fragments", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.fullMoa.synthesis.enabled = false;
    try {
      const longAdvice = "a".repeat(500);
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          if (seenModel.provider === "zai") return { ...message(seenModel, longAdvice, usage(1, 1)), stopReason: "length" as any };
          return { ...message(seenModel, "tiny fragment", usage(1, 1)), stopReason: "length" as any };
        },
        stream(seenModel, seenContext) {
          const finalMessages = JSON.stringify(seenContext.messages);
          assert.match(finalMessages, /advisory truncated at token limit/);
          assert.match(finalMessages, new RegExp(longAdvice));
          assert.match(finalMessages, /\[failed: hit token limit\]/);
          assert.doesNotMatch(finalMessages, /tiny fragment/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(done.message.usage.totalTokens, 6);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
      assert.equal(details.referenceFailures[0].message, "hit token limit");
      assert.equal(details.referenceFailures[0].usage.totalTokens, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates and runs a single-proposer full MoA pool", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.fullMoa.proposers = [cfg.fullMoa.proposers[0]!];
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      let completeCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          completeCalls++;
          if ((seenContext.systemPrompt ?? "").includes("private synthesizer layer")) return message(seenModel, "synthesis", usage(1, 1));
          return message(seenModel, "only glm advice", usage(1, 1));
        },
        stream(seenModel, seenContext) {
          assert.match(JSON.stringify(seenContext.messages), /only glm advice/);
          assert.match(JSON.stringify(seenContext.messages), /Synthesis \/ execution memo/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.equal(completeCalls, 2);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 1);
      assert.equal(details.innerCalls.some((call: any) => call.role === "synthesizer"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps proposer output with global and per-proposer referenceMaxTokens but leaves synthesis and final uncapped", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.referenceMaxTokens = 600;
    cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55")!.maxTokens = 123;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const seen: Record<string, unknown> = {};
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext, seenOptions) {
          if ((seenContext.systemPrompt ?? "").includes("private synthesizer layer")) {
            seen.synthesis = seenOptions?.maxTokens;
            return message(seenModel, "synthesis", usage(1, 1));
          }
          seen[seenModel.provider === "zai" ? "glm" : "gpt"] = seenOptions?.maxTokens;
          return message(seenModel, "proposal", usage(1, 1));
        },
        stream(seenModel, seenContext, seenOptions) {
          seen.primary = seenOptions?.maxTokens;
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      assert.deepEqual(seen, { glm: 600, gpt: 123, synthesis: undefined, primary: undefined });
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
      const failedSynthesis = details.innerCalls.find((call: any) => call.role === "synthesizer");
      assert.ok(failedSynthesis);
      assert.equal(failedSynthesis.error, "synthesis down");
      assert.equal(details.synthesisFailedReason, "synthesis down");
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

      await assert.rejects(
        runFullMoa(cfg, context, {
          requestedMode: "full_moa",
          mode: "full_moa",
          reason: "test",
          strippedText: "deep review",
          markers: ["<!-- gsd-moa:full -->"],
        }, upstream),
        (error: unknown) => {
          assert.ok(error instanceof FullMoaError);
          assert.match(error.message, /all full_moa proposers failed/);
          assert.equal(error.result.proposals.length, 0);
          assert.equal(error.result.innerCalls.length, 2);
          assert.equal(error.result.usage?.totalTokens ?? 0, 0);
          return true;
        },
      );

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.equal(primaryCalls, 1);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "single");
      assert.equal(details.guidanceInjected, false);
      assert.equal(details.cacheHit, false);
      assert.match(details.guidanceSkippedReason, /full_moa failed:/);
      const failedReferences = details.innerCalls.filter((call: any) => call.role === "proposer");
      assert.equal(failedReferences.length, 2);
      assert.ok(failedReferences.every((call: any) => call.error === "reference outage"));
      assert.equal(details.referenceFailures.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back to the primary when caller cancellation aborts synthesis", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const controller = new AbortController();
      let completeCalls = 0;
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeCalls += 1;
          if (completeCalls === 3) {
            controller.abort(new Error("cancelled synthesis"));
            throw new Error("cancelled synthesis");
          }
          return message(seenModel, `proposal-${completeCalls}`, usage(1, 1));
        },
        stream(seenModel) {
          primaryCalls += 1;
          return streamText(seenModel, "should not run", usage(1, 1));
        },
      };
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, { signal: controller.signal }, { config: cfg, upstream }));
      const error = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
      assert.equal(error.type, "error");
      assert.equal(error.reason, "aborted");
      assert.equal(primaryCalls, 0);
      assert.equal(error.error.usage.totalTokens, 4);
      const details = error.error.diagnostics?.find((item) => item.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back to the primary after caller cancellation aborts all proposers", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const controller = new AbortController();
      let completeCalls = 0;
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          completeCalls += 1;
          if (completeCalls === 2) controller.abort(new Error("cancelled"));
          return { ...message(seenModel, "", usage(1, 1)), stopReason: "aborted", errorMessage: "cancelled" };
        },
        stream(seenModel) {
          primaryCalls += 1;
          return streamText(seenModel, "should not run", usage(1, 1));
        },
      };
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, { signal: controller.signal }, { config: cfg, upstream }));
      const error = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
      assert.equal(error.type, "error");
      assert.equal(error.reason, "aborted");
      assert.equal(primaryCalls, 0);
      assert.equal(error.error.usage.totalTokens, 4);
      const details = error.error.diagnostics?.find((item) => item.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls.filter((call: any) => call.role === "proposer").length, 2);
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

  it("runs rescue advisor with compact observations after repeated failed tool results", async () => {
    const { cfg, dir } = tempConfig();
    try {
      const context: Context = {
        messages: [
          { role: "user", content: "<!-- gsd-moa:full --> fix the failing test", timestamp: 1 },
          { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "npm test exited with status 1\nAssertionError: expected 2 actual 3\nsrc/example.test.ts" }], isError: true, timestamp: 2 } as any,
          { role: "toolResult", toolName: "Bash", toolCallId: "call-2", content: [{ type: "text", text: "npm test exited with status 1\nAssertionError: expected 2 actual 3\nsrc/example.test.ts" }], isError: true, timestamp: 3 } as any,
          { role: "toolResult", toolName: "Bash", toolCallId: "call-3", content: [{ type: "text", text: "npm test exited with status 1\nAssertionError: expected 2 actual 3\nsrc/example.test.ts" }], isError: true, timestamp: 4 } as any,
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
          assert.match(JSON.stringify(seenContext.messages), /gsd-moa advisor guidance/);
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      assert.equal(referenceContexts.length, 1);
      assert.ok(referenceContexts.every((seenContext) => JSON.stringify(seenContext.messages).includes("Recent tool observations:")));
      assert.ok(referenceContexts.every((seenContext) => JSON.stringify(seenContext.messages).includes("AssertionError")));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "advisor");
      assert.equal(details.checkpointScope, "failure");
      assert.match(details.reason, /MoA rescue: 3 consecutive failures/);
      assert.equal(details.guidanceInjected, true);
      assert.equal(details.observationToolResultCount, 3);
      assert.equal(details.rescueTrailingFailureStreak, 3);
      assert.ok(details.rescueSignature.includes("Bash|"));
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
      const proposerCalls = details.innerCalls.filter((call: any) => call.role === "proposer");
      assert.equal(proposerCalls.length, 2);
      assert.ok(proposerCalls.every((call: any) => typeof call.durationMs === "number" && call.durationMs >= 0));
      assert.equal(details.innerCalls.filter((call: any) => call.role === "synthesizer").length, 1);
      assert.equal(details.innerCalls.filter((call: any) => call.role === "primary").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
