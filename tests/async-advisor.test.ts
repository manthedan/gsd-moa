import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "../src/pi-compat.js";
import { asyncAdvisorPendingCount, resetAsyncAdvisor } from "../src/async-advisor.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { streamGsdMoa } from "../src/stream.ts";
import type { GsdMoaConfig } from "../src/types.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function model(id = "gpt55-glm52-advisor"): Model<Api> {
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
  config.asyncAdvisor.enabled = enabled;
  config.primary.apiKey = "primary";
  config.reference.apiKey = "reference";
  return config;
}

function driftContext(): Context {
  return {
    messages: [
      { role: "user", content: "continue", timestamp: 1 },
      { role: "toolResult", toolName: "Bash", toolCallId: "c1", content: [{ type: "text", text: "done 1" }], timestamp: 2 } as any,
      { role: "toolResult", toolName: "Bash", toolCallId: "c2", content: [{ type: "text", text: "done 2" }], timestamp: 3 } as any,
      { role: "toolResult", toolName: "Bash", toolCallId: "c3", content: [{ type: "text", text: "done 3" }], timestamp: 4 } as any,
    ],
  };
}

function diagnostics(events: AssistantMessageEvent[]): any {
  return (events.at(-1) as any).message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(resetAsyncAdvisor);
afterEach(resetAsyncAdvisor);

describe("async advisor", () => {
  it("fires, reports pending, then injects settled guidance across sequential tool continuations", async () => {
    const waits = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    let completeCalls = 0;
    let primaryContexts: Context[] = [];
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        return waits[completeCalls++].promise.then(() => message(seenModel, `advice-${completeCalls}`));
      },
      stream(seenModel, seenContext) {
        primaryContexts.push(seenContext);
        return streamText(seenModel, "primary");
      },
    };

    const first = await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(true), upstream }));
    assert.equal(diagnostics(first).asyncAdvisor.status, "fired");
    assert.equal(completeCalls, 1);
    assert.doesNotMatch(JSON.stringify(primaryContexts[0].messages), /gsd-moa advisor guidance/);

    const second = await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(true), upstream }));
    assert.equal(diagnostics(second).asyncAdvisor.status, "pending");
    assert.equal(completeCalls, 1);

    waits[0].resolve(message(model("zai"), "ready"));
    await new Promise((resolve) => setImmediate(resolve));

    const third = await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(true), upstream }));
    assert.equal(diagnostics(third).asyncAdvisor.status, "injected");
    assert.equal(completeCalls, 2);
    assert.match(JSON.stringify(primaryContexts[2].messages), /advice-1/);
    assert.match(JSON.stringify(primaryContexts[2].messages), /gsd-moa advisor guidance/);
  });

  it("surfaces a failed background advisor once, clears it, and fires a fresh run", async () => {
    const waits = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    let completeCalls = 0;
    const upstream: UpstreamClient = {
      async complete() {
        return waits[completeCalls++].promise;
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(true), upstream }));
    waits[0].reject(new Error("advisor broke Authorization: Bearer sk-secret1234567890"));
    await new Promise((resolve) => setImmediate(resolve));

    const events = await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(true), upstream }));
    const details = diagnostics(events);
    assert.equal(details.asyncAdvisor.status, "failed");
    assert.match(details.asyncAdvisor.error, /advisor broke/);
    assert.match(details.asyncAdvisor.error, /REDACTED/);
    assert.equal(completeCalls, 2);
  });

  it("keeps the synchronous advisor path by default and leaves no async store entry", async () => {
    let completeCalls = 0;
    let primaryContext = "";
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        completeCalls++;
        return message(seenModel, "sync advice");
      },
      stream(seenModel, seenContext) {
        primaryContext = JSON.stringify(seenContext.messages);
        return streamText(seenModel, "primary");
      },
    };

    const events = await collect(streamGsdMoa(model(), driftContext(), undefined, { config: cfg(false), upstream }));
    assert.equal(completeCalls, 1);
    assert.match(primaryContext, /sync advice/);
    assert.equal(diagnostics(events).asyncAdvisor, undefined);
    assert.equal(asyncAdvisorPendingCount(), 0);
  });
});
