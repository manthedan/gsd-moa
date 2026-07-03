import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache } from "../src/config.ts";
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

function resolve(route: Partial<UpstreamRoute>, hostReasoning: string | undefined, env: string | undefined, defaultEffort: DefaultReasoningEffort | undefined): unknown {
  return withEffortEnv(env, () => streamOptionsForRoute(
    { provider: "p", model: "m", ...route } as UpstreamRoute,
    hostReasoning === undefined ? undefined : { reasoning: hostReasoning as never },
    defaultEffort,
  ).reasoning);
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

  it("supports inherit passthrough for env and config defaults", () => {
    assert.equal(resolve({}, undefined, "inherit", "high"), undefined);
    assert.equal(resolve({}, "medium", "inherit", "high"), "medium");
    assert.equal(resolve({}, undefined, undefined, "inherit"), undefined);
  });

  it("loads and validates GSD_MOA_EFFORT and defaultEffort", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-effort-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ defaultEffort: "medium" }));
      resetConfigCache();
      withEffortEnv("xhigh", () => assert.equal(loadConfig("gsd-moa.json", dir).defaultEffort, "xhigh"));
      resetConfigCache();
      withEffortEnv("junk", () => assert.throws(() => loadConfig("gsd-moa.json", dir), /defaultEffort must be one of/));
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ defaultEffort: "junk" }));
      resetConfigCache();
      withEffortEnv(undefined, () => assert.throws(() => loadConfig("gsd-moa.json", dir), /defaultEffort must be one of/));
    } finally {
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
