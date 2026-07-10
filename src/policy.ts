import { hasReferenceTimeBudget } from "./time.js";
import type { AliasMode, CheckpointScopesConfig, GsdMoaConfig, MoaAction, MoaMode, PolicyDecision, PolicyInput } from "./types.js";

const ADVISOR_MARKERS = ["<!-- gsd-moa:advisor -->", "<!-- gsd-moa:on -->"];
const FULL_MOA_MARKERS = ["<!-- gsd-moa:full -->", "<!-- gsd-moa:full_moa -->"];
const SINGLE_MARKERS = ["<!-- gsd-moa:single -->", "<!-- gsd-moa:off -->"];

export function stripMoaMarkers(text: string): { text: string; markers: string[] } {
  const markers: string[] = [];
  const stripped = text.replace(/<!--\s*gsd-moa:(advisor|on|full|full_moa|single|off)\s*-->/gi, (_match, mode: string) => {
    markers.push(`<!-- gsd-moa:${mode.toLowerCase()} -->`);
    return "";
  });
  return { text: stripped.trim(), markers };
}

export function chooseMode(config: GsdMoaConfig, input: PolicyInput): PolicyDecision {
  const alias = config.aliases[input.alias];
  if (!alias) {
    throw new Error(`Unknown ${input.alias} model alias for gsd-moa provider`);
  }

  const { text: strippedText, markers } = stripMoaMarkers(input.latestUserText);
  const requestedMode = alias.mode;

  if (markers.some((m) => SINGLE_MARKERS.includes(m))) {
    return decision(requestedMode, "single", "explicit single/off marker", strippedText, markers);
  }
  if (markers.some((m) => ADVISOR_MARKERS.includes(m))) {
    return decision(requestedMode, "advisor", "explicit advisor marker", strippedText, markers);
  }
  if (markers.some((m) => FULL_MOA_MARKERS.includes(m))) {
    return decision(requestedMode, "full_moa", "explicit full MoA marker", strippedText, markers);
  }

  if (requestedMode === "single") return decision(requestedMode, "single", "single alias", strippedText, markers);
  if (requestedMode === "advisor") return decision(requestedMode, "advisor", "advisor alias", strippedText, markers);
  if (requestedMode === "full_moa") return decision(requestedMode, "full_moa", "full MoA alias", strippedText, markers);

  // Tool-loop continuations favor single to avoid extra latency while final model is handling tool results.
  if (input.hasToolResults) return decision(requestedMode, "single", "tool-loop continuation", strippedText, markers);

  const normalized = strippedText.toLowerCase();
  const singleHit = findKeyword(normalized, config.auto.singleKeywords);
  if (singleHit) return decision(requestedMode, "single", `single keyword: ${singleHit}`, strippedText, markers);

  const fullMoaHit = findKeyword(normalized, config.auto.fullMoaKeywords);
  if (fullMoaHit && config.fullMoa.enabled) {
    return decision(requestedMode, "full_moa", `full MoA keyword: ${fullMoaHit}`, strippedText, markers);
  }
  if (fullMoaHit) {
    return decision(requestedMode, "advisor", `full MoA keyword: ${fullMoaHit}; fullMoa disabled, advisor fallback`, strippedText, markers);
  }

  const advisorHit = findKeyword(normalized, config.auto.advisorKeywords);
  if (advisorHit) return decision(requestedMode, "advisor", `advisor keyword: ${advisorHit}`, strippedText, markers);

  return decision(requestedMode, config.auto.defaultMode, "auto default", strippedText, markers);
}

export function chooseAction(config: GsdMoaConfig, policy: PolicyDecision, input: PolicyInput): MoaAction {
  const explicitAdvisor = policy.markers.some((m) => ADVISOR_MARKERS.includes(m));
  const explicitFull = policy.markers.some((m) => FULL_MOA_MARKERS.includes(m));
  const explicitSingle = policy.markers.some((m) => SINGLE_MARKERS.includes(m));
  const explicitFreshMoaMarker = Boolean(input.hasFreshMoaMarker && (explicitAdvisor || explicitFull));
  const summary = input.recentToolSummary;
  const effectiveScopes = input.effectiveScopes ?? { ...config.checkpoint.scopes, ...(config.aliases[input.alias]?.checkpointScopes ?? {}) };

  if (explicitSingle) return { kind: "single", reason: policy.reason };

  if (!explicitFreshMoaMarker && shouldSuppressForReserve(config, input)) {
    return { kind: "single", reason: `time reserve: ${Math.ceil((input.timeState?.remainingMs ?? 0) / 1000)}s remaining` };
  }

  if (!config.checkpoint.enabled && input.hasToolResults && !explicitFreshMoaMarker) {
    return { kind: "single", reason: "checkpoint policy disabled for tool-loop continuation" };
  }

  if (!input.hasToolResults) {
    if (policy.mode === "advisor" || policy.mode === "full_moa") {
      return scopedRun(effectiveScopes, {
        kind: "run",
        mode: policy.mode,
        scope: explicitAdvisor || explicitFull ? "explicit" : "initial",
        reason: policy.reason,
      });
    }
    return { kind: "single", reason: policy.reason };
  }

  if (explicitFreshMoaMarker) {
    return {
      kind: "run",
      mode: explicitFull && config.fullMoa.enabled ? "full_moa" : "advisor",
      scope: "explicit",
      reason: `${policy.reason}; fresh marker on tool continuation`,
      observationSummary: summary,
    };
  }

  const rescueEligibleByMode = policy.requestedMode !== "single" || explicitAdvisor || explicitFull;
  if (summary?.trailingFailureStreak && summary.trailingFailureStreak >= config.checkpoint.rescue.consecutiveFailures && rescueEligibleByMode) {
    const rescueSignatureCount = summary.repeatedFailureSignatureCount ?? 0;
    if (summary.repeatedFailureSignature && rescueSignatureCount >= config.checkpoint.rescue.repeatedSignatureMin) {
      if ((input.advisorInjectionCount ?? 0) >= config.checkpoint.rescue.maxPerTask) {
        return rescueSuppressed("maxPerTask", summary, input);
      }
      if ((input.toolResultsSinceLastInjection ?? Number.MAX_SAFE_INTEGER) < config.checkpoint.rescue.cooldownToolResults) {
        return rescueSuppressed("cooldown", summary, input);
      }
      return scopedRun(effectiveScopes, {
        kind: "run",
        mode: "advisor",
        scope: "failure",
        reason: `MoA rescue: ${summary.trailingFailureStreak} consecutive failures (${summary.repeatedFailureSignature})`,
        observationSummary: summary,
      });
    }
  }

  const driftEligible = policy.mode === "advisor" || policy.mode === "full_moa" || policy.requestedMode === "auto";
  if (summary && summary.totalToolResultCount > 0 && summary.totalToolResultCount % config.checkpoint.driftToolResultThreshold === 0 && driftEligible) {
    const baseMode = policy.mode === "full_moa" && config.fullMoa.enabled ? "full_moa" : "advisor";
    const mode = config.timeAware.downgradeInValidate && input.timeState?.phase === "validate" && baseMode === "full_moa" ? "advisor" : baseMode;
    return scopedRun(effectiveScopes, {
      kind: "run",
      mode,
      scope: "drift",
      reason: mode !== baseMode
        ? `MoA drift checkpoint after ${summary.totalToolResultCount} total tool results; downgraded to advisor during validate phase`
        : `MoA drift checkpoint after ${summary.totalToolResultCount} total tool results`,
      observationSummary: summary,
    });
  }

  return { kind: "single", reason: "tool-loop continuation without checkpoint signal" };
}

function scopedRun(effectiveScopes: CheckpointScopesConfig, action: Extract<MoaAction, { kind: "run" }>): MoaAction {
  if (action.scope === "explicit") return action;
  return effectiveScopes[action.scope] ? action : { kind: "single", reason: `scope ${action.scope} disabled` };
}

function rescueSuppressed(reason: "maxPerTask" | "cooldown", summary: NonNullable<PolicyInput["recentToolSummary"]>, input: PolicyInput): MoaAction {
  const detail = reason === "maxPerTask"
    ? `maxPerTask reached (${input.advisorInjectionCount ?? 0})`
    : `cooldown active (${input.toolResultsSinceLastInjection ?? Number.MAX_SAFE_INTEGER} tool results since last injection)`;
  return {
    kind: "single",
    reason: `MoA rescue suppressed: ${detail}`,
    observationSummary: summary,
    rescueSuppressionReason: reason,
  };
}

function shouldSuppressForReserve(config: GsdMoaConfig, input: PolicyInput): boolean {
  if (!input.timeState) return false;
  if (!hasReferenceTimeBudget(config.timeAware, input.timeState)) return true;
  return false;
}

const KEYWORD_INFLECTIONS: Record<string, string[]> = {
  plan: ["plan", "plans", "planned", "planning"],
  review: ["review", "reviews", "reviewed", "reviewing"],
  audit: ["audit", "audits", "audited", "auditing"],
  verify: ["verify", "verifies", "verified", "verifying", "verification"],
  debug: ["debug", "debugs", "debugged", "debugging"],
  format: ["format", "formats", "formatted", "formatting"],
  rename: ["rename", "renames", "renamed", "renaming"],
  edit: ["edit", "edits", "edited", "editing"],
  critique: ["critique", "critiques", "critiqued", "critiquing"],
  model: ["model", "models", "modeled", "modelled", "modeling", "modelling"],
  requirement: ["requirement", "requirements"],
  requirements: ["requirement", "requirements"],
  architecture: ["architecture", "architectures"],
  milestone: ["milestone", "milestones"],
  typo: ["typo", "typos"],
};

function findKeyword(text: string, keywords: string[]): string | undefined {
  return keywords.find((keyword) => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return false;
    const words = normalized.split(/\s+/);
    const finalWord = words.pop()!;
    const prefix = words.length
      ? `${words.map((word) => escapeRegex(word)).join("\\s+")}\\s+`
      : "";
    const variants = KEYWORD_INFLECTIONS[finalWord] ?? [finalWord];
    const alternatives = variants
      .sort((left, right) => right.length - left.length)
      .map(escapeRegex);
    return new RegExp(`(?<![\\p{L}\\p{N}_])${prefix}(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decision(
  requestedMode: AliasMode,
  mode: MoaMode,
  reason: string,
  strippedText: string,
  markers: string[],
): PolicyDecision {
  return { requestedMode, mode, reason, strippedText, markers };
}
