import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai/compat";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.ts";
import { hasRecentToolResults, latestUserText, sanitizeReferenceContext } from "../src/context.ts";
import { chooseMode, stripMoaMarkers } from "../src/policy.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("mode policy", () => {
  it("maps fixed aliases", () => {
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "review this" }).mode, "single");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-advisor", latestUserText: "typo" }).mode, "advisor");
  });

  it("uses deterministic auto heuristics only between single and advisor", () => {
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-auto", latestUserText: "please plan this phase" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-auto", latestUserText: "fix a typo" }).mode, "single");
  });

  it("honors and strips explicit markers", () => {
    const result = stripMoaMarkers("<!-- gsd-moa:advisor --> do hard review");
    assert.deepEqual(result.markers, ["<!-- gsd-moa:advisor -->"]);
    assert.equal(result.text, "do hard review");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-single", latestUserText: "<!-- gsd-moa:advisor --> review" }).mode, "advisor");
    assert.equal(chooseMode(DEFAULT_CONFIG, { alias: "gpt55-glm52-advisor", latestUserText: "<!-- gsd-moa:off --> review" }).mode, "single");
  });

  it("rejects recursive upstream routes", () => {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, primary: { provider: "gsd-moa", model: "x" } }), /recursion guard/);
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
        api: "openai-responses",
        provider: "openai",
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
