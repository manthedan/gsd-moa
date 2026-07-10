import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
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
import { DONE_GATE_NOTE, doneGateLedgerKey, readDoneGateLedger, resetDoneGateLedger } from "../src/done-gate.ts";
import { streamGsdMoa } from "../src/stream.ts";
import type { GsdMoaConfig } from "../src/types.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const gsdModel: Model<Api> = {
  id: "gpt55-glm52-single",
  name: "single",
  api: "gsd-moa-api",
  provider: "gsd-moa",
  baseUrl: "gsd-moa://local",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

function usage(input: number, output = input): AssistantMessage["usage"] {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function config(): GsdMoaConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.primary.apiKey = "test-primary-key";
  cfg.doneGate.enabled = true;
  cfg.doneGate.maxPerTask = 1;
  cfg.doneGate.minRemainingMs = 0;
  return cfg;
}

function textMessage(model: Model<Api>, text: string, input: number, stopReason: "stop" | "length" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(input),
    stopReason,
    timestamp: Date.now(),
  };
}

function fakeTextStream(model: Model<Api>, text: string, input: number, stopReason: "stop" | "length" = "stop"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = textMessage(model, "", input, stopReason);
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    (msg.content[0] as any).text = text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: stopReason, message: msg });
    stream.end();
  });
  return stream;
}

function fakeToolCallStream(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "next", name: "bash", arguments: { command: "python3 -m py_compile f.py" } }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(3),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: msg.content[0] as any, partial: msg });
    stream.push({ type: "done", reason: "toolUse", message: msg });
    stream.end();
  });
  return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function modifiedContext(): Context {
  return {
    messages: [
      { role: "user", content: "make f.py", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo 'print(1)' > f.py" } }], api: "openai-completions", provider: "p", model: "m", usage: usage(0), stopReason: "toolUse", timestamp: 2 } as any,
      { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "created f.py" }], isError: false, timestamp: 3 } as any,
    ],
  };
}

function verifiedContext(): Context {
  const context = modifiedContext();
  context.messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "python3 -m py_compile f.py" } }], api: "openai-completions", provider: "p", model: "m", usage: usage(0), stopReason: "toolUse", timestamp: 4 } as any,
    { role: "toolResult", toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "" }], isError: false, timestamp: 5 } as any,
  );
  return context;
}

function diagnostics(events: AssistantMessageEvent[]): any {
  const final = events.at(-1) as any;
  return final.message.diagnostics.find((d: any) => d.type === "gsd-moa.details").details;
}

describe("done gate stream", () => {
  beforeEach(() => resetDoneGateLedger());

  it("retries with the gate note when an armed first primary finalizes without tool calls", async () => {
    const seen: Context[] = [];
    const upstream: UpstreamClient = {
      stream(model, context) {
        seen.push(context);
        return seen.length === 1 ? fakeTextStream(model, "blind finish", 1) : fakeTextStream(model, "verified or justified", 10);
      },
      async complete() { throw new Error("not used"); },
    };
    const context = modifiedContext();
    const events = await collect(streamGsdMoa(gsdModel, context, undefined, { config: config(), upstream }));

    assert.equal(seen.length, 2);
    assert.equal((seen[1].messages.at(-1) as any).content, DONE_GATE_NOTE);
    assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
    assert.equal((events.at(-1) as any).message.content[0].text, "verified or justified");
    assert.equal((events.at(-1) as any).message.usage.input, 11);
    assert.equal(diagnostics(events).doneGate.fired, true);
    assert.equal(diagnostics(events).doneGate.postGateBehavior, "ignored");
    assert.equal(readDoneGateLedger(doneGateLedgerKey(gsdModel.id, context))?.count, 1);
  });

  it("emits M3 pre-done fired and suppressed diagnostics", async () => {
    const typedModel = { ...gsdModel, id: "typed-done-test" };
    const typedConfig = config();
    typedConfig.aliases[typedModel.id] = { mode: "single", typedCheckpoints: true };

    let firedCalls = 0;
    const firedUpstream: UpstreamClient = {
      stream(model) {
        firedCalls += 1;
        return fakeTextStream(model, firedCalls === 1 ? "blind finish" : "done", 1);
      },
      async complete() { throw new Error("not used"); },
    };
    const fired = await collect(streamGsdMoa(typedModel, modifiedContext(), { sessionId: "typed-pre-done-fire" }, { config: typedConfig, upstream: firedUpstream }));
    assert.equal(diagnostics(fired).typedCheckpoint.type, "pre_done");
    assert.equal(diagnostics(fired).typedCheckpoint.status, "fired");

    resetDoneGateLedger();
    const suppressedUpstream: UpstreamClient = {
      stream(model) { return fakeTextStream(model, "already verified", 1); },
      async complete() { throw new Error("not used"); },
    };
    const suppressed = await collect(streamGsdMoa(typedModel, verifiedContext(), { sessionId: "typed-pre-done-suppress" }, { config: typedConfig, upstream: suppressedUpstream }));
    assert.equal(diagnostics(suppressed).typedCheckpoint.type, "pre_done");
    assert.equal(diagnostics(suppressed).typedCheckpoint.status, "suppressed");
  });

  it("classifies verifier requests and explicit impossibility justifications", async () => {
    let verifierCalls = 0;
    const verifierUpstream: UpstreamClient = {
      stream(model) {
        verifierCalls += 1;
        return verifierCalls === 1 ? fakeTextStream(model, "blind finish", 1) : fakeToolCallStream(model);
      },
      async complete() { throw new Error("not used"); },
    };
    const verifierEvents = await collect(streamGsdMoa(gsdModel, modifiedContext(), undefined, { config: config(), upstream: verifierUpstream }));
    assert.equal(diagnostics(verifierEvents).doneGate.postGateBehavior, "verification-requested");

    resetDoneGateLedger();
    let justificationCalls = 0;
    const justificationUpstream: UpstreamClient = {
      stream(model) {
        justificationCalls += 1;
        return justificationCalls === 1
          ? fakeTextStream(model, "blind finish", 1)
          : fakeTextStream(model, "I cannot run the tests because pytest is not installed in this environment.", 2);
      },
      async complete() { throw new Error("not used"); },
    };
    const justificationEvents = await collect(streamGsdMoa(gsdModel, modifiedContext(), undefined, { config: config(), upstream: justificationUpstream }));
    assert.equal(diagnostics(justificationEvents).doneGate.postGateBehavior, "justified");
  });

  it("marks a non-tool retry that hits a limit as incomplete", async () => {
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model) {
        calls += 1;
        return calls === 1 ? fakeTextStream(model, "blind finish", 1) : fakeTextStream(model, "partial", 2, "length");
      },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, modifiedContext(), undefined, { config: config(), upstream }));
    assert.equal(diagnostics(events).doneGate.postGateBehavior, "incomplete");
  });

  it("records a fired gate and first-primary usage when the retry iterator throws", async () => {
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model) {
        calls += 1;
        if (calls === 1) return fakeTextStream(model, "blind finish", 3);
        return (async function* () { throw new Error("retry iterator failed"); })() as unknown as AssistantMessageEventStream;
      },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, modifiedContext(), undefined, { config: config(), upstream }));
    const failed = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
    const details = failed.error.diagnostics?.find((item) => item.type === "gsd-moa.details")?.details as any;
    assert.equal(failed.error.usage.input, 3);
    assert.equal(details.doneGate.fired, true);
    assert.equal(details.doneGate.postGateBehavior, "error");
  });

  it("flushes buffered tool-call turns and does not retry", async () => {
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model) {
        calls += 1;
        return fakeToolCallStream(model);
      },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, modifiedContext(), undefined, { config: config(), upstream }));
    assert.equal(calls, 1);
    assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_end", "done"]);
    assert.equal(diagnostics(events).doneGate.fired, false);
  });

  it("passes through when enabled but verifier already ran", async () => {
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model) {
        calls += 1;
        return fakeTextStream(model, "done", 2);
      },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, verifiedContext(), undefined, { config: config(), upstream }));
    assert.equal(calls, 1);
    assert.equal((events.at(-1) as any).message.content[0].text, "done");
    assert.equal(diagnostics(events).doneGate.armed, false);
    assert.equal(diagnostics(events).doneGate.suppressedReason, "verifier-ran");
  });

  it("accepts a second finalization after the ledger cap is reached", async () => {
    const context = modifiedContext();
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model) {
        calls += 1;
        return fakeTextStream(model, `call ${calls}`, calls);
      },
      async complete() { throw new Error("not used"); },
    };

    await collect(streamGsdMoa(gsdModel, context, undefined, { config: config(), upstream }));
    const second = await collect(streamGsdMoa(gsdModel, context, undefined, { config: config(), upstream }));

    assert.equal(calls, 3);
    assert.equal((second.at(-1) as any).message.content[0].text, "call 3");
    assert.equal(diagnostics(second).doneGate.armed, false);
    assert.equal(diagnostics(second).doneGate.suppressedReason, "ledger-cap");
  });
});
