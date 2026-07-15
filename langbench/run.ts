/**
 * Langbench runner: item × input-language × policy × rollout sweep against an
 * OpenAI-compatible chat endpoint (Z.ai GLM-5.2 or the local q27 Qwen server).
 *
 * The reasoning-language policy note is injected as a system message using the
 * SAME text the gsd-moa provider injects on Terminal-Bench arms, so the two
 * task families share one treatment definition.
 *
 * No containers needed; safe to run anywhere with network access to the
 * endpoint. Results append to a JSONL file; reruns skip already-recorded rows,
 * so the sweep is resumable.
 *
 * Example:
 *   node --import tsx langbench/run.ts \
 *     --items langbench/items.jsonl --out langbench/results-glm.jsonl \
 *     --base-url https://api.z.ai/api/coding/paas/v4 --model glm-5.2 \
 *     --api-key-env ZAI_API_KEY --policies off,en,zh,free,mixed --langs en,zh \
 *     --k 4 --concurrency 4 --allow-exec
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildLanguagePolicyNote } from "../src/lang-policy.js";
import type { LangPolicyId } from "../src/types.js";
import { computeLangStats } from "./lang-stats.ts";
import type { LangbenchItem } from "./generate.ts";

interface ResultRow {
  key: string;
  itemId: string;
  family: string;
  inputLang: "en" | "zh";
  policy: LangPolicyId;
  rollout: number;
  correct: boolean;
  extracted: string | null;
  expected: string;
  cjkFrac: number;
  switches: number;
  thinkingCjkFrac: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  finishReason: string | null;
  error?: string;
  text: string;
  thinking?: string;
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) & 0x7fffffff; // some endpoints reject seeds outside int32
}

function extractAnswer(text: string): string | null {
  const matches = [...text.matchAll(/ANSWER\s*[:：]\s*(.+)/gi)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return last[1]!.trim().replace(/[*`'"。.\s]+$/g, "").replace(/^[*`'"]+/g, "").trim();
}

function normalizeExact(value: string): string {
  return value.replace(/[\s,，]/g, "").toUpperCase();
}

function extractPythonBlock(text: string): string | null {
  const matches = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)];
  const withDef = matches.map((m) => m[1]!).filter((code) => /def\s+\w+\s*\(/.test(code));
  return withDef[withDef.length - 1] ?? null;
}

function verifyPython(candidate: string, tests: string, timeoutMs: number): { correct: boolean; error?: string } {
  try {
    const out = execFileSync("python3", ["-c", `${candidate}\n\n${tests}`], {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { correct: out.includes("OK") };
  } catch (error) {
    return { correct: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

const RETRYABLE = /HTTP (429|500|502|503|504)|fetch failed/;

async function callModelWithRetry(
  attempts: number,
  ...args: Parameters<typeof callModel>
): Promise<Awaited<ReturnType<typeof callModel>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await callModel(...args);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!RETRYABLE.test(message) || attempt === attempts - 1) throw error;
      const delayMs = Math.min(120_000, 15_000 * 2 ** attempt) + Math.floor(Math.random() * 5_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function callModel(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  system: string | undefined,
  user: string,
  temperature: number,
  maxTokens: number,
  seed: number,
  timeoutMs: number,
): Promise<{ text: string; thinking?: string; promptTokens: number | null; completionTokens: number | null; finishReason: string | null; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // Z.ai sheds Node's default UA with misleading 429/1305 "overloaded"
        // errors (A/B-verified 2026-07-15); any explicit client UA is admitted.
        "user-agent": "gsd-moa-langbench/0.1",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        temperature,
        max_tokens: maxTokens,
        seed,
        stream: false,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      thinking: choice?.message?.reasoning_content || undefined,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      finishReason: choice?.finish_reason ?? null,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const itemsPath = arg("--items", "langbench/items.jsonl")!;
  const outPath = arg("--out")!;
  const baseUrl = arg("--base-url")!;
  const model = arg("--model")!;
  const apiKeyEnv = arg("--api-key-env");
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new Error(`env var ${apiKeyEnv} is not set`);
  const policies = (arg("--policies", "off,en,zh,free,mixed")!.split(",") as LangPolicyId[]);
  const langs = arg("--langs", "en,zh")!.split(",") as Array<"en" | "zh">;
  const k = Number(arg("--k", "4"));
  const temperature = Number(arg("--temperature", "0.6"));
  const maxTokens = Number(arg("--max-tokens", "4096"));
  const concurrency = Number(arg("--concurrency", "4"));
  const timeoutMs = Number(arg("--timeout-ms", "300000"));
  const allowExec = process.argv.includes("--allow-exec");
  const yokeSchedule = arg("--yoke-schedule");
  const retries = Number(arg("--retries", "5"));
  // Minimum spacing between call STARTS across all workers. Subscription
  // endpoints (Z.ai coding plan) throttle on burst concurrency, not volume.
  const delayMs = Number(arg("--delay-ms", "0"));

  const items: LangbenchItem[] = readFileSync(itemsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LangbenchItem);

  const done = new Set<string>();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as ResultRow;
        // API-error rows (no model text) stay pending so a rerun retries them.
        if (row.text || !row.error) done.add(row.key);
      } catch {
        // tolerate a truncated trailing line from a killed run
      }
    }
  }

  const work: Array<() => Promise<void>> = [];
  let completed = 0;
  let errors = 0;
  for (const item of items) {
    for (const lang of langs) {
      for (const policy of policies) {
        for (let rollout = 0; rollout < k; rollout++) {
          const key = `${item.id}|${lang}|${policy}|${rollout}`;
          if (done.has(key)) continue;
          work.push(async () => {
            const note = buildLanguagePolicyNote({ langPolicy: { policy, yokeSchedule } });
            const row: ResultRow = {
              key,
              itemId: item.id,
              family: item.family,
              inputLang: lang,
              policy,
              rollout,
              correct: false,
              extracted: null,
              expected: item.answer,
              cjkFrac: 0,
              switches: 0,
              thinkingCjkFrac: null,
              promptTokens: null,
              completionTokens: null,
              latencyMs: 0,
              finishReason: null,
              text: "",
            };
            try {
              const result = await callModelWithRetry(
                retries, baseUrl, apiKey, model, note, item.prompt[lang], temperature, maxTokens,
                hashSeed(key), timeoutMs,
              );
              row.text = result.text;
              row.thinking = result.thinking;
              row.promptTokens = result.promptTokens;
              row.completionTokens = result.completionTokens;
              row.finishReason = result.finishReason;
              row.latencyMs = result.latencyMs;
              const analyzed = computeLangStats([result.thinking ?? "", result.text].join("\n"));
              row.cjkFrac = analyzed.cjkFrac;
              row.switches = analyzed.switches;
              row.thinkingCjkFrac = result.thinking ? computeLangStats(result.thinking).cjkFrac : null;
              if (item.verify === "exact") {
                row.extracted = extractAnswer(result.text);
                row.correct = row.extracted !== null && normalizeExact(row.extracted) === normalizeExact(item.answer);
              } else if (item.verify === "python") {
                const candidate = extractPythonBlock(result.text);
                row.extracted = candidate ? "<python block>" : null;
                if (!allowExec) {
                  row.error = "python verification skipped (pass --allow-exec)";
                } else if (candidate && item.tests) {
                  const verdict = verifyPython(candidate, item.tests, 10_000);
                  row.correct = verdict.correct;
                  if (verdict.error) row.error = verdict.error;
                }
              }
            } catch (error) {
              row.error = error instanceof Error ? error.message.slice(0, 500) : String(error);
              errors += 1;
            }
            appendFileSync(outPath, `${JSON.stringify(row)}\n`);
            completed += 1;
            if (completed % 20 === 0) {
              console.log(`${completed}/${work.length} done (${errors} errors)`);
            }
          });
        }
      }
    }
  }

  console.log(`items=${items.length} langs=${langs.join("/")} policies=${policies.join("/")} k=${k} → ${work.length} calls pending (${done.size} already recorded)`);

  let cursor = 0;
  let nextStartAt = 0;
  const paceThenTake = async (): Promise<(() => Promise<void>) | undefined> => {
    if (cursor >= work.length) return undefined;
    const task = work[cursor++]!;
    if (delayMs > 0) {
      const wait = Math.max(0, nextStartAt - Date.now());
      nextStartAt = Date.now() + wait + delayMs;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return task;
  };
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let task = await paceThenTake(); task; task = await paceThenTake()) {
      await task();
    }
  });
  await Promise.all(workers);
  console.log(`finished: ${completed} new rows, ${errors} errors → ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
