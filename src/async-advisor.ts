import { createHash } from "node:crypto";
import type { Context, Model, SimpleStreamOptions, Api, Usage } from "./pi-compat.js";
import { runAdvisor } from "./advisor.js";
import { conversationIdentity, redactSensitiveText } from "./context.js";
import { ReferenceCallError, type ReferenceCallFailureDetails } from "./reference-call.js";
import type { AdvisorResult, GsdMoaConfig, MoaAction, PolicyDecision, TimeState } from "./types.js";
import type { UpstreamClient } from "./upstream.js";
import { addUsage } from "./usage.js";

interface PendingAdvisor {
  key: string;
  createdAt: number;
  expiresAt: number;
  settledRetentionMs: number;
  controller: AbortController;
  settledAt?: number;
  result?: AdvisorResult;
  error?: string;
  failureDetails?: ReferenceCallFailureDetails;
  rolledOff?: boolean;
  generation: number;
}

export interface AsyncAdvisorDecision {
  status: "fired" | "pending" | "injected" | "failed";
  advisor?: AdvisorResult;
  ageMs?: number;
  error?: string;
  failureDetails?: ReferenceCallFailureDetails;
}

const MAX_PENDING_ADVISORS = 64;
const MAX_ROLLED_OFF_ACCOUNTING = 64;
const pendingAdvisors = new Map<string, PendingAdvisor>();
const evictedAdvisors: Array<{ key: string; entry: PendingAdvisor; injectable: boolean }> = [];
const rolledOffUsageByKey = new Map<string, Usage>();
let unattributedRolledOffUsage: Usage | undefined;
let asyncAdvisorGeneration = 0;

export function resetAsyncAdvisor(): void {
  asyncAdvisorGeneration += 1;
  for (const entry of pendingAdvisors.values()) entry.controller.abort();
  for (const { entry } of evictedAdvisors) entry.controller.abort();
  pendingAdvisors.clear();
  evictedAdvisors.length = 0;
  rolledOffUsageByKey.clear();
  unattributedRolledOffUsage = undefined;
}

export function asyncAdvisorPendingCount(): number {
  return pendingAdvisors.size;
}

/** Process-level accounting that could no longer be safely attributed to a returning session. */
export function asyncAdvisorUnattributedUsage(): Usage | undefined {
  return unattributedRolledOffUsage;
}

export function maybeUseAsyncAdvisor(
  config: GsdMoaConfig,
  model: Model<Api>,
  context: Context,
  policy: PolicyDecision,
  action: MoaAction,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  timeState?: TimeState,
): AsyncAdvisorDecision | undefined {
  if (!config.asyncAdvisor.enabled) return undefined;
  if (action.kind !== "run" || action.mode !== "advisor") return undefined;
  if (action.scope !== "failure" && action.scope !== "drift") return undefined;

  const key = sessionKey(model.id, context, options?.sessionId);
  const now = Date.now();
  const rolledOffUsage = rolledOffUsageByKey.get(key);
  if (rolledOffUsage) {
    const usage = rolledOffUsage;
    rolledOffUsageByKey.delete(key);
    if (!pendingAdvisors.has(key)) fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return {
      status: "failed",
      error: "accounting for async advisor work evicted by the global capacity cap",
      failureDetails: {
        key: "async-advisor-capacity-rollover",
        provider: "gsd-moa",
        model: "evicted-async-advisor",
        usage,
        cacheHit: false,
        durationMs: 0,
      },
    };
  }
  const evicted = takeSettledEviction(key);
  if (evicted) {
    if (!pendingAdvisors.has(key)) fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    const ageMs = now - evicted.entry.createdAt;
    const stale = asyncAdvisorResultExpired(evicted.entry, now);
    if (evicted.injectable && evicted.entry.result && !stale) {
      return { status: "injected", advisor: evicted.entry.result, ageMs };
    }
    const error = evicted.entry.error ?? (stale
      ? "async advisor result expired before consumption"
      : "async advisor request expired before completion");
    const failureDetails = evicted.entry.failureDetails ?? (evicted.entry.result ? {
      key: evicted.entry.result.key,
      provider: config.reference.provider,
      model: config.reference.model,
      usage: evicted.entry.result.usage,
      cacheHit: evicted.entry.result.cacheHit,
      durationMs: evicted.entry.result.durationMs,
      effort: evicted.entry.result.effort,
    } : undefined);
    return { status: "failed", ageMs, error, failureDetails };
  }
  // Consume settled work for this session before sweeping stale in-flight work;
  // otherwise its usage/failure accounting disappears at the pending timeout.
  let current = pendingAdvisors.get(key);
  if (current?.result) {
    pendingAdvisors.delete(key);
    const ageMs = now - current.createdAt;
    const stale = asyncAdvisorResultExpired(current, now);
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    if (stale) {
      return {
        status: "failed",
        ageMs,
        error: "async advisor result expired before consumption",
        failureDetails: {
          key: current.result.key,
          provider: config.reference.provider,
          model: config.reference.model,
          usage: current.result.usage,
          cacheHit: current.result.cacheHit,
          durationMs: current.result.durationMs,
          effort: current.result.effort,
        },
      };
    }
    return { status: "injected", advisor: current.result, ageMs };
  }

  if (current?.error) {
    pendingAdvisors.delete(key);
    const ageMs = now - current.createdAt;
    const error = current.error;
    const failureDetails = current.failureDetails;
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return { status: "failed", ageMs, error, failureDetails };
  }

  sweepPendingAdvisors(now);
  current = pendingAdvisors.get(key);
  if (!current) {
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return { status: "fired" };
  }
  return { status: "pending" };
}

function fireAdvisor(
  config: GsdMoaConfig,
  key: string,
  context: Context,
  policy: PolicyDecision,
  action: Extract<MoaAction, { kind: "run" }>,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  timeState?: TimeState,
): void {
  const snapshot = structuredClone(context);
  const controller = new AbortController();
  const createdAt = Date.now();
  const entry: PendingAdvisor = {
    key,
    createdAt,
    expiresAt: createdAt + config.asyncAdvisor.maxPendingMs,
    settledRetentionMs: config.asyncAdvisor.maxPendingMs,
    controller,
    generation: asyncAdvisorGeneration,
  };
  pendingAdvisors.set(key, entry);
  while (pendingAdvisors.size > MAX_PENDING_ADVISORS) {
    // Preserve the request just inserted. If old settled results fill the cap,
    // evict the oldest one rather than immediately aborting every new session.
    const oldestKey = [...pendingAdvisors.keys()].find((candidateKey) => candidateKey !== key) ?? key;
    evictPendingAdvisor(oldestKey);
  }
  const signals = [options?.signal, controller.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  const backgroundOptions: SimpleStreamOptions = {
    ...options,
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  };
  void runAdvisor(config, snapshot, policy, upstream, backgroundOptions, undefined, action.observationSummary, timeState)
    .then((result) => {
      entry.result = result;
      entry.settledAt = Date.now();
      if (entry.rolledOff) preserveRolledOffUsage(entry);
    })
    .catch((error) => {
      entry.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
      if (error instanceof ReferenceCallError) entry.failureDetails = error.details;
      entry.settledAt = Date.now();
      if (entry.rolledOff) preserveRolledOffUsage(entry);
    });
}

function asyncAdvisorResultExpired(entry: PendingAdvisor, now: number): boolean {
  if (entry.settledAt === undefined) return false;
  return entry.settledAt > entry.expiresAt || now - entry.settledAt > entry.settledRetentionMs;
}

function sweepPendingAdvisors(now: number): void {
  for (const [key, entry] of pendingAdvisors) {
    if (entry.settledAt === undefined && now > entry.expiresAt) evictPendingAdvisor(key);
  }
}

function evictPendingAdvisor(key: string): void {
  const entry = pendingAdvisors.get(key);
  if (!entry) return;
  pendingAdvisors.delete(key);
  evictedAdvisors.push({ key, entry, injectable: entry.settledAt !== undefined && entry.result !== undefined });
  while (evictedAdvisors.length > MAX_PENDING_ADVISORS) {
    const removed = evictedAdvisors.shift();
    if (!removed) break;
    removed.entry.rolledOff = true;
    if (removed.entry.settledAt !== undefined) preserveRolledOffUsage(removed.entry);
  }
  entry.controller.abort();
}

function preserveRolledOffUsage(entry: PendingAdvisor): void {
  if (entry.generation !== asyncAdvisorGeneration) return;
  const usage = entry.failureDetails?.usage ?? entry.result?.usage;
  if (!usage) return;
  const existing = rolledOffUsageByKey.get(entry.key);
  rolledOffUsageByKey.delete(entry.key);
  rolledOffUsageByKey.set(entry.key, addUsage(existing, usage));
  while (rolledOffUsageByKey.size > MAX_ROLLED_OFF_ACCOUNTING) {
    const oldestKey = rolledOffUsageByKey.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestUsage = rolledOffUsageByKey.get(oldestKey);
    rolledOffUsageByKey.delete(oldestKey);
    unattributedRolledOffUsage = addUsage(unattributedRolledOffUsage, oldestUsage);
  }
}

function takeSettledEviction(key: string): { entry: PendingAdvisor; injectable: boolean } | undefined {
  const index = evictedAdvisors.findIndex((candidate) => candidate.key === key && candidate.entry.settledAt !== undefined);
  if (index < 0) return undefined;
  return evictedAdvisors.splice(index, 1)[0];
}

function sessionKey(alias: string, context: Context, sessionId?: string): string {
  return createHash("sha256").update(`${alias}\n${conversationIdentity(context, sessionId)}`).digest("hex");
}
