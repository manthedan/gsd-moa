import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { DEFAULT_CONFIG, loadConfig, resetConfigCache } from "../src/config.ts";
import { buildLanguagePolicyNote } from "../src/lang-policy.ts";
import { streamGsdMoa } from "../src/stream.ts";
import type { GsdMoaConfig } from "../src/types.ts";
import type { UpstreamClient } from "../src/upstream.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const POLICY_HEADER = "[Reasoning-language policy from provider — applies to your natural-language reasoning]";

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

function streamText(seenModel: Model<Api>, text = "ok"): AssistantMessageEventStream {
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

function config(policy: GsdMoaConfig["langPolicy"]["policy"]): GsdMoaConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.cache.enabled = false;
  cfg.primary.apiKey = "primary";
  cfg.reference.apiKey = "reference";
  cfg.langPolicy = { policy };
  return cfg;
}

function countNeedle(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
}

describe("reasoning-language policy", () => {
  it("builds the five active policy notes and omits off", () => {
    assert.equal(buildLanguagePolicyNote({ langPolicy: { policy: "off" } }), undefined);
    const snippets = {
      en: "Conduct all of your reasoning, planning, explanations, and commentary in English only.",
      zh: "请仅使用中文进行所有推理、规划、解释与说明。",
      free: "Work through the problem using English or 中文",
      mixed: "[ZH-FRAME] state the constraints",
      yoked: "Alternate the language of your natural-language reasoning on a fixed schedule",
    } as const;
    for (const [policy, snippet] of Object.entries(snippets)) {
      const note = buildLanguagePolicyNote({ langPolicy: { policy: policy as keyof typeof snippets } });
      assert.match(note ?? "", new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(note?.split("\n").length, 3);
    }
    assert.match(buildLanguagePolicyNote({ langPolicy: { policy: "zh" } }) ?? "", /以下内容不受此规定限制/);
  });

  it("embeds custom and fallback yoked schedules", () => {
    assert.match(buildLanguagePolicyNote({ langPolicy: { policy: "yoked", yokeSchedule: "English on odd steps, Chinese on even steps" } }) ?? "", /English on odd steps, Chinese on even steps/);
    assert.match(buildLanguagePolicyNote({ langPolicy: { policy: "yoked" } }) ?? "", /alternate between English and Chinese at each new subgoal/);
    assert.match(buildLanguagePolicyNote({ langPolicy: { policy: "yoked", yokeSchedule: "" } }) ?? "", /alternate between English and Chinese at each new subgoal/);
  });

  it("parses env values tolerantly and lets env override file config", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-lang-config-"));
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ langPolicy: { policy: "free", yokeSchedule: "from file" } }));
      withEnv({ GSD_MOA_LANG_POLICY: undefined, GSD_MOA_LANG_YOKE_SCHEDULE: undefined }, () => {
        const cfg = loadConfig("config.json", dir);
        assert.deepEqual(cfg.langPolicy, { policy: "free", yokeSchedule: "from file" });
      });
      withEnv({ GSD_MOA_LANG_POLICY: "zh", GSD_MOA_LANG_YOKE_SCHEDULE: "from env" }, () => {
        const cfg = loadConfig("config.json", dir);
        assert.deepEqual(cfg.langPolicy, { policy: "zh", yokeSchedule: "from env" });
      });
      withEnv({ GSD_MOA_LANG_POLICY: "bogus", GSD_MOA_LANG_YOKE_SCHEDULE: undefined }, () => {
        assert.equal(loadConfig("config.json", dir).langPolicy.policy, "off");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects once into primary calls, dedupes later turns, and omits off", async () => {
    const note = buildLanguagePolicyNote({ langPolicy: { policy: "en" } })!;
    const cases: Array<{ policy: "en" | "off"; context: Context; expected: number }> = [
      { policy: "en", context: { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, expected: 1 },
      { policy: "en", context: { messages: [{ role: "user", content: `solve\n\n${note}`, timestamp: 1 }, { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "done" }], timestamp: 2 } as any] }, expected: 1 },
      { policy: "off", context: { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, expected: 0 },
    ];
    for (const { policy, context, expected } of cases) {
      let primaryContext = "";
      const upstream: UpstreamClient = {
        async complete() { throw new Error("not used"); },
        stream(seenModel, seenContext) {
          primaryContext = JSON.stringify(seenContext.messages);
          return streamText(seenModel);
        },
      };
      await collect(streamGsdMoa(model("gpt55-glm52-single"), context, undefined, { config: config(policy), upstream }));
      assert.equal(countNeedle(primaryContext, POLICY_HEADER), expected);
    }
  });

  it("keeps advisor context policy-free while injecting the primary context", async () => {
    const note = buildLanguagePolicyNote({ langPolicy: { policy: "en" } })!;
    let advisorContext = "";
    let primaryContext = "";
    const upstream: UpstreamClient = {
      async complete(seenModel, seenContext) {
        advisorContext = JSON.stringify(seenContext);
        return message(seenModel, "advice");
      },
      stream(seenModel, seenContext) {
        primaryContext = JSON.stringify(seenContext);
        return streamText(seenModel);
      },
    };
    await collect(streamGsdMoa(model("gpt55-glm52-advisor"), { messages: [{ role: "user", content: "review this", timestamp: 1 }] }, undefined, { config: config("en"), upstream }));
    assert.equal(advisorContext.includes(POLICY_HEADER), false);
    assert.equal(countNeedle(primaryContext, POLICY_HEADER), 1);
  });

  it("records active policy in diagnostics and the trace header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-lang-trace-"));
    try {
      const cfg = withEnv({
        GSD_MOA_LANG_POLICY: "yoked",
        GSD_MOA_LANG_YOKE_SCHEDULE: "English then Chinese",
        GSD_MOA_TRACE: "1",
        GSD_MOA_TRACE_DIR: dir,
      }, () => loadConfig("missing.json", dir));
      cfg.cache.enabled = false;
      cfg.primary.apiKey = "primary";
      const upstream: UpstreamClient = {
        async complete() { throw new Error("not used"); },
        stream(seenModel) { return streamText(seenModel); },
      };
      const events = await collect(streamGsdMoa(model("gpt55-glm52-single"), { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, undefined, { config: cfg, upstream }));
      const details = (events.at(-1) as any).message.diagnostics.find((diagnostic: any) => diagnostic.type === "gsd-moa.details").details;
      assert.deepEqual(details.langPolicy, { policy: "yoked", yokeSchedule: "English then Chinese" });
      const trace = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8"));
      assert.equal(trace.langPolicy, "yoked");
      assert.equal(trace.langYokeSchedule, "English then Chinese");

      const offEvents = await collect(streamGsdMoa(model("gpt55-glm52-single"), { messages: [{ role: "user", content: "solve", timestamp: 1 }] }, undefined, { config: config("off"), upstream }));
      const offDetails = (offEvents.at(-1) as any).message.diagnostics.find((diagnostic: any) => diagnostic.type === "gsd-moa.details").details;
      assert.equal(offDetails.langPolicy, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
