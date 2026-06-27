import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context, Usage } from "@earendil-works/pi-ai/compat";
import { assistantText, messageText } from "./context.js";
import type { GsdMoaConfig } from "./types.js";

interface CacheEnvelope {
  version: 1;
  createdAt: number;
  expiresAt: number;
  text: string;
  usage?: Usage;
}

export interface AdvisorCacheHit {
  hit: true;
  key: string;
  text: string;
  usage?: Usage;
}

export interface AdvisorCacheMiss {
  hit: false;
  key: string;
  path: string;
}

export type AdvisorCacheResult = AdvisorCacheHit | AdvisorCacheMiss;

export function advisorCacheKey(config: GsdMoaConfig, context: Context): string {
  const payload = {
    promptVersion: config.prompts.advisorVersion,
    reference: {
      provider: config.reference.provider,
      model: config.reference.model,
      api: config.reference.api,
      baseUrl: config.reference.baseUrl,
    },
    taskDigest: normalizeContext(context),
    auto: config.auto,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function readAdvisorCache(config: GsdMoaConfig, context: Context, cwd = process.cwd()): AdvisorCacheResult {
  const key = advisorCacheKey(config, context);
  const path = cachePath(config, key, cwd);
  if (!config.cache.enabled || !existsSync(path)) return { hit: false, key, path };

  try {
    const envelope = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
    if (envelope.version !== 1 || envelope.expiresAt < Date.now()) return { hit: false, key, path };
    return { hit: true, key, text: envelope.text, usage: envelope.usage };
  } catch {
    return { hit: false, key, path };
  }
}

export function writeAdvisorCache(
  config: GsdMoaConfig,
  key: string,
  text: string,
  usage: Usage | undefined,
  cwd = process.cwd(),
): void {
  if (!config.cache.enabled) return;
  const path = cachePath(config, key, cwd);
  mkdirSync(resolve(cwd, config.cache.dir), { recursive: true });
  const envelope: CacheEnvelope = {
    version: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.cache.ttlSeconds * 1000,
    text,
    usage,
  };
  writeFileSync(path, JSON.stringify(envelope, null, 2));
}

function cachePath(config: GsdMoaConfig, key: string, cwd: string): string {
  return join(resolve(cwd, config.cache.dir), `${key}.json`);
}

function normalizeContext(context: Context): string {
  return [context.systemPrompt ? `system:${context.systemPrompt}` : "", context.messages
    .slice(-12)
    .map((msg) => {
      if (msg.role === "user") return `user:${messageText(msg)}`;
      if (msg.role === "assistant") return `assistant:${assistantText(msg)}`;
      return `tool:${msg.toolName}:${msg.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n")}`;
    })
    .join("\n---\n")]
    .filter(Boolean)
    .join("\n===\n")
    .replace(/\s+/g, " ")
    .trim();
}
