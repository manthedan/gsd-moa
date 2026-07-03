import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "../src/pi-compat.js";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache, resolveProposerRoute, resolveSynthesisRoute, validateConfig } from "../src/config.ts";
import { advisorCacheKey, readAdvisorCache, readCacheByKey, referenceCacheKey, writeAdvisorCache } from "../src/cache.ts";
import { buildToolObservationSummary, hasRecentToolResults, latestUserText, sanitizeReferenceContext } from "../src/context.ts";
import { chooseAction, chooseMode, stripMoaMarkers } from "../src/policy.ts";
import { applyModelPreset } from "../src/presets.ts";
import { resolveConfigValue, streamOptionsForRoute } from "../src/upstream.ts";

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

  it("Hermes-style alias runs initial full MoA but suppresses failure/drift checkpoints", () => {
    const cfg = applyModelPreset(structuredClone(DEFAULT_CONFIG), "gpt55-cliproxycodex-glm52-hermes-full");
    const initialInput = {
      alias: "gpt55-cliproxycodex-glm52-hermes-full",
      latestUserText: "deep review this",
      hasToolResults: false,
      hasFreshMoaMarker: false,
    };
    const initialPolicy = chooseMode(cfg, initialInput);
    assert.deepEqual(chooseAction(cfg, initialPolicy, initialInput), {
      kind: "run",
      mode: "full_moa",
      scope: "initial",
      reason: "full MoA alias",
    });

    const summary = buildToolObservationSummary({
      messages: [
        { role: "user", content: "deep review this", timestamp: 1 },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "error: failed with exit code 1" }], isError: true, timestamp: 2 },
      ],
    } as never, cfg.checkpoint.maxToolResults);
    const failureInput = {
      alias: "gpt55-cliproxycodex-glm52-hermes-full",
      latestUserText: "deep review this",
      hasToolResults: true,
      hasFreshMoaMarker: false,
      recentToolSummary: summary,
    };
    const failurePolicy = chooseMode(cfg, failureInput);
    const failureAction = chooseAction(cfg, failurePolicy, failureInput);
    assert.equal(failureAction.kind, "single");
    assert.match(failureAction.reason, /checkpoint policy disabled/);
  });

  it("honors and strips explicit markers", () => {
    const result = stripMoaMarkers("<!-- gsd-moa:advisor --> do hard review");
    assert.deepEqual(result.markers, ["<!-- gsd-moa:advisor -->"]);
    assert.equal(result.text, "do hard review");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "<!-- gsd-moa:advisor --> review" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "<!-- gsd-moa:full --> review" }).mode, "full_moa");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-advisor", latestUserText: "<!-- gsd-moa:off --> review" }).mode, "single");
  });

  it("chooses checkpoint actions for tool-loop continuations", () => {
    const failedContext: Context = {
      messages: [
        { role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "npm test exited with status 1\nAssertionError: expected true" }], isError: true, timestamp: 2 } as any,
      ],
    };
    const failedInput = {
      alias: "gpt55-glm52-full",
      latestUserText: latestUserText(failedContext, true),
      hasToolResults: hasRecentToolResults(failedContext),
      recentToolSummary: buildToolObservationSummary(failedContext),
    };
    const failedPolicy = chooseMode(DEFAULT_CONFIG, failedInput);
    const failedAction = chooseAction(DEFAULT_CONFIG, failedPolicy, failedInput);
    assert.equal(failedAction.kind, "run");
    if (failedAction.kind === "run") {
      assert.equal(failedAction.scope, "failure");
      assert.equal(failedAction.mode, "full_moa");
      assert.ok(failedAction.observationSummary?.latestFailureSignals.includes("tool-result-error"));
    }

    const explicitFullSingleAliasInput = { ...failedInput, alias: "gpt55-glm52-single" };
    const explicitFullSingleAliasAction = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, explicitFullSingleAliasInput), explicitFullSingleAliasInput);
    assert.equal(explicitFullSingleAliasAction.kind, "run");
    if (explicitFullSingleAliasAction.kind === "run") {
      assert.equal(explicitFullSingleAliasAction.scope, "failure");
      assert.equal(explicitFullSingleAliasAction.mode, "full_moa");
    }

    const successContext: Context = {
      messages: [
        failedContext.messages[0],
        failedContext.messages[1],
        { role: "toolResult", toolName: "Bash", toolCallId: "call-2", content: [{ type: "text", text: "created file\ndone" }], timestamp: 3 } as any,
      ],
    };
    const successInput = {
      alias: "gpt55-glm52-full",
      latestUserText: latestUserText(successContext, true),
      hasToolResults: hasRecentToolResults(successContext),
      recentToolSummary: buildToolObservationSummary(successContext),
    };
    const successAction = chooseAction(DEFAULT_CONFIG, chooseMode(DEFAULT_CONFIG, successInput), successInput);
    assert.deepEqual(successAction, { kind: "single", reason: "tool-loop continuation without checkpoint signal" });
  });

  it("fires drift checkpoints periodically using uncapped tool-result count", () => {
    const cfg = { ...DEFAULT_CONFIG, checkpoint: { ...DEFAULT_CONFIG.checkpoint, driftToolResultThreshold: 3 } };
    const baseMessages: Context["messages"] = [{ role: "user", content: "<!-- gsd-moa:advisor --> continue", timestamp: 1 }];
    const tool = (n: number) => ({ role: "toolResult", toolName: "Bash", toolCallId: `call-${n}`, content: [{ type: "text", text: `done ${n}` }], timestamp: n + 1 }) as any;
    const three: Context = { messages: [...baseMessages, tool(1), tool(2), tool(3)] };
    const four: Context = { messages: [...baseMessages, tool(1), tool(2), tool(3), tool(4)] };

    const threeInput = {
      alias: "gpt55-glm52-advisor",
      latestUserText: latestUserText(three, true),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(three),
    };
    const threeAction = chooseAction(cfg, chooseMode(cfg, threeInput), threeInput);
    assert.equal(threeAction.kind, "run");
    if (threeAction.kind === "run") {
      assert.equal(threeAction.scope, "drift");
      assert.equal(threeAction.observationSummary?.toolResultCount, 3);
      assert.equal(threeAction.observationSummary?.totalToolResultCount, 3);
    }

    const fourInput = {
      alias: "gpt55-glm52-advisor",
      latestUserText: latestUserText(four, true),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(four),
    };
    const fourAction = chooseAction(cfg, chooseMode(cfg, fourInput), fourInput);
    assert.deepEqual(fourAction, { kind: "single", reason: "tool-loop continuation without checkpoint signal" });
    assert.equal(fourInput.recentToolSummary?.toolResultCount, 4);
    assert.equal(fourInput.recentToolSummary?.totalToolResultCount, 4);
    assert.match(fourInput.recentToolSummary?.text ?? "", /Recent tool observations:/);
    assert.doesNotMatch(fourInput.recentToolSummary?.text ?? "", /since the last MoA checkpoint/);

    const explicitFullOnSingleAlias = {
      alias: "gpt55-glm52-single",
      latestUserText: latestUserText(three, true).replace("advisor", "full"),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(three),
    };
    const explicitFullAction = chooseAction(cfg, chooseMode(cfg, explicitFullOnSingleAlias), explicitFullOnSingleAlias);
    assert.equal(explicitFullAction.kind, "run");
    if (explicitFullAction.kind === "run") {
      assert.equal(explicitFullAction.scope, "drift");
      assert.equal(explicitFullAction.mode, "full_moa");
    }
  });

  it("redacts credentials from compact tool observation summaries", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "fix failing deploy", timestamp: 1 },
        {
          role: "toolResult",
          toolName: "Bash",
          toolCallId: "call-1",
          content: [{ type: "text", text: "Error: deploy failed\nWarning: Authorization: Bearer sk-supersecret1234567890\nWarning Authorization=Basic basic-secret-token\nWarning Authorization Bearer whitespace-secret-token\nWarning Authorization: token token-scheme-secret\nError OPENAI_API_KEY=sk-anothersecret1234567890\nError ANTHROPIC_API_KEY=anthropic-secret-value\nWarning NPM_TOKEN=npm-provider-token\nWarning //registry.npmjs.org/:_authToken=npm_secret_token\nWarning DATABASE_URL=postgres://dbuser:dbpassword@example.com/app\nWarning remote=https://oauth-token@example.com/repo.git\nWarning bare npm_abcdefghijklmnopqrstuvwxyz\nWarning bare AIzaabcdefghijklmnopqrstuvwxyz\nWarning {\"Authorization\":\"ApiKey json-apikey-secret\"}" }],
          isError: true,
          timestamp: 2,
        } as any,
      ],
    };
    const summary = buildToolObservationSummary(context);
    assert.ok(summary);
    assert.match(summary.text, /Error: deploy failed/);
    assert.match(summary.text, /REDACTED/);
    assert.doesNotMatch(summary.text, /sk-supersecret/);
    assert.doesNotMatch(summary.text, /sk-anothersecret/);
    assert.doesNotMatch(summary.text, /basic-secret-token/);
    assert.doesNotMatch(summary.text, /anthropic-secret-value/);
    assert.doesNotMatch(summary.text, /whitespace-secret-token/);
    assert.doesNotMatch(summary.text, /npm-provider-token/);
    assert.doesNotMatch(summary.text, /npm_secret_token/);
    assert.doesNotMatch(summary.text, /dbuser:dbpassword/);
    assert.doesNotMatch(summary.text, /json-apikey-secret/);
    assert.doesNotMatch(summary.text, /token-scheme-secret/);
    assert.doesNotMatch(summary.text, /oauth-token/);
    assert.doesNotMatch(summary.text, /npm_abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(summary.text, /AIzaabcdefghijklmnopqrstuvwxyz/);
    assert.ok(summary.failureSignals.includes("tool-result-error"));
  });

  it("scopes tool observation summaries to the current user turn", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "old task", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "old-1", content: [{ type: "text", text: "Error: old failure" }], isError: true, timestamp: 2 } as any,
        { role: "user", content: "new task", timestamp: 3 },
        { role: "toolResult", toolName: "Bash", toolCallId: "new-1", content: [{ type: "text", text: "created new file" }], timestamp: 4 } as any,
      ],
    };
    const summary = buildToolObservationSummary(context);
    assert.equal(summary?.toolResultCount, 1);
    assert.equal(summary?.totalToolResultCount, 1);
    assert.doesNotMatch(summary?.text ?? "", /old failure/);
    assert.match(summary?.text ?? "", /created new file/);
  });

  it("does not treat negated failure counts as failure signals", () => {
    const passing: Context = {
      messages: [
        { role: "user", content: "run tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "0 failed, 50 passed\n0 errors" }], timestamp: 2 } as any,
      ],
    };
    const failing: Context = {
      messages: [
        { role: "user", content: "run tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "2 failed, 48 passed" }], timestamp: 2 } as any,
      ],
    };
    assert.deepEqual(buildToolObservationSummary(passing)?.failureSignals, []);
    assert.ok(buildToolObservationSummary(failing)?.failureSignals.includes("error-output"));
  });

  it("lets config disable tool-loop checkpoints", () => {
    const cfg = { ...DEFAULT_CONFIG, checkpoint: { ...DEFAULT_CONFIG.checkpoint, enabled: false } };
    const context: Context = {
      messages: [
        { role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 1 },
        { role: "toolResult", toolName: "Bash", toolCallId: "call-1", content: [{ type: "text", text: "AssertionError" }], isError: true, timestamp: 2 } as any,
      ],
    };
    const input = {
      alias: "gpt55-glm52-full",
      latestUserText: latestUserText(context, true),
      hasToolResults: true,
      recentToolSummary: buildToolObservationSummary(context),
    };
    assert.deepEqual(chooseAction(cfg, chooseMode(cfg, input), input), { kind: "single", reason: "checkpoint policy disabled for tool-loop continuation" });
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

  it("loads and validates reference timeout/max-token config and env overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-timeout-test-"));
    const oldTimeout = process.env.GSD_MOA_REFERENCE_TIMEOUT_MS;
    const oldMaxTokens = process.env.GSD_MOA_REFERENCE_MAX_TOKENS;
    try {
      writeFileSync(join(dir, "gsd-moa.json"), JSON.stringify({ referenceTimeoutMs: 5000, referenceMaxTokens: 700 }));
      assert.equal(loadConfig("gsd-moa.json", dir).referenceTimeoutMs, 5000);
      assert.equal(loadConfig("gsd-moa.json", dir).referenceMaxTokens, 700);
      process.env.GSD_MOA_REFERENCE_TIMEOUT_MS = "2500";
      process.env.GSD_MOA_REFERENCE_MAX_TOKENS = "600";
      assert.equal(loadConfig("gsd-moa.json", dir).referenceTimeoutMs, 2500);
      assert.equal(loadConfig("gsd-moa.json", dir).referenceMaxTokens, 600);
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, referenceTimeoutMs: 0 }), /referenceTimeoutMs/);
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, referenceMaxTokens: 0 }), /referenceMaxTokens/);
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, fullMoa: { ...DEFAULT_CONFIG.fullMoa, proposers: [{ ...DEFAULT_CONFIG.fullMoa.proposers[0]!, maxTokens: 0 }, DEFAULT_CONFIG.fullMoa.proposers[1]!] } }), /fullMoa\.proposers\.glm52\.maxTokens/);
    } finally {
      if (oldTimeout === undefined) delete process.env.GSD_MOA_REFERENCE_TIMEOUT_MS;
      else process.env.GSD_MOA_REFERENCE_TIMEOUT_MS = oldTimeout;
      if (oldMaxTokens === undefined) delete process.env.GSD_MOA_REFERENCE_MAX_TOKENS;
      else process.env.GSD_MOA_REFERENCE_MAX_TOKENS = oldMaxTokens;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads cached config when the file mtime changes and applies env after cache retrieval", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-config-cache-test-"));
    const configPath = join(dir, "gsd-moa.json");
    const oldTrace = process.env.GSD_MOA_TRACE;
    try {
      resetConfigCache();
      writeFileSync(configPath, JSON.stringify({ referenceTimeoutMs: 5000 }));
      assert.equal(loadConfig("gsd-moa.json", dir).referenceTimeoutMs, 5000);

      writeFileSync(configPath, JSON.stringify({ referenceTimeoutMs: 6000 }));
      const future = new Date(Date.now() + 2000);
      utimesSync(configPath, future, future);
      assert.equal(loadConfig("gsd-moa.json", dir).referenceTimeoutMs, 6000);

      process.env.GSD_MOA_TRACE = "1";
      assert.equal(loadConfig("gsd-moa.json", dir).trace.enabled, true);
      delete process.env.GSD_MOA_TRACE;
      assert.equal(loadConfig("gsd-moa.json", dir).trace.enabled, DEFAULT_CONFIG.trace.enabled);
    } finally {
      if (oldTrace === undefined) delete process.env.GSD_MOA_TRACE;
      else process.env.GSD_MOA_TRACE = oldTrace;
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves route env vars for api keys and header values, and rejects missing ones", () => {
    const oldApi = process.env.GSD_MOA_TEST_API_KEY;
    const oldHeader = process.env.GSD_MOA_TEST_HEADER;
    const oldMissing = process.env.GSD_MOA_TEST_MISSING;
    try {
      process.env.GSD_MOA_TEST_API_KEY = "api-secret";
      process.env.GSD_MOA_TEST_HEADER = "header-secret";
      delete process.env.GSD_MOA_TEST_MISSING;
      assert.equal(resolveConfigValue("$GSD_MOA_TEST_API_KEY", "route apiKey"), "api-secret");
      assert.equal(resolveConfigValue("${GSD_MOA_TEST_HEADER}", "route header x-api-key"), "header-secret");
      const options = streamOptionsForRoute({ provider: "test", model: "m", apiKey: "$GSD_MOA_TEST_API_KEY", headers: { "x-api-key": "$GSD_MOA_TEST_HEADER" } }, { headers: { existing: "1" } });
      assert.equal(options.apiKey, "api-secret");
      assert.deepEqual(options.headers, { existing: "1", "x-api-key": "header-secret" });
      assert.throws(() => resolveConfigValue("$GSD_MOA_TEST_MISSING", "route apiKey"), /GSD_MOA_TEST_MISSING.*route apiKey/);
      assert.throws(() => streamOptionsForRoute({ provider: "test", model: "m", headers: { "x-api-key": "$GSD_MOA_TEST_MISSING" } }), /GSD_MOA_TEST_MISSING.*route header x-api-key/);
    } finally {
      if (oldApi === undefined) delete process.env.GSD_MOA_TEST_API_KEY;
      else process.env.GSD_MOA_TEST_API_KEY = oldApi;
      if (oldHeader === undefined) delete process.env.GSD_MOA_TEST_HEADER;
      else process.env.GSD_MOA_TEST_HEADER = oldHeader;
      if (oldMissing === undefined) delete process.env.GSD_MOA_TEST_MISSING;
      else process.env.GSD_MOA_TEST_MISSING = oldMissing;
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
  it("deletes corrupt and expired cache files and skips empty writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-cache-test-"));
    const cfg = { ...structuredClone(DEFAULT_CONFIG), cache: { enabled: true, dir: join(dir, "cache"), ttlSeconds: 60 } };
    try {
      writeAdvisorCache(cfg, "seed", "seed", usage, dir);
      writeAdvisorCache(cfg, "empty", "   ", usage, dir);
      assert.equal(existsSync(join(cfg.cache.dir, "empty.json")), false);
      const corruptPath = join(cfg.cache.dir, "corrupt.json");
      writeFileSync(corruptPath, "not json", { flag: "w" });
      assert.equal(readCacheByKey(cfg, "corrupt", dir).hit, false);
      assert.equal(existsSync(corruptPath), false);

      const expiredPath = join(cfg.cache.dir, "expired.json");
      writeFileSync(expiredPath, JSON.stringify({ version: 1, createdAt: 1, expiresAt: 1, text: "old" }));
      assert.equal(readCacheByKey(cfg, "expired", dir).hit, false);
      assert.equal(existsSync(expiredPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keys reference cache by effective effort and max token controls", () => {
    const route = DEFAULT_CONFIG.primary;
    const context: Context = { messages: [{ role: "user", content: "same task", timestamp: 1 }] };
    const base = referenceCacheKey(DEFAULT_CONFIG, context, route, "advisor", DEFAULT_CONFIG.prompts.advisorVersion, { effort: "high", maxTokens: 1000 });
    assert.notEqual(base, referenceCacheKey(DEFAULT_CONFIG, context, route, "advisor", DEFAULT_CONFIG.prompts.advisorVersion, { effort: "low", maxTokens: 1000 }));
    assert.notEqual(base, referenceCacheKey(DEFAULT_CONFIG, context, route, "advisor", DEFAULT_CONFIG.prompts.advisorVersion, { effort: "high", maxTokens: 2000 }));

    const cfg = { ...structuredClone(DEFAULT_CONFIG), referenceMaxTokens: 1000 };
    assert.equal(
      advisorCacheKey(cfg, context),
      referenceCacheKey(cfg, context, cfg.reference, "advisor", cfg.prompts.advisorVersion, { effort: "high", maxTokens: 1000 }),
    );
  });

  it("reads advisor cache entries using the default effort and max-token controls", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-moa-advisor-cache-test-"));
    const cfg = { ...structuredClone(DEFAULT_CONFIG), cache: { enabled: true, dir: join(dir, "cache"), ttlSeconds: 60 }, referenceMaxTokens: 1000 };
    const context: Context = { messages: [{ role: "user", content: "same task", timestamp: 1 }] };
    try {
      writeAdvisorCache(cfg, advisorCacheKey(cfg, context), "cached advice", usage, dir);
      assert.equal(readAdvisorCache(cfg, context, dir).hit, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("drops tools, tool calls, tool results, system prompt, and trailing assistant turns for advisor calls", () => {
    const sanitized = sanitizeReferenceContext(context);
    assert.equal(sanitized.systemPrompt, undefined);
    assert.equal(sanitized.tools, undefined);
    assert.equal(sanitized.messages.length, 1);
    assert.equal(sanitized.messages[0]?.role, "user");
    assert.equal((sanitized.messages[0] as any).content, "make a plan");
  });

  it("keeps the latest user message when stripping trailing assistant turns", () => {
    const sanitized = sanitizeReferenceContext({
      messages: [
        { role: "user", content: "<!-- gsd-moa:advisor -->", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "prior answer" }],
          api: "openai-completions",
          provider: "factory-codex",
          model: "gpt-5.5",
          usage,
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "continue the task", timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "text", text: "trailing prefill" }],
          api: "openai-completions",
          provider: "factory-codex",
          model: "gpt-5.5",
          usage,
          stopReason: "stop",
          timestamp: 4,
        },
      ],
    } as Context);
    assert.equal(sanitized.messages.at(-1)?.role, "user");
    assert.deepEqual(sanitized.messages.at(-1), { role: "user", content: "continue the task", timestamp: 3 });
    assert.doesNotMatch(JSON.stringify(sanitized.messages), /trailing prefill/);
  });

  it("returns an empty view if trailing-assistant stripping leaves no genuine user text", () => {
    const sanitized = sanitizeReferenceContext({
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "orphan assistant" }],
        api: "openai-completions",
        provider: "factory-codex",
        model: "gpt-5.5",
        usage,
        stopReason: "stop",
        timestamp: 1,
      }],
    } as Context);
    assert.deepEqual(sanitized.messages, []);
  });
});

describe("single alias stays single on failure continuations", () => {
  it("does not run failure checkpoints for requestedMode=single", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const summary = buildToolObservationSummary({
      messages: [
        { role: "user", content: "fix the build", timestamp: 1 },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "error: build failed with exit code 1" }], isError: true, timestamp: 2 },
      ],
    } as never, cfg.checkpoint.maxToolResults);
    const input = {
      alias: "gpt55-glm52-single",
      latestUserText: "fix the build",
      hasToolResults: true,
      hasFreshMoaMarker: false,
      recentToolSummary: summary,
    };
    const policy = chooseMode(cfg, input);
    const action = chooseAction(cfg, policy, input);
    assert.equal(action.kind, "single");
  });
});
