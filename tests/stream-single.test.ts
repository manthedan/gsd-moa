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
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { streamGsdMoa } from "../src/stream.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
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

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
};

function textMessage(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function fakeTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const msg = textMessage(model, "");
    stream.push({ type: "start", partial: msg });
    msg.content = [{ type: "text", text: "" }];
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    (msg.content[0] as any).text = text;
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

describe("single-mode streaming", () => {
  it("passes the primary stream through without advisor latency", async () => {
    let calls = 0;
    const upstream: UpstreamClient = {
      stream(model, seenContext) {
        calls++;
        assert.equal(model.provider, "openai");
        assert.equal(model.id, "gpt-5.5");
        assert.equal(seenContext, context);
        return fakeTextStream(model, "primary response");
      },
      async complete() { throw new Error("advisor should not run in single mode"); },
    };

    const events = await collect(streamGsdMoa(gsdModel, context, undefined, { config: DEFAULT_CONFIG, upstream }));
    assert.equal(calls, 1);
    assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "text_delta", "text_end", "done"]);
    assert.equal((events.at(-1) as any).message.content[0].text, "primary response");
  });

  it("preserves tools for the final primary call", async () => {
    const upstream: UpstreamClient = {
      stream(model, seenContext) {
        assert.equal(seenContext.tools?.[0]?.name, "Bash");
        return fakeTextStream(model, "ok");
      },
      async complete() { throw new Error("not used"); },
    };
    await collect(streamGsdMoa(gsdModel, context, undefined, { config: DEFAULT_CONFIG, upstream }));
  });

  it("turns upstream errors into Pi-compatible error events", async () => {
    const upstream: UpstreamClient = {
      stream() { throw new Error("boom"); },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, context, undefined, { config: DEFAULT_CONFIG, upstream }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.match((events[0] as any).error.errorMessage, /boom/);
  });

  it("reports aborts as aborted error events", async () => {
    const controller = new AbortController();
    controller.abort();
    const upstream: UpstreamClient = {
      stream() { throw new Error("Request was aborted"); },
      async complete() { throw new Error("not used"); },
    };
    const events = await collect(streamGsdMoa(gsdModel, context, { signal: controller.signal } as SimpleStreamOptions, { config: DEFAULT_CONFIG, upstream }));
    assert.equal(events[0]?.type, "error");
    assert.equal((events[0] as any).reason, "aborted");
  });
});
