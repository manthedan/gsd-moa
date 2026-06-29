import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, resolveProposerRoute, resolveSynthesisRoute } from "../src/config.ts";
import { applyModelPreset } from "../src/presets.ts";

describe("CLIProxyAPI Codex preset", () => {
  it("routes primary GPT-5.5, GPT reference, and synthesis through CLIProxyAPI Codex", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-full");

    assert.equal(cfg.primary.provider, "openai-codex");
    assert.equal(cfg.primary.model, "gpt-5.5");
    assert.equal(cfg.primary.api, "openai-completions");
    assert.equal(cfg.primary.baseUrl, "http://127.0.0.1:8318/v1");
    assert.equal(cfg.primary.apiKey, "$CLIPROXY_API_KEY");

    const glm = cfg.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    assert.ok(glm);
    const glmRoute = resolveProposerRoute(cfg.reference, glm, cfg.routePresets);
    assert.equal(glmRoute.provider, "zai");
    assert.equal(glmRoute.model, "glm-5.2");

    const gpt = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
    assert.ok(gpt);
    assert.equal(gpt.modelRef, "openai-codex/gpt-5.5");
    assert.equal(gpt.routePreset, "cliproxyapi-codex");
    const gptRoute = resolveProposerRoute(cfg.reference, gpt, cfg.routePresets);
    assert.equal(gptRoute.provider, "openai-codex");
    assert.equal(gptRoute.model, "gpt-5.5");
    assert.equal(gptRoute.baseUrl, "http://127.0.0.1:8318/v1");
    assert.equal(gptRoute.apiKey, "$CLIPROXY_API_KEY");

    const synthesisRoute = resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets);
    assert.equal(synthesisRoute.provider, "openai-codex");
    assert.equal(synthesisRoute.model, "gpt-5.5");
    assert.equal(synthesisRoute.baseUrl, "http://127.0.0.1:8318/v1");
  });

  it("can combine CLIProxy Codex GPT with GLM and unconditional Gemini", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-glm52-gemini35flash-full");

    assert.equal(cfg.primary.provider, "openai-codex");
    assert.equal(cfg.primary.model, "gpt-5.5");
    assert.equal(cfg.primary.baseUrl, "http://127.0.0.1:8318/v1");

    const glm = cfg.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    const gpt = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
    const gemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
    assert.ok(glm);
    assert.ok(gpt);
    assert.ok(gemini);

    const glmRoute = resolveProposerRoute(cfg.reference, glm, cfg.routePresets);
    assert.equal(glmRoute.provider, "zai");
    assert.equal(glmRoute.model, "glm-5.2");

    const gptRoute = resolveProposerRoute(cfg.reference, gpt, cfg.routePresets);
    assert.equal(gptRoute.provider, "openai-codex");
    assert.equal(gptRoute.model, "gpt-5.5");
    assert.equal(gptRoute.baseUrl, "http://127.0.0.1:8318/v1");

    assert.equal(gemini.enabled, true);
    assert.equal(gemini.when, undefined);
    const geminiRoute = resolveProposerRoute(cfg.reference, gemini, cfg.routePresets);
    assert.equal(geminiRoute.provider, "antigravity");
    assert.equal(geminiRoute.model, "gemini-3-flash");
    assert.equal(geminiRoute.baseUrl, "http://127.0.0.1:8318/v1");

    const synthesisRoute = resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets);
    assert.equal(synthesisRoute.provider, "openai-codex");
    assert.equal(synthesisRoute.baseUrl, "http://127.0.0.1:8318/v1");
  });

  it("can combine CLIProxy Codex GPT with GLM and unconditional Claude Opus", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-glm52-claudeopus48-full");

    assert.equal(cfg.primary.provider, "openai-codex");
    assert.equal(cfg.primary.model, "gpt-5.5");
    assert.equal(cfg.primary.baseUrl, "http://127.0.0.1:8318/v1");

    const glm = cfg.fullMoa.proposers.find((proposer) => proposer.id === "glm52");
    const gpt = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
    const gemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
    const claude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claudeopus48");
    assert.ok(glm);
    assert.ok(gpt);
    assert.equal(gemini, undefined);
    assert.ok(claude);

    const glmRoute = resolveProposerRoute(cfg.reference, glm, cfg.routePresets);
    assert.equal(glmRoute.provider, "zai");
    assert.equal(glmRoute.model, "glm-5.2");

    const gptRoute = resolveProposerRoute(cfg.reference, gpt, cfg.routePresets);
    assert.equal(gptRoute.provider, "openai-codex");
    assert.equal(gptRoute.model, "gpt-5.5");
    assert.equal(gptRoute.baseUrl, "http://127.0.0.1:8318/v1");

    assert.equal(claude.enabled, true);
    assert.equal(claude.when, undefined);
    const claudeRoute = resolveProposerRoute(cfg.reference, claude, cfg.routePresets);
    assert.equal(claudeRoute.provider, "antigravity");
    assert.equal(claudeRoute.model, "claude-opus-4-8");
    assert.equal(claudeRoute.baseUrl, "http://127.0.0.1:8318/v1");

    const synthesisRoute = resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets);
    assert.equal(synthesisRoute.provider, "openai-codex");
    assert.equal(synthesisRoute.baseUrl, "http://127.0.0.1:8318/v1");
  });

  it("honors local Codex model and endpoint overrides", () => {
    const oldModel = process.env.GSD_MOA_CODEX_MODEL;
    const oldBaseUrl = process.env.GSD_MOA_CODEX_BASE_URL;
    try {
      process.env.GSD_MOA_CODEX_MODEL = "gpt-5.3-codex";
      process.env.GSD_MOA_CODEX_BASE_URL = "http://127.0.0.1:9321/v1";
      const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-full");
      assert.equal(cfg.primary.model, "gpt-5.3-codex");
      assert.equal(cfg.primary.baseUrl, "http://127.0.0.1:9321/v1");

      const gpt = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
      assert.ok(gpt);
      const route = resolveProposerRoute(cfg.reference, gpt, cfg.routePresets);
      assert.equal(route.provider, "openai-codex");
      assert.equal(route.model, "gpt-5.3-codex");
      assert.equal(route.baseUrl, "http://127.0.0.1:9321/v1");
    } finally {
      if (oldModel === undefined) delete process.env.GSD_MOA_CODEX_MODEL;
      else process.env.GSD_MOA_CODEX_MODEL = oldModel;
      if (oldBaseUrl === undefined) delete process.env.GSD_MOA_CODEX_BASE_URL;
      else process.env.GSD_MOA_CODEX_BASE_URL = oldBaseUrl;
    }
  });

  it("overrides explicit Factory transport fields from project config", () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const gpt = base.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
    assert.ok(gpt);
    gpt.route = {
      provider: "factory-codex",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "http://factory.example/v1",
      apiKey: "$FACTORY_GPT_API_KEY",
      maxTokens: 4096,
    };

    const cfg = applyModelPreset(base, "gpt55-cliproxycodex-full");
    const routed = resolveProposerRoute(cfg.reference, cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55")!, cfg.routePresets);
    assert.equal(routed.provider, "openai-codex");
    assert.equal(routed.baseUrl, "http://127.0.0.1:8318/v1");
    assert.equal(routed.apiKey, "$CLIPROXY_API_KEY");
    assert.equal(routed.maxTokens, 4096);
  });
});
