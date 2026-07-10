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
import { asyncAdvisorPendingCount, asyncAdvisorUnattributedUsage, resetAsyncAdvisor } from "../src/async-advisor.ts";
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

function driftContext(timestamp = 1): Context {
  return {
    messages: [
      { role: "user", content: "continue", timestamp },
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

  it("keeps repeated prompts in separate sessions isolated", async () => {
    const waits = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    let completeCalls = 0;
    const upstream: UpstreamClient = {
      async complete() { return waits[completeCalls++].promise; },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    const first = await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "session-one" }, { config: cfg(true), upstream }));
    const second = await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "session-two" }, { config: cfg(true), upstream }));
    assert.equal(diagnostics(first).asyncAdvisor.status, "fired");
    assert.equal(diagnostics(second).asyncAdvisor.status, "fired");
    assert.equal(completeCalls, 2);
    assert.equal(asyncAdvisorPendingCount(), 2);
  });

  it("keeps task identity stable across agent-attributed compaction summaries", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "pre-compaction advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "compacted" }, { config, upstream }));
    const compacted = driftContext(99);
    Object.assign(compacted.messages[0]!, {
      content: "Another language model started to solve this problem and produced a summary of its thinking process.\n\n<summary>compaction summary</summary>",
      attribution: "agent",
    });
    const resumed = await collect(streamGsdMoa(model(), compacted, { sessionId: "compacted" }, { config, upstream }));
    assert.equal(diagnostics(resumed).asyncAdvisor.status, "injected");
  });

  it("retains compacted task identity while async state is still live", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "retained advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "retained" }, { config, upstream }));
    for (let index = 0; index < 65; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 10), { sessionId: `identity-${index}` }, { config, upstream }));
    }
    const compacted = driftContext(999);
    Object.assign(compacted.messages[0]!, {
      content: "You are resuming a prior conversation. Its earlier turns were archived to reclaim context and are reproduced under HISTORY below, oldest to newest.\n\nHISTORY\nsummary",
    });
    const resumed = await collect(streamGsdMoa(model(), compacted, { sessionId: "retained" }, { config, upstream }));
    assert.equal(diagnostics(resumed).asyncAdvisor.status, "injected");
  });

  it("keeps different tasks within one host session isolated", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "task-a advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "shared-host" }, { config, upstream }));
    const taskBContext = driftContext(99);
    Object.assign(taskBContext.messages[0]!, { attribution: "agent" });
    const taskB = await collect(streamGsdMoa(model(), taskBContext, { sessionId: "shared-host" }, { config, upstream }));
    assert.equal(diagnostics(taskB).asyncAdvisor.status, "fired");
  });

  it("keeps new tasks isolated when the host omits a session id", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "old-task advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    await collect(streamGsdMoa(model(), driftContext(1), undefined, { config, upstream }));
    const nextTask = driftContext(1);
    nextTask.messages.push(
      { role: "user", content: "a genuinely new task", timestamp: 10 },
      { role: "toolResult", toolName: "Bash", toolCallId: "n1", content: [{ type: "text", text: "done" }], timestamp: 11 } as any,
      { role: "toolResult", toolName: "Bash", toolCallId: "n2", content: [{ type: "text", text: "done" }], timestamp: 12 } as any,
      { role: "toolResult", toolName: "Bash", toolCallId: "n3", content: [{ type: "text", text: "done" }], timestamp: 13 } as any,
    );
    const next = await collect(streamGsdMoa(model(), nextTask, undefined, { config, upstream }));
    assert.equal(diagnostics(next).asyncAdvisor.status, "fired");
  });

  it("aborts the oldest background request when the pending cap is exceeded", async () => {
    let aborted = 0;
    const upstream: UpstreamClient = {
      async complete(_model, _context, options) {
        return new Promise<AssistantMessage>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    for (let index = 0; index < 65; index += 1) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), undefined, { config: cfg(true), upstream }));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncAdvisorPendingCount(), 64);
    assert.equal(aborted, 1);
  });

  it("preserves settled advice evicted by the capacity cap", async () => {
    let completeCalls = 0;
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        completeCalls += 1;
        return message(seenModel, `advice-${completeCalls}`);
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    for (let index = 0; index < 65; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), { sessionId: `settled-${index}` }, { config, upstream }));
    }
    const resumed = await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "settled-0" }, { config, upstream }));
    assert.equal(diagnostics(resumed).asyncAdvisor.status, "injected");
  });

  it("surfaces compact usage accounting when the eviction queue rolls over", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    for (let index = 0; index < 140; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), { sessionId: `rollover-${index}` }, { config, upstream }));
    }
    const unrelated = await collect(streamGsdMoa(model(), driftContext(999), { sessionId: "unrelated" }, { config, upstream }));
    assert.equal(diagnostics(unrelated).asyncAdvisor.status, "fired");
    const resumed = await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "rollover-0" }, { config, upstream }));
    const details = diagnostics(resumed);
    assert.match(details.asyncAdvisor.error, /global capacity cap/);
    assert.ok(details.innerCalls.find((call: any) => call.model === "evicted-async-advisor")?.usage?.totalTokens > 0);
  });

  it("bounds per-session rollover accounting and retains a process-level total", async () => {
    const config = cfg(true);
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    for (let index = 0; index < 220; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), { sessionId: `bounded-${index}` }, { config, upstream }));
    }
    assert.ok((asyncAdvisorUnattributedUsage()?.totalTokens ?? 0) > 0);
    const evidence = await collect(streamGsdMoa(model(), driftContext(999), { sessionId: "unattributed-evidence" }, { config, upstream }));
    assert.ok((diagnostics(evidence).unattributedAsyncUsage?.totalTokens ?? 0) > 0);
  });

  it("ignores rolled-off completions from before a reset", async () => {
    const config = cfg(true);
    const resolvers: Array<(value: AssistantMessage) => void> = [];
    let firstModel: Model<Api> | undefined;
    const upstream: UpstreamClient = {
      complete(seenModel) {
        firstModel ??= seenModel;
        return new Promise((resolve) => resolvers.push(resolve));
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };
    for (let index = 0; index < 129; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), { sessionId: `reset-${index}` }, { config, upstream }));
    }
    resetAsyncAdvisor();
    resolvers[0]?.(message(firstModel!, "late advice"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncAdvisorUnattributedUsage(), undefined);
  });

  it("does not inject expired settled advice from the eviction queue", async () => {
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 1;
    const upstream: UpstreamClient = {
      async complete(seenModel) { return message(seenModel, "old advice"); },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    for (let index = 0; index < 65; index++) {
      await collect(streamGsdMoa(model(), driftContext(index + 1), { sessionId: `stale-cap-${index}` }, { config, upstream }));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = await collect(streamGsdMoa(model(), driftContext(1), { sessionId: "stale-cap-0" }, { config, upstream }));
    assert.equal(diagnostics(resumed).asyncAdvisor.status, "failed");
    assert.match(diagnostics(resumed).asyncAdvisor.error, /expired/);
  });

  it("sweeps in-flight advisors using each entry's own timeout", async () => {
    const signals = new Map<string, AbortSignal>();
    const longConfig = cfg(true);
    longConfig.asyncAdvisor.maxPendingMs = 10_000;
    const shortConfig = cfg(true);
    shortConfig.asyncAdvisor.maxPendingMs = 1;
    const upstream: UpstreamClient = {
      complete(_model, _context, options) {
        const sessionId = options?.sessionId ?? "missing";
        if (options?.signal) signals.set(sessionId, options.signal);
        return new Promise(() => undefined);
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "long" }, { config: longConfig, upstream }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "short" }, { config: shortConfig, upstream }));
    assert.equal(signals.get("long")?.aborted, false);
  });

  it("does not sweep settled advice when another session becomes active", async () => {
    let completeCalls = 0;
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 100;
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        completeCalls += 1;
        return message(seenModel, `advice-${completeCalls}`);
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "session-a" }, { config, upstream }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "session-b" }, { config, upstream }));
    const resumed = await collect(streamGsdMoa(model(), driftContext(), { sessionId: "session-a" }, { config, upstream }));
    assert.equal(diagnostics(resumed).asyncAdvisor.status, "injected");
  });

  it("does not inject settled advice after its retention window", async () => {
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 1;
    let completeCalls = 0;
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        completeCalls += 1;
        return message(seenModel, `advice-${completeCalls}`);
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "stale" }, { config, upstream }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = await collect(streamGsdMoa(model(), driftContext(), { sessionId: "stale" }, { config, upstream }));
    const details = diagnostics(resumed);
    assert.equal(details.asyncAdvisor.status, "failed");
    assert.match(details.asyncAdvisor.error, /expired/);
    assert.equal(details.guidanceInjected, false);
    assert.equal(details.innerCalls[0].usage.totalTokens, 2);
  });

  it("accounts for but does not inject advice that settled after its pending deadline", async () => {
    const wait = deferred<AssistantMessage>();
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 1;
    let completeCalls = 0;
    const upstream: UpstreamClient = {
      complete(seenModel) {
        completeCalls += 1;
        return completeCalls === 1 ? wait.promise : new Promise(() => undefined);
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "late-success" }, { config, upstream }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    wait.resolve(message(model(), "late advice"));
    await new Promise((resolve) => setImmediate(resolve));
    const resumed = await collect(streamGsdMoa(model(), driftContext(), { sessionId: "late-success" }, { config, upstream }));
    const details = diagnostics(resumed);
    assert.equal(details.asyncAdvisor.status, "failed");
    assert.match(details.asyncAdvisor.error, /expired/);
    assert.equal(details.guidanceInjected, false);
    assert.equal(details.innerCalls[0].usage.totalTokens, 2);
  });

  it("retains usage from in-flight advisors aborted by expiry", async () => {
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 1;
    let completeCalls = 0;
    const upstream: UpstreamClient = {
      complete(seenModel, _context, options) {
        completeCalls += 1;
        if (completeCalls > 1) return new Promise(() => undefined);
        return new Promise((resolve) => options?.signal?.addEventListener("abort", () => {
          resolve({ ...message(seenModel, ""), stopReason: "aborted" });
        }, { once: true }));
      },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "expiry" }, { config, upstream }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collect(streamGsdMoa(model(), driftContext(), { sessionId: "expiry" }, { config, upstream }));
    await new Promise((resolve) => setImmediate(resolve));
    const resumed = await collect(streamGsdMoa(model(), driftContext(), { sessionId: "expiry" }, { config, upstream }));
    const details = diagnostics(resumed);
    assert.equal(details.asyncAdvisor.status, "failed");
    assert.equal(details.innerCalls[0].usage.totalTokens, 2);
  });

  it("reports settled failures even after the pending timeout", async () => {
    const waits = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    let completeCalls = 0;
    const config = cfg(true);
    config.asyncAdvisor.maxPendingMs = 1;
    const upstream: UpstreamClient = {
      async complete() { return waits[completeCalls++].promise; },
      stream(seenModel) { return streamText(seenModel, "primary"); },
    };

    await collect(streamGsdMoa(model(), driftContext(), undefined, { config, upstream }));
    waits[0].reject(new Error("settled failure"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const events = await collect(streamGsdMoa(model(), driftContext(), undefined, { config, upstream }));
    assert.equal(diagnostics(events).asyncAdvisor.status, "failed");
    assert.match(diagnostics(events).asyncAdvisor.error, /settled failure/);
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
