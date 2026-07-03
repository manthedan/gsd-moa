import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import extension, { resetConfigCache, resetRuntimeCache } from "../src/index.ts";
import { GSD_MOA_MODEL_IDS } from "../src/models.ts";

function register() {
  const registrations: Array<{ id: string; config: any }> = [];
  extension({
    registerProvider(id: string, config: any) { registrations.push({ id, config }); },
  } as any);
  return registrations;
}

function inTempCwd(fn: (dir: string) => void) {
  const oldCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "gsd-moa-extension-test-"));
  try {
    process.chdir(dir);
    resetConfigCache();
    fn(dir);
  } finally {
    process.chdir(oldCwd);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Pi extension registration", () => {
  const originalRuntime = process.env.GSD_MOA_RUNTIME;

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.GSD_MOA_RUNTIME;
    else process.env.GSD_MOA_RUNTIME = originalRuntime;
    resetRuntimeCache();
  });

  it("registers provider gsd-moa with all public aliases", () => {
    const registrations = register();

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.id, "gsd-moa");
    assert.equal(typeof registrations[0]?.config.streamSimple, "function");
    assert.deepEqual(
      registrations[0]?.config.models.map((m: any) => m.id).sort(),
      [...GSD_MOA_MODEL_IDS].sort(),
    );
  });

  it("adds the upstream pi display name only in pi runtime", () => {
    process.env.GSD_MOA_RUNTIME = "pi";
    resetRuntimeCache();
    assert.equal(register()[0]?.config.name, "GSD MoA");

    process.env.GSD_MOA_RUNTIME = "omp";
    resetRuntimeCache();
    assert.equal("name" in (register()[0]?.config ?? {}), false);
  });

  it("registers user-defined aliases from the loaded config as real models", () => inTempCwd((dir) => {
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "gsd-moa.json"), JSON.stringify({
      aliases: {
        "custom-local-reviewer": { mode: "advisor" },
      },
    }));

    const registrations = register();
    const ids = registrations[0]?.config.models.map((m: any) => m.id) ?? [];
    assert.ok(ids.includes("custom-local-reviewer"));
    const custom = registrations[0]?.config.models.find((m: any) => m.id === "custom-local-reviewer");
    assert.equal(custom?.name, "GSD MoA: custom-local-reviewer (advisor)");
    assert.equal(custom?.contextWindow, 128_000);
  }));

  it("falls back to built-in models when registration-time config load fails", () => inTempCwd((dir) => {
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "gsd-moa.json"), "{ broken json");

    const registrations = register();
    assert.deepEqual(
      registrations[0]?.config.models.map((m: any) => m.id).sort(),
      [...GSD_MOA_MODEL_IDS].sort(),
    );
  }));
});
