import { createHash } from "node:crypto";
import type { Context, Model, SimpleStreamOptions, Api } from "./pi-compat.js";
import { runAdvisor } from "./advisor.js";
import { rawMessageText, redactSensitiveText } from "./context.js";
import type { AdvisorResult, GsdMoaConfig, MoaAction, PolicyDecision, TimeState } from "./types.js";
import type { UpstreamClient } from "./upstream.js";

interface PendingAdvisor {
  createdAt: number;
  settledAt?: number;
  result?: AdvisorResult;
  error?: string;
}

export interface AsyncAdvisorDecision {
  status: "fired" | "pending" | "injected" | "failed";
  advisor?: AdvisorResult;
  ageMs?: number;
  error?: string;
}

const pendingAdvisors = new Map<string, PendingAdvisor>();

export function resetAsyncAdvisor(): void {
  pendingAdvisors.clear();
}

export function asyncAdvisorPendingCount(): number {
  return pendingAdvisors.size;
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

  const key = sessionKey(model.id, context);
  const now = Date.now();
  const entry = pendingAdvisors.get(key);
  if (entry && now - entry.createdAt > config.asyncAdvisor.maxPendingMs) {
    pendingAdvisors.delete(key);
  }

  const current = pendingAdvisors.get(key);
  if (!current) {
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return { status: "fired" };
  }

  if (current.result) {
    pendingAdvisors.delete(key);
    const ageMs = now - current.createdAt;
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return { status: "injected", advisor: current.result, ageMs };
  }

  if (current.error) {
    pendingAdvisors.delete(key);
    const ageMs = now - current.createdAt;
    const error = current.error;
    fireAdvisor(config, key, context, policy, action, upstream, options, timeState);
    return { status: "failed", ageMs, error };
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
  const entry: PendingAdvisor = { createdAt: Date.now() };
  pendingAdvisors.set(key, entry);
  void runAdvisor(config, snapshot, policy, upstream, options, undefined, action.observationSummary, timeState)
    .then((result) => {
      entry.result = result;
      entry.settledAt = Date.now();
    })
    .catch((error) => {
      entry.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
      entry.settledAt = Date.now();
    });
}

function sessionKey(alias: string, context: Context): string {
  return createHash("sha256").update(`${alias}\n${firstUserMessageText(context)}`).digest("hex");
}

function firstUserMessageText(context: Context): string {
  const first = context.messages.find((message) => message.role === "user");
  return first ? rawMessageText(first) : "";
}
