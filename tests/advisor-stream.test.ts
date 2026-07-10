import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { applyModelPreset } from "../src/presets.ts";
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
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.primary.apiKey = "test-primary-key";
  cfg.reference.apiKey = "test-reference-key";
  for (const preset of Object.values(cfg.routePresets)) preset.apiKey = "test-preset-key";
  return { cfg: { ...cfg, cache: { enabled: true, dir, ttlSeconds: 60 } }, dir };
}

describe("advisor orchestration", () => {
  it("records explicit none effort while omitting reasoning from upstream options", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.defaultEffort = "none";
    cfg.trace = { enabled: true, dir: join(dir, "traces"), includeContexts: false, includeOutputs: false };
    try {
      const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete() {
          throw new Error("unexpected reference call");
        },
        stream(seenModel, _seenContext, seenOptions) {
          assert.equal(seenModel.provider, "factory-codex");
          assert.equal(seenOptions?.reasoning, undefined);
          assert.equal((seenOptions as any)?.omitReasoningEffort, true);
          return streamText(seenModel, "final", usage(1, 2));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-single"), context, { reasoning: "high" as never }, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.deepEqual(details.innerCalls.map((call: any) => [call.role, call.effort]), [["primary", "none"]]);
      const trace = JSON.parse(readFileSync(details.tracePath, "utf8"));
      assert.equal(trace.primaryCall.effort, "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
        async complete(seenModel, seenContext, seenOptions) {
          advisorCalls++;
          assert.equal(seenModel.provider, "zai");
          assert.equal(seenModel.id, "glm-5.2");
          assert.equal(seenContext.tools, undefined);
          assert.match(seenContext.systemPrompt ?? "", /private advisor/i);
          assert.ok(seenOptions?.signal instanceof AbortSignal);
          assert.equal(seenOptions?.reasoning, "high");
          return message(seenModel, "Check tests and edge cases.", usage(10, 20));
        },
        stream(seenModel, seenContext, seenOptions) {
          primaryCalls++;
          assert.equal(seenOptions?.reasoning, "high");
          assert.equal(seenModel.provider, "factory-codex");
          assert.equal(seenContext.tools?.[0]?.name, "Bash");
          assert.doesNotMatch(seenContext.systemPrompt ?? "", /Check tests and edge cases/);
          assert.match(JSON.stringify(seenContext.messages), /Check tests and edge cases/);
          assert.match(JSON.stringify(seenContext.messages), /gsd-moa advisor guidance/);
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
      assert.deepEqual(details.innerCalls.map((call: any) => [call.role, call.effort]), [["reference", "high"], ["primary", "high"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps advisor reference output with referenceMaxTokens while leaving final output uncapped", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.referenceMaxTokens = 321;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const seen: Record<string, unknown> = {};
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext, seenOptions) {
          seen.reference = seenOptions?.maxTokens;
          return message(seenModel, "advice", usage(1, 1));
        },
        stream(seenModel, seenContext, seenOptions) {
          seen.primary = seenOptions?.maxTokens;
          return streamText(seenModel, "final", usage(1, 1));
        },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      assert.deepEqual(seen, { reference: 321, primary: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to a primary-only call when advisor fails", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review this plan", timestamp: 1 }] };
      let primaryCalls = 0;
      const upstream: UpstreamClient = {
        async complete() { throw new Error("advisor offline Authorization: Bearer sk-advisor-secret1234567890"); },
        stream(seenModel, seenContext) {
          primaryCalls++;
          assert.equal(seenModel.provider, "factory-codex");
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /gsd-moa advisor guidance/);
          return streamText(seenModel, "final", usage(1, 2));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.type, "done");
      assert.equal(primaryCalls, 1);
      assert.equal(done.message.usage.totalTokens, 3);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.mode, "single");
      assert.equal(details.guidanceInjected, false);
      assert.match(details.guidanceSkippedReason, /advisor failed: advisor offline/);
      assert.match(details.guidanceSkippedReason, /REDACTED/);
      assert.doesNotMatch(details.guidanceSkippedReason, /sk-advisor-secret/);
      assert.equal(details.innerCalls.length, 2);
      assert.equal(details.innerCalls[0].role, "reference");
      assert.match(details.innerCalls[0].error, /REDACTED/);
      assert.equal(details.innerCalls[1].role, "primary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats terminal provider error messages as failed advisor calls", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          return { ...message(seenModel, "", usage(4, 5)), stopReason: "error", errorMessage: "provider failed" };
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 2)); },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.message.usage.totalTokens, 12);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls[0].role, "reference");
      assert.equal(details.innerCalls[0].error, "provider failed");
      assert.equal(details.guidanceInjected, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves failed advisor usage when cancellation propagates", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    const controller = new AbortController();
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          controller.abort(new Error("cancelled advisor"));
          return { ...message(seenModel, "", usage(4, 5)), stopReason: "aborted" };
        },
        stream() { throw new Error("stream must not run"); },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { signal: controller.signal }, { config: cfg, upstream }));
      const failed = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
      assert.equal(failed.reason, "aborted");
      assert.equal(failed.error.usage.totalTokens, 9);
      const details = failed.error.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls[0].role, "reference");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves advisor telemetry when the primary iterator throws", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "advice", usage(4, 5)); },
        stream() {
          return (async function* () { throw new Error("iterator failed"); })() as unknown as AssistantMessageEventStream;
        },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const failed = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
      assert.equal(failed.error.usage.totalTokens, 9);
      const details = failed.error.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls[0].role, "reference");
      assert.equal(details.guidanceInjected, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves advisor telemetry when primary route setup fails", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.primary.apiKey = "$GSD_MOA_TEST_MISSING_PRIMARY_KEY";
    delete process.env.GSD_MOA_TEST_MISSING_PRIMARY_KEY;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "advice", usage(4, 5)); },
        stream() { throw new Error("stream must not be reached"); },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const failed = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
      assert.equal(failed.error.usage.totalTokens, 9);
      const details = failed.error.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.innerCalls[0].role, "reference");
      assert.equal(details.innerCalls.some((call: any) => call.role === "primary"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accounts for failed advisor usage and diagnostics", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          return { ...message(seenModel, "too short", usage(4, 5)), stopReason: "length" };
        },
        stream(seenModel) {
          return streamText(seenModel, "final", usage(1, 2));
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.message.usage.totalTokens, 12);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      const failedReference = details.innerCalls.find((call: any) => call.role === "reference");
      assert.ok(failedReference);
      assert.equal(failedReference.error, "hit token limit");
      assert.equal(failedReference.usage.totalTokens, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a user message after old tool results as a fresh advisor turn", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    try {
      const context: Context = {
        messages: [
          { role: "user", content: "fix tests", timestamp: 1 },
          { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "Error: old failure" }], isError: true, timestamp: 2 } as any,
          { role: "user", content: "please review this new plan", timestamp: 3 },
        ],
      };
      let advisorCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          advisorCalls++;
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /old failure/);
          return message(seenModel, "fresh advice", usage(2, 3));
        },
        stream(seenModel, seenContext) {
          assert.match(JSON.stringify(seenContext.messages), /fresh advice/);
          return streamText(seenModel, "final", usage(1, 2));
        },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(advisorCalls, 1);
      assert.equal(details.mode, "advisor");
      assert.equal(details.checkpointScope, "initial");
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
      const oldMissingKey = process.env.MISSING_REFERENCE_CACHE_KEY;
      let events: AssistantMessageEvent[];
      try {
        delete process.env.MISSING_REFERENCE_CACHE_KEY;
        cfg.reference.apiKey = "$MISSING_REFERENCE_CACHE_KEY";
        events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      } finally {
        if (oldMissingKey === undefined) delete process.env.MISSING_REFERENCE_CACHE_KEY;
        else process.env.MISSING_REFERENCE_CACHE_KEY = oldMissingKey;
      }
      const done = events!.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(advisorCalls, 1);
      assert.equal(done.message.usage.totalTokens, 3);
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.cacheHit, true);
      assert.equal(details.innerCalls.length, 2);
      assert.equal(details.innerCalls[0].cacheHit, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("separates advisor cache entries by effective caller temperature", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = true;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      let referenceCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel) {
          referenceCalls += 1;
          return message(seenModel, `advice-${referenceCalls}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200 }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.2, maxTokens: 200 }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 2000 }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, topP: 0.8 }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200 }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, sessionId: "session-a" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, sessionId: "session-b" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, sessionId: "session-a" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, openrouterVariant: "online" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, openrouterVariant: "exacto" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, openrouterVariant: "online" }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, disableReasoning: true, reasoning: "high" as never }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { temperature: 0.1, maxTokens: 200, disableReasoning: true, reasoning: "low" as never }, { config: cfg, upstream }));
      assert.equal(referenceCalls, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bypasses payload transforms and custom transports while stripping provider session state", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = true;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      let referenceCalls = 0;
      let stateControlsSeen = false;
      const upstream: UpstreamClient = {
        async complete(seenModel, _context, seenOptions) {
          referenceCalls += 1;
          assert.equal(seenOptions?.providerSessionState, undefined);
          if (seenOptions?.useInteractionsApi === false) {
            assert.equal(seenOptions.storeInteraction, false);
            stateControlsSeen = true;
          }
          return message(seenModel, `advice-${referenceCalls}`, usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };
      const firstTransform = (payload: unknown) => payload;
      const secondTransform = (payload: unknown) => ({ payload });
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { onPayload: firstTransform }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { onPayload: secondTransform }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { onPayload: firstTransform }, { config: cfg, upstream }));
      const providerSessionState = new Map();
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { providerSessionState, useInteractionsApi: false, storeInteraction: false }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { providerSessionState, useInteractionsApi: false, storeInteraction: false }, { config: cfg, upstream }));
      const customFetch = (async () => new Response()) as typeof fetch;
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { fetch: customFetch }, { config: cfg, upstream }));
      await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, { fetch: customFetch }, { config: cfg, upstream }));
      assert.equal(referenceCalls, 6);
      assert.equal(stateControlsSeen, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps completed advisor output and usage when cache persistence fails", async () => {
    const { cfg, dir } = tempConfig();
    const blocker = join(dir, "cache-blocker");
    writeFileSync(blocker, "not a directory");
    cfg.cache.dir = blocker;
    try {
      const context: Context = { messages: [{ role: "user", content: "please review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "advice", usage(4, 5)); },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 2)); },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-advisor"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      assert.equal(done.message.usage.totalTokens, 12);
      const details = done.message.diagnostics?.find((item) => item.type === "gsd-moa.details")?.details as any;
      assert.equal(details.guidanceInjected, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves image blocks for image-capable Gemini advisor", async () => {
    const { cfg: baseCfg, dir } = tempConfig();
    const cfg = applyModelPreset(baseCfg, "gpt55-gemini35flash-advisor");
    try {
      const context: Context = {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "<!-- gsd-moa:advisor --> analyze this screenshot" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as any,
          ],
          timestamp: 1,
        }],
      };
      let advisorSawImage = false;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          assert.equal(seenModel.provider, "antigravity");
          advisorSawImage = JSON.stringify(seenContext.messages).includes('"type":"image"');
          return message(seenModel, "image advice", usage(1, 1));
        },
        stream(seenModel) { return streamText(seenModel, "final", usage(1, 1)); },
      };

      await collect(streamGsdMoa(model("gpt55-gemini35flash-advisor"), context, undefined, { config: cfg, upstream }));
      assert.equal(advisorSawImage, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects the M3 strategy contract without a reference call", async () => {
    const { cfg, dir } = tempConfig();
    cfg.aliases["typed-test"] = { mode: "auto", typedCheckpoints: true, checkpointScopes: { initial: false, drift: false, failure: true } };
    try {
      const quotedStrategy = "[GSD typed strategy checkpoint from provider] Before modifying files: identify the concrete success condition and the first available verifier or executable check. Then implement with tools, run that check after the final mutation, and treat any later mutation as invalidating earlier verification.";
      const context: Context = { messages: [{ role: "user", content: `fix the task; quoted documentation: ${quotedStrategy}`, timestamp: 101 }] };
      const upstream: UpstreamClient = {
        async complete() { throw new Error("unexpected reference call"); },
        stream(seenModel, seenContext) {
          const serialized = JSON.stringify(seenContext.messages);
          assert.equal(serialized.match(/GSD typed strategy checkpoint/g)?.length, 2);
          return streamText(seenModel, "final");
        },
      };
      const events = await collect(streamGsdMoa(model("typed-test"), context, { sessionId: "typed-strategy" }, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.typedCheckpoint.type, "strategy");
      assert.equal(details.typedCheckpoint.mode, "deterministic-note");
      assert.equal(details.innerCalls.filter((call: any) => call.role === "reference").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume the strategy cap when primary stream setup fails", async () => {
    const { cfg, dir } = tempConfig();
    cfg.aliases["typed-strategy-retry"] = { mode: "auto", typedCheckpoints: true };
    const context: Context = { messages: [{ role: "user", content: "retry strategy delivery", timestamp: 131 }] };
    try {
      const failing: UpstreamClient = {
        async complete() { throw new Error("unexpected reference call"); },
        stream() { throw new Error("route setup failed"); },
      };
      const failedEvents = await collect(streamGsdMoa(model("typed-strategy-retry"), context, { sessionId: "typed-strategy-retry-session" }, { config: cfg, upstream: failing }));
      assert.equal(failedEvents.at(-1)?.type, "error");
      const succeeding: UpstreamClient = {
        async complete() { throw new Error("unexpected reference call"); },
        stream(seenModel, seenContext) {
          assert.match(JSON.stringify(seenContext.messages), /GSD typed strategy checkpoint/);
          return streamText(seenModel, "final");
        },
      };
      const events = await collect(streamGsdMoa(model("typed-strategy-retry"), context, { sessionId: "typed-strategy-retry-session" }, { config: cfg, upstream: succeeding }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.typedCheckpoint.status, "fired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves the strategy cap across overlapping streams", async () => {
    const { cfg, dir } = tempConfig();
    cfg.aliases["typed-strategy-overlap"] = { mode: "auto", typedCheckpoints: true };
    const context: Context = { messages: [{ role: "user", content: "overlapping strategy", timestamp: 141 }] };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    try {
      const firstUpstream: UpstreamClient = {
        async complete() { throw new Error("unexpected reference call"); },
        stream(seenModel) {
          const delayed = createAssistantMessageEventStream();
          void firstGate.then(() => {
            const msg = message(seenModel, "first");
            delayed.push({ type: "start", partial: msg });
            delayed.push({ type: "text_start", contentIndex: 0, partial: msg });
            delayed.push({ type: "text_delta", contentIndex: 0, delta: "first", partial: msg });
            delayed.push({ type: "text_end", contentIndex: 0, content: "first", partial: msg });
            delayed.push({ type: "done", reason: "stop", message: msg });
            delayed.end();
          });
          return delayed;
        },
      };
      const first = collect(streamGsdMoa(model("typed-strategy-overlap"), context, { sessionId: "typed-strategy-overlap-session" }, { config: cfg, upstream: firstUpstream }));
      await new Promise((resolve) => setImmediate(resolve));
      const secondUpstream: UpstreamClient = {
        async complete() { throw new Error("unexpected reference call"); },
        stream(seenModel, seenContext) {
          assert.doesNotMatch(JSON.stringify(seenContext.messages), /GSD typed strategy checkpoint/);
          return streamText(seenModel, "second");
        },
      };
      const secondEvents = await collect(streamGsdMoa(model("typed-strategy-overlap"), context, { sessionId: "typed-strategy-overlap-session" }, { config: cfg, upstream: secondUpstream }));
      const secondDone = secondEvents.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const secondDetails = secondDone.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(secondDetails.typedCheckpoint.status, "suppressed");
      assert.match(secondDetails.typedCheckpoint.reason, /in flight/);
      releaseFirst();
      await first;
    } finally {
      releaseFirst();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the M3 strategy contract when ordinary initial advice also runs", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.aliases["typed-advisor-test"] = { mode: "advisor", typedCheckpoints: true };
    try {
      const context: Context = { messages: [{ role: "user", content: "plan and fix", timestamp: 151 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "ordinary advice"); },
        stream(seenModel, seenContext) {
          const serialized = JSON.stringify(seenContext.messages);
          assert.match(serialized, /GSD typed strategy checkpoint/);
          assert.match(serialized, /ordinary advice/);
          return streamText(seenModel, "final");
        },
      };
      const events = await collect(streamGsdMoa(model("typed-advisor-test"), context, { sessionId: "typed-advisor" }, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(details.typedCheckpoint.type, "strategy");
      assert.equal(details.guidanceInjected, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs one M3 advisor after a failed verifier", async () => {
    const { cfg, dir } = tempConfig();
    cfg.cache.enabled = false;
    cfg.aliases["typed-verify-test"] = { mode: "auto", typedCheckpoints: true, checkpointScopes: { initial: false, drift: false, failure: true } };
    try {
      const context: Context = {
        messages: [
          { role: "user", content: "fix the task", timestamp: 201 },
          { ...message(model("typed-verify-test"), ""), content: [{ type: "toolCall", id: "w1", name: "bash", arguments: { command: "echo x > src/a.ts" } }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: "w1", toolName: "bash", content: [{ type: "text", text: "created src/a.ts" }], isError: false, timestamp: 202 } as any,
          { ...message(model("typed-verify-test"), ""), content: [{ type: "toolCall", id: "v1", name: "bash", arguments: { command: "PRIVATE_KEY_B64=base64-secret AWS_ACCESS_KEY_ID=AKIAFAKE123 npm test -- --token hunter2 --password=secret-value --db-password=db-secret-value '--registry-token=quoted secret' \"--auth-token\" \"separate quoted secret\"" } }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: "v1", toolName: "bash", content: [{ type: "text", text: "ERROR: file or directory not found: hunter2" }], isError: true, timestamp: 203 } as any,
          { ...message(model("typed-verify-test"), ""), content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "other.txt" } }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "timeout" }], isError: true, timestamp: 204 } as any,
        ],
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
      };
      let referenceCalls = 0;
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          referenceCalls += 1;
          assert.equal(seenContext.tools, undefined);
          assert.match(String(seenContext.systemPrompt), /exactly four non-empty lines/);
          const referenceMessages = JSON.stringify(seenContext.messages);
          assert.match(referenceMessages, /Failed verifier command class: npm test/);
          assert.doesNotMatch(referenceMessages, /base64-secret|AKIAFAKE123|hunter2|secret-value|db-secret-value|quoted secret|separate quoted secret|timeout/);
          assert.match(referenceMessages, /error-output/);
          assert.match(referenceMessages, /src\/a.ts/);
          return message(seenModel, "Diagnosis: stale output\nNext command: npm test -- --runInBand\nExpected signal: focused failing assertion\nStop condition: the focused test passes");
        },
        stream(seenModel, seenContext) {
          assert.equal(seenContext.tools?.length, 1);
          assert.match(JSON.stringify(seenContext.messages), /stale output/);
          return streamText(seenModel, "final");
        },
      };
      const events = await collect(streamGsdMoa(model("typed-verify-test"), context, { sessionId: "typed-verify" }, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(referenceCalls, 1);
      assert.equal(details.typedCheckpoint.type, "verify_failure");
      assert.equal(details.typedCheckpoint.structuredOutputValid, true);
      assert.equal(details.guidanceInjected, true);
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
