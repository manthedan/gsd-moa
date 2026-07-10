import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, resolveProposerRoute, resolveSynthesisRoute } from "../src/config.ts";
import { GSD_MOA_MODELS } from "../src/models.ts";
import { applyModelPreset } from "../src/presets.ts";
import {
  ALIAS_PRESETS,
  applyAliasPreset,
  buildDefaultAliasMap,
  buildProviderModelConfigs,
  type AliasPresetEntry,
} from "../src/registry.ts";

function routeId(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`;
}

function fingerprint(alias: string) {
  const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), alias);
  const synthesisRoute = resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets);
  return {
    primary: routeId(cfg.primary),
    reference: routeId(cfg.reference),
    synthesis: {
      enabled: cfg.fullMoa.synthesis.enabled,
      modelRef: cfg.fullMoa.synthesis.modelRef,
      routePreset: cfg.fullMoa.synthesis.routePreset,
      route: routeId(synthesisRoute),
    },
    doneGate: cfg.doneGate.enabled,
    proposers: cfg.fullMoa.proposers.map((proposer) => ({
      id: proposer.id,
      enabled: proposer.enabled,
      modelRef: proposer.modelRef,
      routePreset: proposer.routePreset,
      route: routeId(resolveProposerRoute(cfg.reference, proposer, cfg.routePresets)),
      when: proposer.when ? true : undefined,
    })),
  };
}

const DEFAULT_FP = {
  primary: "factory-codex/gpt-5.5",
  reference: "zai/glm-5.2",
  synthesis: { enabled: true, modelRef: "factory-codex/gpt-5.5", routePreset: "factory-codex-local", route: "factory-codex/gpt-5.5" },
  doneGate: false,
  proposers: [
    { id: "glm52", enabled: undefined, modelRef: undefined, routePreset: undefined, route: "zai/glm-5.2", when: undefined },
    { id: "gpt55", enabled: undefined, modelRef: "factory-codex/gpt-5.5", routePreset: "factory-codex-local", route: "factory-codex/gpt-5.5", when: undefined },
  ],
};

const GEMINI_REFERENCE_FP = {
  ...DEFAULT_FP,
  reference: "antigravity/gemini-3-flash",
  proposers: [
    ...DEFAULT_FP.proposers,
    { id: "gemini35flash", enabled: undefined, modelRef: "antigravity/gemini-3-flash", routePreset: "cliproxyapi", route: "antigravity/gemini-3-flash", when: true },
    { id: "claude46", enabled: false, modelRef: "antigravity/claude-sonnet-4-6", routePreset: "cliproxyapi", route: "antigravity/claude-sonnet-4-6", when: true },
  ],
};

const CODEX_FP = {
  primary: "openai-codex/gpt-5.5",
  reference: "zai/glm-5.2",
  synthesis: { enabled: true, modelRef: "openai-codex/gpt-5.5", routePreset: "cliproxyapi-codex", route: "openai-codex/gpt-5.5" },
  doneGate: false,
  proposers: [
    { id: "glm52", enabled: undefined, modelRef: undefined, routePreset: undefined, route: "zai/glm-5.2", when: undefined },
    { id: "gpt55", enabled: undefined, modelRef: "openai-codex/gpt-5.5", routePreset: "cliproxyapi-codex", route: "openai-codex/gpt-5.5", when: undefined },
  ],
};

const CURRENT_ALIAS_IDS = [
  "gpt55-glm52-single",
  "gpt55-glm52-advisor",
  "gpt55-glm52-full",
  "gpt55-glm52-auto",
  "gpt55-gemini35flash-single",
  "gpt55-gemini35flash-advisor",
  "gpt55-gemini35flash-full",
  "gpt55-gemini35flash-auto",
  "gpt55-glm52-gemini35flash-full",
  "gpt55-cliproxycodex-single",
  "gpt55-cliproxycodex-advisor",
  "gpt55-cliproxycodex-full",
  "gpt55-cliproxycodex-auto",
  "gpt55-cliproxycodex-glm52-nosynth-full",
  "gpt55-cliproxycodex-glm52-gemini35flash-full",
  "gpt55-cliproxycodex-glm52-claudeopus48-full",
  "glm52-zai-gpt55-cliproxycodex-full",
  "glm52-zai-gpt55-cliproxycodex-nosynth-full",
] as const;

const EXPECTED = new Map<string, ReturnType<typeof fingerprint>>([
  ["gpt55-glm52-single", DEFAULT_FP],
  ["gpt55-glm52-advisor", DEFAULT_FP],
  ["gpt55-glm52-full", DEFAULT_FP],
  ["gpt55-glm52-auto", DEFAULT_FP],
  ["gpt55-gemini35flash-single", GEMINI_REFERENCE_FP],
  ["gpt55-gemini35flash-advisor", GEMINI_REFERENCE_FP],
  ["gpt55-gemini35flash-full", GEMINI_REFERENCE_FP],
  ["gpt55-gemini35flash-auto", GEMINI_REFERENCE_FP],
  ["gpt55-glm52-gemini35flash-full", {
    ...DEFAULT_FP,
    proposers: [
      ...DEFAULT_FP.proposers,
      { id: "gemini35flash", enabled: true, modelRef: "antigravity/gemini-3-flash", routePreset: "cliproxyapi", route: "antigravity/gemini-3-flash", when: undefined },
    ],
  }],
  ["gpt55-cliproxycodex-single", CODEX_FP],
  ["gpt55-cliproxycodex-advisor", CODEX_FP],
  ["gpt55-cliproxycodex-full", CODEX_FP],
  ["gpt55-cliproxycodex-auto", CODEX_FP],
  ["gpt55-cliproxycodex-glm52-nosynth-full", { ...CODEX_FP, synthesis: { ...CODEX_FP.synthesis, enabled: false } }],
  ["gpt55-cliproxycodex-glm52-gemini35flash-full", {
    ...CODEX_FP,
    proposers: [
      ...CODEX_FP.proposers,
      { id: "gemini35flash", enabled: true, modelRef: "antigravity/gemini-3-flash", routePreset: "cliproxyapi", route: "antigravity/gemini-3-flash", when: undefined },
    ],
  }],
  ["gpt55-cliproxycodex-glm52-claudeopus48-full", {
    ...CODEX_FP,
    proposers: [
      ...CODEX_FP.proposers,
      { id: "claudeopus48", enabled: true, modelRef: "antigravity/claude-opus-4-8", routePreset: "cliproxyapi", route: "antigravity/claude-opus-4-8", when: undefined },
    ],
  }],
  ["glm52-zai-gpt55-cliproxycodex-full", { ...CODEX_FP, primary: "zai/glm-5.2" }],
  ["glm52-zai-gpt55-cliproxycodex-nosynth-full", { ...CODEX_FP, primary: "zai/glm-5.2", synthesis: { ...CODEX_FP.synthesis, enabled: false } }],
]);

describe("alias registry", () => {
  it("keeps exact preset fingerprints for the original 18 built-in aliases", () => {
    const registeredIds = new Set(ALIAS_PRESETS.map((entry) => entry.id));
    for (const id of CURRENT_ALIAS_IDS) {
      assert.ok(registeredIds.has(id), id);
      assert.deepEqual(fingerprint(id), EXPECTED.get(id), id);
    }
  });

  it("registers the GLM-only no-synthesis alias with a single GLM proposer", () => {
    const id = "gpt55-cliproxycodex-glm52only-nosynth-full";
    const registered = ALIAS_PRESETS.find((entry) => entry.id === id);
    assert.ok(registered);
    assert.equal(registered.name, "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2-only refs (No Synth)");
    const fp = fingerprint(id);
    assert.deepEqual(fp, {
      ...CODEX_FP,
      synthesis: { ...CODEX_FP.synthesis, enabled: false },
      proposers: [CODEX_FP.proposers[0]],
    });
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), id);
    assert.equal(cfg.fullMoa.proposers.length, 1);
    assert.equal(resolveProposerRoute(cfg.reference, cfg.fullMoa.proposers[0]!, cfg.routePresets).provider, "zai");
    assert.equal(buildDefaultAliasMap()[id]?.mode, "full_moa");
    assert.ok(GSD_MOA_MODELS.find((model) => model.id === id));
  });

  it("registers the rescue alias with failure-only checkpoint scopes", () => {
    const id = "gpt55-cliproxycodex-glm52-rescue";
    const registered = ALIAS_PRESETS.find((entry) => entry.id === id);
    assert.ok(registered);
    assert.equal(registered.name, "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Rescue)");
    assert.deepEqual(fingerprint(id), CODEX_FP);
    assert.deepEqual(buildDefaultAliasMap()[id], { mode: "auto", checkpointScopes: { initial: false, drift: false, failure: true } });
    assert.ok(GSD_MOA_MODELS.find((model) => model.id === id));
  });

  it("registers done-gate and GLM single aliases", () => {
    const doneGate = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-donegate");
    assert.equal(doneGate.primary.provider, "openai-codex");
    assert.equal(doneGate.doneGate.enabled, true);
    assert.equal(buildDefaultAliasMap()["gpt55-cliproxycodex-donegate"]?.mode, "single");

    const rescueDoneGate = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-glm52-rescue-donegate");
    assert.equal(rescueDoneGate.primary.provider, "openai-codex");
    assert.equal(rescueDoneGate.doneGate.enabled, true);
    assert.deepEqual(buildDefaultAliasMap()["gpt55-cliproxycodex-glm52-rescue-donegate"], { mode: "auto", checkpointScopes: { initial: false, drift: false, failure: true } });

    const typed = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-glm52-typed-donegate");
    assert.equal(typed.primary.provider, "openai-codex");
    assert.equal(typed.doneGate.enabled, true);
    assert.deepEqual(buildDefaultAliasMap()["gpt55-cliproxycodex-glm52-typed-donegate"], {
      mode: "auto",
      checkpointScopes: { initial: false, drift: false, failure: true },
      typedCheckpoints: true,
    });
    assert.ok(GSD_MOA_MODELS.find((model) => model.id === "gpt55-cliproxycodex-glm52-typed-donegate"));

    const glmSingle = applyModelPreset(structuredClone(DEFAULT_CONFIG), "glm52-zai-single");
    assert.equal(glmSingle.primary.provider, "zai");
    assert.equal(glmSingle.primary.model, "glm-5.2");
    assert.equal(glmSingle.doneGate.enabled, false);
    assert.equal(buildDefaultAliasMap()["glm52-zai-single"]?.mode, "single");
    assert.ok(GSD_MOA_MODELS.find((model) => model.id === "glm52-zai-single"));
  });

  it("keeps existing aliases done-gate disabled by default", () => {
    for (const id of CURRENT_ALIAS_IDS) assert.equal(applyModelPreset(structuredClone(DEFAULT_CONFIG), id).doneGate.enabled, false, id);
  });

  it("registers the Hermes-style no-synthesis alias with initial-only checkpoints", () => {
    const id = "gpt55-cliproxycodex-glm52-hermes-full";
    const registered = ALIAS_PRESETS.find((entry) => entry.id === id);
    assert.ok(registered);
    assert.deepEqual(fingerprint(id), EXPECTED.get("gpt55-cliproxycodex-glm52-nosynth-full"));
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), id);
    assert.equal(cfg.checkpoint.enabled, false);
    assert.equal(buildDefaultAliasMap()[id]?.mode, "full_moa");
    assert.ok(GSD_MOA_MODELS.find((model) => model.id === id));
  });

  it("derives honest model-card metadata from effective primary routes", () => {
    const codex = GSD_MOA_MODELS.find((model) => model.id === "gpt55-cliproxycodex-full");
    assert.ok(codex);
    assert.equal(codex.contextWindow, 272_000);
    assert.equal(codex.maxTokens, 128_000);
    assert.deepEqual(codex.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    const glmDriver = GSD_MOA_MODELS.find((model) => model.id === "glm52-zai-gpt55-cliproxycodex-full");
    assert.ok(glmDriver);
    assert.equal(glmDriver.contextWindow, 1_000_000);
    assert.equal(glmDriver.maxTokens, 8192);
    assert.deepEqual(glmDriver.input, ["text"]);
    assert.deepEqual(glmDriver.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("lets a hypothetical alias be added through one registry entry", () => {
    const synthetic: AliasPresetEntry = {
      id: "synthetic-registry-alias",
      name: "Synthetic registry alias",
      mode: "advisor",
      apply(config) {
        const cfg = structuredClone(config);
        cfg.primary = { ...cfg.primary, provider: "synthetic", model: "driver" };
        return cfg;
      },
    };
    const entries = [...ALIAS_PRESETS, synthetic];

    assert.equal(buildDefaultAliasMap(entries)[synthetic.id]?.mode, "advisor");
    assert.equal(buildProviderModelConfigs(DEFAULT_CONFIG, entries).find((model) => model.id === synthetic.id)?.name, synthetic.name);
    assert.equal(applyAliasPreset(structuredClone(DEFAULT_CONFIG), synthetic.id, entries).primary.provider, "synthetic");
  });
});
