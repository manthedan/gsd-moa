import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache, validateConfig } from "../src/config.ts";
import { streamOptionsForRoute, routeToModel } from "../src/upstream.ts";
import type { DefaultReasoningEffort, UpstreamRoute } from "../src/types.ts";

function withEffortEnv<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.GSD_MOA_EFFORT;
  try {
    if (value === undefined) delete process.env.GSD_MOA_EFFORT;
    else process.env.GSD_MOA_EFFORT = value;
    return fn();
  } finally {
    if (old === undefined) delete process.env.GSD_MOA_EFFORT;
    else process.env.GSD_MOA_EFFORT = old;
  }
}

function withBenchmarkIntegrityEnv<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.GSD_MOA_BENCH_INTEGRITY;
  try {
    if (value === undefined) delete process.env.GSD_MOA_BENCH_INTEGRITY;
    else process.env.GSD_MOA_BENCH_INTEGRITY = value;
    return fn();
  } finally {
    if (old === undefined) delete process.env.GSD_MOA_BENCH_INTEGRITY;
    else process.env.GSD_MOA_BENCH_INTEGRITY = old;
  }
}

function optionsFor(route: Partial<UpstreamRoute>, hostReasoning: string | undefined, env: string | undefined, defaultEffort: DefaultReasoningEffort | undefined): any {
  return withEffortEnv(env, () => streamOptionsForRoute(
    { provider: "p", model: "m", ...route } as UpstreamRoute,
    hostReasoning === undefined ? undefined : { reasoning: hostReasoning as never },
    defaultEffort,
  ));
}

function resolve(route: Partial<UpstreamRoute>, hostReasoning: string | undefined, env: string | undefined, defaultEffort: DefaultReasoningEffort | undefined): unknown {
  return optionsFor(route, hostReasoning, env, defaultEffort).reasoning;
}

describe("reasoning effort configuration", () => {
  it("defaults codex and zai routes to high effort", () => {
    withEffortEnv(undefined, () => {
      const codexRoute = { ...DEFAULT_CONFIG.primary, apiKey: "test-codex-key" };
      const zaiRoute = { ...DEFAULT_CONFIG.reference, apiKey: "test-zai-key" };
      const codex = streamOptionsForRoute(codexRoute, undefined, DEFAULT_CONFIG.defaultEffort);
      const zai = streamOptionsForRoute(zaiRoute, undefined, DEFAULT_CONFIG.defaultEffort);
      assert.equal(codex.reasoning, "high");
      assert.equal(zai.reasoning, "high");

      const codexModel = routeToModel(codexRoute);
      const zaiModel = routeToModel(zaiRoute);
      assert.equal((codexModel.compat as any).supportsReasoningEffort, true);
      assert.equal((zaiModel.compat as any).thinkingFormat, "zai");
      assert.equal((zaiModel.compat as any).supportsReasoningEffort, true);
    });
  });

  it("resolves effort with route > host > env > config > built-in precedence", () => {
    assert.equal(resolve({ effort: "xhigh" }, "medium", "low", "minimal"), "xhigh");
    assert.equal(resolve({}, "medium", "low", "minimal"), "medium");
    assert.equal(resolve({}, undefined, "xhigh", "minimal"), "xhigh");
    assert.equal(resolve({}, undefined, undefined, "low"), "low");
    assert.equal(withEffortEnv(undefined, () => streamOptionsForRoute({ provider: "p", model: "m" } as UpstreamRoute).reasoning), "high");
  });

  it("honors host reasoning disable before env and default effort", () => {
    withEffortEnv("xhigh", () => {
      const options = streamOptionsForRoute(
        { provider: "p", model: "m" } as UpstreamRoute,
        { disableReasoning: true } as never,
        "high",
      );
      assert.equal(options.reasoning, undefined);
      assert.equal(options.disableReasoning, true);
    });
  });

  it("supports inherit passthrough for env and config defaults", () => {
    assert.equal(resolve({}, undefined, "inherit", "high"), undefined);
    assert.equal(resolve({}, "medium", "inherit", "high"), "medium");
    assert.equal(resolve({}, undefined, undefined, "inherit"), undefined);
  });

  it("supports none as explicit reasoning-effort omission", () => {
    const envNone = optionsFor({}, "high", "none", "minimal");
    assert.equal(envNone.reasoning, undefined);
    assert.equal(envNone.omitReasoningEffort, true);

    const routeNone = optionsFor({ effort: "none" }, "high", "xhigh", "minimal");
    assert.equal(routeNone.reasoning, undefined);
    assert.equal(routeNone.omitReasoningEffort, true);

    const defaultNone = optionsFor({}, "high", undefined, "none");
    assert.equal(defaultNone.reasoning, undefined);
    assert.equal(defaultNone.omitReasoningEffort, true);
  });

  it("applies route temperature only when configured", () => {
    assert.equal(streamOptionsForRoute({ provider: "p", model: "m" } as UpstreamRoute).temperature, undefined);
    assert.equal(streamOptionsForRoute({ provider: "p", model: "m", temperature: 0.6 } as UpstreamRoute).temperature, 0.6);
    assert.equal(streamOptionsForRoute({ provider: "p", model: "m" } as UpstreamRoute, { temperature: 0.2 }).temperature, 0.2);
  });

  it("loads and validates benchmark integrity default, file config, and env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-integrity-"));
    try {
      resetConfigCache();
      withBenchmarkIntegrityEnv(undefined, () => assert.equal(loadConfig("missing.json", dir).benchmarkIntegrity, false));
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ benchmarkIntegrity: true }));
      resetConfigCache();
      withBenchmarkIntegrityEnv(undefined, () => assert.equal(loadConfig("gsd-moa.json", dir).benchmarkIntegrity, true));
      resetConfigCache();
      withBenchmarkIntegrityEnv("0", () => assert.equal(loadConfig("gsd-moa.json", dir).benchmarkIntegrity, false));
      resetConfigCache();
      withBenchmarkIntegrityEnv("true", () => assert.equal(loadConfig("missing.json", dir).benchmarkIntegrity, true));
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, benchmarkIntegrity: "yes" as never }), /benchmarkIntegrity must be boolean/);
    } finally {
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads and validates GSD_MOA_EFFORT and defaultEffort", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-effort-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ defaultEffort: "medium" }));
      resetConfigCache();
      withEffortEnv("xhigh", () => assert.equal(loadConfig("gsd-moa.json", dir).defaultEffort, "xhigh"));
      resetConfigCache();
      withEffortEnv("none", () => assert.equal(loadConfig("gsd-moa.json", dir).defaultEffort, "none"));
      resetConfigCache();
      withEffortEnv("junk", () => assert.throws(() => loadConfig("gsd-moa.json", dir), /defaultEffort must be one of/));
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ defaultEffort: "junk" }));
      resetConfigCache();
      withEffortEnv(undefined, () => assert.throws(() => loadConfig("gsd-moa.json", dir), /defaultEffort must be one of/));
      assert.doesNotThrow(() => validateConfig({ ...DEFAULT_CONFIG, primary: { ...DEFAULT_CONFIG.primary, effort: "none" } }));
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, primary: { ...DEFAULT_CONFIG.primary, temperature: 2.1 } }), /primary\.temperature/);
    } finally {
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
