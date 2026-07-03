import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildDefaultRoutePresets } from "../src/config.ts";
import { getModel, getRuntime, normalizeContext, resetRuntimeCache, type Context } from "../src/pi-compat.ts";
import { routeToModel } from "../src/upstream.ts";

const ORIGINAL_RUNTIME = process.env.GSD_MOA_RUNTIME;
const ORIGINAL_BUN = (globalThis as { Bun?: unknown }).Bun;

function setRuntime(value: "pi" | "omp" | undefined): void {
  if (value === undefined) delete process.env.GSD_MOA_RUNTIME;
  else process.env.GSD_MOA_RUNTIME = value;
  resetRuntimeCache();
}

afterEach(() => {
  if (ORIGINAL_RUNTIME === undefined) delete process.env.GSD_MOA_RUNTIME;
  else process.env.GSD_MOA_RUNTIME = ORIGINAL_RUNTIME;
  if (ORIGINAL_BUN === undefined) delete (globalThis as { Bun?: unknown }).Bun;
  else (globalThis as { Bun?: unknown }).Bun = ORIGINAL_BUN;
  resetRuntimeCache();
});

describe("runtime compatibility adapter", () => {
  it("honors GSD_MOA_RUNTIME overrides and caches until reset", () => {
    setRuntime("pi");
    assert.equal(getRuntime(), "pi");

    process.env.GSD_MOA_RUNTIME = "omp";
    assert.equal(getRuntime(), "pi");

    resetRuntimeCache();
    assert.equal(getRuntime(), "omp");
  });

  it("auto-detects omp when Bun is present and pi otherwise", () => {
    setRuntime(undefined);
    delete (globalThis as { Bun?: unknown }).Bun;
    assert.equal(getRuntime(), "pi");

    resetRuntimeCache();
    (globalThis as { Bun?: unknown }).Bun = {};
    assert.equal(getRuntime(), "omp");
  });

  it("normalizes systemPrompt for omp as string arrays", () => {
    setRuntime("omp");
    const normalized = normalizeContext({ messages: [], systemPrompt: "one" } as Context) as { systemPrompt?: string[] };
    assert.deepEqual(normalized.systemPrompt, ["one"]);
  });

  it("normalizes systemPrompt for pi as a single string", () => {
    setRuntime("pi");
    const normalized = normalizeContext({ messages: [], systemPrompt: ["one", "two"] } as unknown as Context) as { systemPrompt?: string };
    assert.equal(normalized.systemPrompt, "one\n\ntwo");
  });

  it("reads model metadata from the active runtime catalog", () => {
    setRuntime("pi");
    assert.equal(getModel("openai", "gpt-4o")?.provider, "openai");
    assert.equal(getModel("amazon-bedrock", "amazon.nova-2-lite-v1:0")?.api, "bedrock-converse-stream");

    setRuntime("omp");
    assert.equal(getModel("openai", "gpt-4o")?.provider, "openai");
    assert.equal(getModel("amazon-bedrock", "amazon.nova-2-lite-v1:0"), undefined);
  });

  it("passes thinkingLevelMap through routeToModel", () => {
    setRuntime("omp");
    const model = routeToModel({
      provider: "example-provider",
      model: "example-model",
      thinkingLevelMap: { low: null, high: "default" },
    });
    assert.deepEqual(model.thinkingLevelMap, { low: null, high: "default" });
  });

  it("adds zaiToolStream to Z.ai defaults only under upstream pi", () => {
    setRuntime("pi");
    assert.equal(buildDefaultRoutePresets()["zai-coding-plan"]?.compat?.zaiToolStream, true);

    setRuntime("omp");
    assert.equal("zaiToolStream" in (buildDefaultRoutePresets()["zai-coding-plan"]?.compat ?? {}), false);
  });
});
