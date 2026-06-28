import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input, output, cacheRead, cacheWrite, total: input + output } };
}

const cacheRead = 0;
const cacheWrite = 0;

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

function message(m: Model<Api>, text: string, thinking = "reference thinking"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }, { type: "text", text }],
    api: m.api,
    provider: m.provider,
    model: m.id,
    usage: usage(1, 2),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamError(m: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = { ...message(m, ""), stopReason: "error" as const, errorMessage: "boom" };
    stream.push({ type: "error", reason: "error", error: msg });
    stream.end();
  });
  return stream;
}

function streamWithThinking(m: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = message(m, "final text", "primary thinking");
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "thinking_start", contentIndex: 0, partial: msg });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "primary thinking", partial: msg });
    stream.push({ type: "thinking_end", contentIndex: 0, content: "primary thinking", partial: msg });
    stream.push({ type: "text_start", contentIndex: 1, partial: msg });
    stream.push({ type: "text_delta", contentIndex: 1, delta: "final text", partial: msg });
    stream.push({ type: "text_end", contentIndex: 1, content: "final text", partial: msg });
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

function tempConfig(): { cfg: GsdMoaConfig; dir: string; traceDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-moa-trace-test-"));
  const traceDir = join(dir, "traces");
  return {
    cfg: {
      ...structuredClone(DEFAULT_CONFIG),
      reference: { ...structuredClone(DEFAULT_CONFIG.reference), apiKey: "sk-secret-reference", headers: { Authorization: "Bearer secret" } },
      cache: { enabled: false, dir: join(dir, "cache"), ttlSeconds: 60 },
      trace: { enabled: true, dir: traceDir, includeContexts: true, includeOutputs: true },
    },
    dir,
    traceDir,
  };
}

describe("trace capture", () => {
  it("serializes Pi tool definitions without cloning executable functions", async () => {
    const { cfg, dir, traceDir } = tempConfig();
    try {
      const context: Context = {
        tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any, execute: () => undefined } as any],
        messages: [{ role: "user", content: "simple", timestamp: 1 }],
      };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "unused"); },
        stream(seenModel) { return streamWithThinking(seenModel); },
      };
      await collect(streamGsdMoa(model("gpt55-glm52-single"), context, undefined, { config: cfg, upstream }));
      const tracePath = join(traceDir, readdirSync(traceDir)[0]);
      const trace = JSON.parse(readFileSync(tracePath, "utf8"));
      assert.equal(trace.status, "done");
      assert.match(JSON.stringify(trace.inputContext.tools), /\[Function/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks primary provider error events as trace errors", async () => {
    const { cfg, dir, traceDir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "simple", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel) { return message(seenModel, "unused"); },
        stream(seenModel) { return streamError(seenModel); },
      };
      await collect(streamGsdMoa(model("gpt55-glm52-single"), context, undefined, { config: cfg, upstream }));
      const tracePath = join(traceDir, readdirSync(traceDir)[0]);
      const trace = JSON.parse(readFileSync(tracePath, "utf8"));
      assert.equal(trace.status, "error");
      assert.equal(trace.finalMessage.errorMessage, "boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors includeContexts=false for inner reference calls", async () => {
    const { cfg, dir, traceDir } = tempConfig();
    cfg.trace.includeContexts = false;
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          return message(seenModel, `reference for ${seenContext.systemPrompt}`, "reference hidden thinking");
        },
        stream(seenModel) { return streamWithThinking(seenModel); },
      };

      await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const tracePath = join(traceDir, readdirSync(traceDir)[0]);
      const trace = JSON.parse(readFileSync(tracePath, "utf8"));
      assert.equal(trace.inputContext, undefined);
      assert.equal(trace.finalContext, undefined);
      assert.equal(trace.referenceCalls.some((call: any) => "context" in call), false);
      assert.match(JSON.stringify(trace.referenceCalls), /reference hidden thinking/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes full MoA proposer, synthesis, primary thinking, and diagnostics traces", async () => {
    const { cfg, dir, traceDir } = tempConfig();
    try {
      const context: Context = { messages: [{ role: "user", content: "<!-- gsd-moa:full --> deep review", timestamp: 1 }] };
      const upstream: UpstreamClient = {
        async complete(seenModel, seenContext) {
          assert.equal(seenContext.tools, undefined);
          return message(seenModel, `reference for ${seenContext.systemPrompt?.split("\n")[0]}`, "reference hidden thinking");
        },
        stream(seenModel) {
          return streamWithThinking(seenModel);
        },
      };

      const events = await collect(streamGsdMoa(model("gpt55-glm52-full"), context, undefined, { config: cfg, upstream }));
      const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
      const details = done.message.diagnostics?.find((d) => d.type === "gsd-moa.details")?.details as any;
      assert.equal(typeof details.tracePath, "string");
      assert.equal(readdirSync(traceDir).length, 1);

      const trace = JSON.parse(readFileSync(details.tracePath, "utf8"));
      assert.equal(trace.status, "done");
      assert.equal(trace.policy.mode, "full_moa");
      assert.equal(trace.referenceCalls.filter((call: any) => call.role === "proposer").length, 3);
      assert.equal(trace.referenceCalls.filter((call: any) => call.role === "synthesizer").length, 1);
      assert.match(JSON.stringify(trace.referenceCalls), /reference hidden thinking/);
      assert.match(JSON.stringify(trace.primaryEvents), /primary thinking/);
      assert.match(JSON.stringify(trace.finalContext), /Independent proposals/);
      assert.match(JSON.stringify(trace.finalMessage), /final text/);
      assert.doesNotMatch(JSON.stringify(trace), /sk-secret-reference|Bearer secret/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
