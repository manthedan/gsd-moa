import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, resolveProposerRoute } from "../src/config.ts";
import { applyModelPreset } from "../src/presets.ts";

describe("Gemini Flash proxy preset", () => {
  it("applies the Gemini Flash preset for Gemini alias ids", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-gemini35flash-advisor");
    assert.equal(cfg.reference.provider, "antigravity");
    assert.equal(cfg.reference.model, "gemini-3-flash");
    assert.equal(cfg.reference.api, "openai-completions");
    assert.equal(cfg.reference.baseUrl, "http://127.0.0.1:8318/v1");
    const specialist = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
    assert.equal(specialist?.modelRef, "antigravity/gemini-3-flash");
    assert.equal(specialist?.routePreset, "cliproxyapi");
    assert.deepEqual(specialist?.when?.anyCapability, ["image", "video", "audio"]);
    const claude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claude46");
    assert.equal(claude?.enabled, false);
    assert.equal(claude?.modelRef, "antigravity/claude-sonnet-4-6");
    assert.equal(claude?.routePreset, "cliproxyapi");

    const unchanged = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-glm52-advisor");
    assert.equal(unchanged.reference.provider, "zai");
  });

  it("can run Gemini as an unconditional full-MoA reference alongside GLM and GPT", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-glm52-gemini35flash-full");
    const glm = cfg.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    const gpt = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
    const gemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
    assert.ok(glm);
    assert.ok(gpt);
    assert.ok(gemini);
    assert.equal(gemini.enabled, true);
    assert.equal(gemini.when, undefined);
    assert.equal(gemini.modelRef, "antigravity/gemini-3-flash");
    assert.equal(gemini.routePreset, "cliproxyapi");

    const geminiRoute = resolveProposerRoute(cfg.reference, gemini, cfg.routePresets);
    assert.equal(geminiRoute.provider, "antigravity");
    assert.equal(geminiRoute.model, "gemini-3-flash");
    assert.equal(geminiRoute.baseUrl, "http://127.0.0.1:8318/v1");
  });

  it("keeps partial overrides on inherited GLM references pinned to GLM", () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const glm = base.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    assert.ok(glm);
    glm.route = { maxTokens: 4096 };

    const cfg = applyModelPreset(base, "gpt55-gemini35flash-full");
    const pinnedGlm = cfg.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    assert.ok(pinnedGlm);
    const route = resolveProposerRoute(cfg.reference, pinnedGlm, cfg.routePresets);
    assert.equal(route.provider, "zai");
    assert.equal(route.model, "glm-5.2");
    assert.equal(route.baseUrl, DEFAULT_CONFIG.reference.baseUrl);
    assert.equal(route.maxTokens, 4096);
  });

  it("lets project config opt into the parked Claude specialist", () => {
    const base = structuredClone(DEFAULT_CONFIG);
    base.fullMoa.proposers.push({
      id: "claude46",
      label: "Claude override",
      enabled: true,
      route: { model: "claude-opus-4-6-thinking" },
    });
    const cfg = applyModelPreset(base, "gpt55-gemini35flash-full");
    const claude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claude46");
    assert.equal(claude?.enabled, true);
    assert.equal(claude?.label, "Claude override");
    assert.equal(claude?.routePreset, "cliproxyapi");
    assert.equal(claude?.route?.model, "claude-opus-4-6-thinking");
    assert.ok(claude);
    const route = resolveProposerRoute(cfg.reference, claude, cfg.routePresets);
    assert.equal(route.provider, "antigravity");
    assert.equal(route.model, "claude-opus-4-6-thinking");
  });

  it("lets local installs override the CLIProxyAPI model and endpoint", () => {
    const oldModel = process.env.GSD_MOA_GEMINI_MODEL;
    const oldBaseUrl = process.env.GSD_MOA_GEMINI_BASE_URL;
    try {
      process.env.GSD_MOA_GEMINI_MODEL = "gemini-3.5-flash-extra-low";
      process.env.GSD_MOA_GEMINI_BASE_URL = "http://127.0.0.1:9999/v1";
      const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-gemini35flash-full");
      assert.equal(cfg.reference.model, "gemini-3.5-flash-extra-low");
      assert.equal(cfg.reference.baseUrl, "http://127.0.0.1:9999/v1");
    } finally {
      if (oldModel === undefined) delete process.env.GSD_MOA_GEMINI_MODEL;
      else process.env.GSD_MOA_GEMINI_MODEL = oldModel;
      if (oldBaseUrl === undefined) delete process.env.GSD_MOA_GEMINI_BASE_URL;
      else process.env.GSD_MOA_GEMINI_BASE_URL = oldBaseUrl;
    }
  });
});
