import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai/compat";
import { DEFAULT_CONFIG, loadConfig, resolveProposerRoute, resolveSynthesisRoute, validateConfig } from "../src/config.ts";
import { referenceCacheKey } from "../src/cache.ts";
import { hasRecentToolResults, latestUserText, sanitizeReferenceContext } from "../src/context.ts";
import { chooseMode, stripMoaMarkers } from "../src/policy.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("mode policy", () => {
  it("maps fixed aliases", () => {
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "review this" }).mode, "single");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-advisor", latestUserText: "typo" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-full", latestUserText: "typo" }).mode, "full_moa");
  });

  it("uses deterministic auto heuristics across single, advisor, and full MoA", () => {
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-auto", latestUserText: "please plan this phase" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-auto", latestUserText: "please do a deep review" }).mode, "full_moa");
    assert.equal(
      chooseMode({ ...DEFAULT_CONFIG, fullMoa: { ...DEFAULT_CONFIG.fullMoa, enabled: false } }, { alias: "gpt55-glm52-auto", latestUserText: "please do a deep review" }).mode,
      "advisor",
    );
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-auto", latestUserText: "fix a typo" }).mode, "single");
  });

  it("honors and strips explicit markers", () => {
    const result = stripMoaMarkers("<!-- gsd-moa:advisor --> do hard review");
    assert.deepEqual(result.markers, ["<!-- gsd-moa:advisor -->"]);
    assert.equal(result.text, "do hard review");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "<!-- gsd-moa:advisor --> review" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "<!-- gsd-moa:full --> review" }).mode, "full_moa");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-advisor", latestUserText: "<!-- gsd-moa:off --> review" }).mode, "single");
  });

  it("rejects recursive upstream routes", () => {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, primary: { provider: "gsd-moa", model: "x" } }), /recursion guard/);
  });

  it("merges project aliases with new default aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-config-test-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({
        aliases: {
          "gpt55-glm52-single": { mode: "single" },
          "gpt55-glm52-advisor": { mode: "advisor" },
          "gpt55-glm52-auto": { mode: "auto" },
        },
      }));
      const cfg = loadConfig("gsd-moa.json", dir);
      assert.equal(cfg.aliases["gpt55-glm52-full"]?.mode, "full_moa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows proof runs to opt into tracing via env without mutating defaults", () => {
    const oldTrace = process.env.GSD_MOA_TRACE;
    const oldDir = process.env.GSD_MOA_TRACE_DIR;
    const oldPrimaryBaseUrl = process.env.GSD_MOA_PRIMARY_BASE_URL;
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-trace-env-test-"));
    try {
      process.env.GSD_MOA_TRACE = "1";
      process.env.GSD_MOA_TRACE_DIR = join(dir, "traces");
      process.env.GSD_MOA_PRIMARY_BASE_URL = "http://host.docker.internal:8317/v1";
      const cfg = loadConfig("missing.json", dir);
      assert.equal(cfg.trace.enabled, true);
      assert.equal(cfg.trace.dir, join(dir, "traces"));
      assert.equal(cfg.primary.baseUrl, "http://host.docker.internal:8317/v1");
      const gpt = cfg.fullMoa.proposers.find((p) => p.id === "gpt55");
      assert.ok(gpt);
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).baseUrl, "http://host.docker.internal:8317/v1");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).provider, "factory-codex");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).model, "gpt-5.5");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).baseUrl, "http://host.docker.internal:8317/v1");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).apiKey, "$FACTORY_GPT_API_KEY");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).compat?.maxTokensField, "max_tokens");
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).input?.includes("image"), true);
      assert.equal(resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets).baseUrl, "http://host.docker.internal:8317/v1");

      if (oldTrace === undefined) delete process.env.GSD_MOA_TRACE;
      else process.env.GSD_MOA_TRACE = oldTrace;
      if (oldDir === undefined) delete process.env.GSD_MOA_TRACE_DIR;
      else process.env.GSD_MOA_TRACE_DIR = oldDir;
      if (oldPrimaryBaseUrl === undefined) delete process.env.GSD_MOA_PRIMARY_BASE_URL;
      else process.env.GSD_MOA_PRIMARY_BASE_URL = oldPrimaryBaseUrl;

      const cfgAfterEnvRestore = loadConfig("missing.json", dir);
      assert.equal(cfgAfterEnvRestore.trace.enabled, DEFAULT_CONFIG.trace.enabled);
      assert.equal(cfgAfterEnvRestore.trace.dir, DEFAULT_CONFIG.trace.dir);
      const restoredGpt = cfgAfterEnvRestore.fullMoa.proposers.find((p) => p.id === "gpt55");
      const defaultGpt = DEFAULT_CONFIG.fullMoa.proposers.find((p) => p.id === "gpt55");
      assert.ok(restoredGpt);
      assert.ok(defaultGpt);
      assert.equal(resolveProposerRoute(cfgAfterEnvRestore.reference, restoredGpt, cfgAfterEnvRestore.routePresets).baseUrl, DEFAULT_CONFIG.primary.baseUrl);
      assert.equal(resolveProposerRoute(DEFAULT_CONFIG.reference, defaultGpt, DEFAULT_CONFIG.routePresets).baseUrl, DEFAULT_CONFIG.primary.baseUrl);
    } finally {
      if (oldTrace === undefined) delete process.env.GSD_MOA_TRACE;
      else process.env.GSD_MOA_TRACE = oldTrace;
      if (oldDir === undefined) delete process.env.GSD_MOA_TRACE_DIR;
      else process.env.GSD_MOA_TRACE_DIR = oldDir;
      if (oldPrimaryBaseUrl === undefined) delete process.env.GSD_MOA_PRIMARY_BASE_URL;
      else process.env.GSD_MOA_PRIMARY_BASE_URL = oldPrimaryBaseUrl;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies route preset overrides to top-level primary and reference routes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-route-preset-test-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({
        routePresets: {
          "factory-codex-local": { baseUrl: "http://factory.example/v1", apiKey: "factory-secret" },
          "zai-coding-plan": { baseUrl: "http://zai.example/v1", apiKey: "zai-secret" },
        },
      }));
      const cfg = loadConfig("gsd-moa.json", dir);
      assert.equal(cfg.primary.provider, "factory-codex");
      assert.equal(cfg.primary.model, "gpt-5.5");
      assert.equal(cfg.primary.baseUrl, "http://factory.example/v1");
      assert.equal(cfg.primary.apiKey, "factory-secret");
      assert.equal(cfg.reference.provider, "zai");
      assert.equal(cfg.reference.model, "glm-5.2");
      assert.equal(cfg.reference.baseUrl, "http://zai.example/v1");
      assert.equal(cfg.reference.apiKey, "zai-secret");
      const gpt = cfg.fullMoa.proposers.find((p) => p.id === "gpt55");
      assert.ok(gpt);
      assert.equal(resolveProposerRoute(cfg.reference, gpt, cfg.routePresets).baseUrl, "http://factory.example/v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads modelRef-based full MoA specialists without inheriting the default route", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-modelref-test-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({
        routePresets: {
          "gemini-proxy": { baseUrl: "http://gemini.example/v1", api: "openai-completions", apiKey: "$GEMINI_PROXY_KEY" },
        },
        fullMoa: {
          proposers: [{
            id: "gemini-specialist",
            label: "Gemini specialist",
            modelRef: "google/gemini-3.5-flash",
            routePreset: "gemini-proxy",
            route: { maxTokens: 1234 },
            when: { anyCapability: ["image"], anyKeyword: ["diagram"] },
          }],
        },
      }));
      const cfg = loadConfig("gsd-moa.json", dir);
      const specialist = cfg.fullMoa.proposers.find((p) => p.id === "gemini-specialist");
      assert.ok(specialist);
      const route = resolveProposerRoute(cfg.reference, specialist, cfg.routePresets);
      assert.equal(route.provider, "google");
      assert.equal(route.model, "gemini-3.5-flash");
      assert.equal(route.baseUrl, "http://gemini.example/v1");
      assert.equal(route.api, "openai-completions");
      assert.equal(route.apiKey, "$GEMINI_PROXY_KEY");
      assert.equal(route.maxTokens, 1234);
      assert.notEqual(route.baseUrl, DEFAULT_CONFIG.reference.baseUrl);
      assert.deepEqual(specialist.when?.anyCapability, ["image"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges full MoA reference overrides by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-proposer-test-"));
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({
        fullMoa: {
          proposers: [{ id: "gpt55", route: { baseUrl: "http://override.example/v1" } }],
          synthesis: { route: { baseUrl: "http://synthesis.example/v1" } },
        },
      }));
      const cfg = loadConfig("gsd-moa.json", dir);
      assert.equal(cfg.fullMoa.proposers.length, DEFAULT_CONFIG.fullMoa.proposers.length);
      const gpt = cfg.fullMoa.proposers.find((p) => p.id === "gpt55");
      assert.equal(gpt?.label, "GPT-5.5 reference");
      assert.ok(gpt);
      const gptRoute = resolveProposerRoute(cfg.reference, gpt, cfg.routePresets);
      assert.equal(gptRoute.provider, "factory-codex");
      assert.equal(gptRoute.model, "gpt-5.5");
      assert.equal(gptRoute.baseUrl, "http://override.example/v1");
      const synthesisRoute = resolveSynthesisRoute(cfg.reference, cfg.fullMoa.synthesis, cfg.routePresets);
      assert.equal(synthesisRoute.provider, "factory-codex");
      assert.equal(synthesisRoute.model, "gpt-5.5");
      assert.equal(synthesisRoute.baseUrl, "http://synthesis.example/v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reference cache keys", () => {
  it("include preserved image content digests", () => {
    const route = DEFAULT_CONFIG.primary;
    const first: Context = { messages: [{ role: "user", content: [{ type: "text", text: "analyze this screenshot" }, { type: "image", data: "first", mimeType: "image/png" } as any], timestamp: 1 }] };
    const second: Context = { messages: [{ role: "user", content: [{ type: "text", text: "analyze this screenshot" }, { type: "image", data: "second", mimeType: "image/png" } as any], timestamp: 1 }] };
    assert.notEqual(
      referenceCacheKey(DEFAULT_CONFIG, first, route, "full_moa:reference:gemini35flash", DEFAULT_CONFIG.prompts.fullMoaVersion),
      referenceCacheKey(DEFAULT_CONFIG, second, route, "full_moa:reference:gemini35flash", DEFAULT_CONFIG.prompts.fullMoaVersion),
    );
  });
});

describe("reference context sanitization", () => {
  const context: Context = {
    systemPrompt: "secret system",
    tools: [{ name: "Bash", description: "run shell", parameters: { type: "object" } as any }],
    messages: [
      { role: "user", content: "<!-- gsd-moa:advisor --> make a plan", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will call a tool" },
          { type: "toolCall", id: "t1", name: "Bash", arguments: { command: "ls" } },
        ],
        api: "openai-completions",
        provider: "factory-codex",
        model: "gpt-5.5",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: [{ type: "text", text: "file" }], isError: false, timestamp: 3 },
    ],
  };

  it("extracts latest text and detects tool-loop continuation", () => {
    assert.equal(latestUserText(context), "make a plan");
    assert.equal(hasRecentToolResults(context), true);
  });

  it("drops tools, tool calls, tool results, and system prompt for advisor calls", () => {
    const sanitized = sanitizeReferenceContext(context);
    assert.equal(sanitized.systemPrompt, undefined);
    assert.equal(sanitized.tools, undefined);
    assert.equal(sanitized.messages.length, 2);
    assert.equal(sanitized.messages[0]?.role, "user");
    assert.equal((sanitized.messages[0] as any).content, "make a plan");
    const assistant = sanitized.messages[1] as any;
    assert.equal(assistant.role, "assistant");
    assert.deepEqual(assistant.content, [{ type: "text", text: "I will call a tool" }]);
  });
});
