import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
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
import { chooseAction, chooseMode } from "../src/policy.ts";
import { rescueLedgerKey, recordRescue, resetRescueLedger } from "../src/rescue-ledger.ts";
import { assembleMoaPolicyInput, streamGsdMoa } from "../src/stream.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const alias = "gpt55-glm52-full";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const gsdModel: Model<Api> = {
  id: alias,
  name: alias,
  api: "gsd-moa-api",
  provider: "gsd-moa",
  baseUrl: "gsd-moa://local",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

function stuckContext(totalToolResults: number): Context {
  return {
    messages: [
      { role: "user", content: "fix tests", timestamp: 1 },
      ...Array.from({ length: totalToolResults }, (_, index) => ({
        role: "toolResult" as const,
        toolName: "Bash",
        toolCallId: `call-${index + 1}`,
        content: [{ type: "text" as const, text: "npm test exited with status 1\nAssertionError: expected true" }],
        isError: true,
        timestamp: index + 2,
      })),
    ],
  };
}

function message(model: Model<Api>, text: string): AssistantMessage {
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

function streamText(model: Model<Api>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: message(model, text) });
    stream.end();
  });
  return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("rescue policy input assembly", () => {
  afterEach(() => resetRescueLedger());

  it("records successful failure-scope injections for later contexts that omit guidance messages", async () => {
    const cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      primary: { ...structuredClone(DEFAULT_CONFIG.primary), apiKey: "primary-key" },
      reference: { ...structuredClone(DEFAULT_CONFIG.reference), apiKey: "reference-key" },
      cache: { ...DEFAULT_CONFIG.cache, enabled: false },
    };
    let referenceCalls = 0;
    const primaryContexts: Context[] = [];
    const upstream: UpstreamClient = {
      async complete(seenModel) {
        referenceCalls += 1;
        return message(seenModel, "advisor guidance");
      },
      stream(seenModel, seenContext) {
        primaryContexts.push(seenContext);
        return streamText(seenModel, "final");
      },
    };

    await collect(streamGsdMoa(gsdModel, stuckContext(3), undefined, { config: cfg, upstream }));
    assert.equal(referenceCalls, 1);
    assert.match(JSON.stringify(primaryContexts[0]?.messages), /gsd-moa advisor guidance/);

    const continuationWithoutGuidance = stuckContext(5);
    const input = assembleMoaPolicyInput(cfg, alias, continuationWithoutGuidance);
    assert.equal(input.advisorInjectionCount, 1);
    assert.equal(input.toolResultsSinceLastInjection, 2);
    const action = chooseAction(cfg, chooseMode(cfg, input), input);
    assert.equal(action.kind, "single");
    assert.match(action.reason, /MoA rescue suppressed: cooldown/);
  });

  it("uses the in-process ledger to enforce maxPerTask when guidance messages are absent from later contexts", () => {
    resetRescueLedger();
    const key = rescueLedgerKey(alias, stuckContext(3));
    recordRescue(key, 3);
    recordRescue(key, 9);

    const continuationWithoutGuidance = stuckContext(12);
    assert.equal(continuationWithoutGuidance.messages.some((message) => message.role === "user" && String(message.content).startsWith("[gsd-moa")), false);

    const input = assembleMoaPolicyInput(DEFAULT_CONFIG, alias, continuationWithoutGuidance);
    assert.equal(input.advisorInjectionCount, DEFAULT_CONFIG.checkpoint.rescue.maxPerTask);
    const action = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, input), input);

    assert.equal(action.kind, "single");
    assert.match(action.reason, /MoA rescue suppressed: maxPerTask/);
  });

  it("uses the in-process ledger to enforce rescue cooldown when guidance messages are absent from later contexts", () => {
    resetRescueLedger();
    const key = rescueLedgerKey(alias, stuckContext(3));
    recordRescue(key, 3);

    const continuationWithoutGuidance = stuckContext(5);
    const input = assembleMoaPolicyInput(DEFAULT_CONFIG, alias, continuationWithoutGuidance);
    assert.equal(input.advisorInjectionCount, 1);
    assert.equal(input.toolResultsSinceLastInjection, 2);
    const action = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, input), input);

    assert.equal(action.kind, "single");
    assert.match(action.reason, /MoA rescue suppressed: cooldown/);
  });
});
