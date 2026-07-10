import { createHash } from "node:crypto";
import type { Context } from "./pi-compat.js";
import { conversationIdentity, hasGenuineTaskUser, hasStableConversationIdentity, redactSensitiveText } from "./context.js";
import type { SessionStateSummary } from "./session-state.js";
import type { MoaAction, PolicyDecision, TimeAwareConfig, TimeState, ToolObservationSummary } from "./types.js";
import { hasReferenceTimeBudget } from "./time.js";

// Two checkpoint types for each of the 512 session identities retained by the
// host identity cache. Exact LRU state avoids permanent probabilistic saturation.
const MAX_TYPED_CHECKPOINT_ENTRIES = 1_024;
const typedCheckpointLedger = new Map<string, number>();
const typedCheckpointReservations = new Set<string>();

export interface TypedCheckpointDecision {
  action: MoaAction;
  injectStrategyNote: boolean;
  ledgerKey?: string;
}

export function chooseTypedCheckpoint(
  enabled: boolean,
  alias: string,
  context: Context,
  policy: PolicyDecision,
  baseAction: MoaAction,
  hasToolResults: boolean,
  sessionState: SessionStateSummary,
  observationSummary: ToolObservationSummary | undefined,
  timeAwareConfig: TimeAwareConfig,
  timeState: TimeState | undefined,
  sessionId?: string,
): TypedCheckpointDecision {
  if (!enabled || policy.markers.length > 0) return { action: baseAction, injectStrategyNote: false };

  if (!hasToolResults) {
    if (!hasGenuineTaskUser(context)) {
      return {
        action: {
          ...baseAction,
          typedCheckpoint: {
            type: "strategy",
            status: "suppressed",
            mode: "deterministic-note",
            reason: "no genuine task user after compaction",
          },
        },
        injectStrategyNote: false,
      };
    }
    const ledgerKey = typedCheckpointLedgerKey(alias, context, "strategy", sessionId);
    if (hasRecordedTypedCheckpoint(ledgerKey)) {
      return {
        action: {
          ...baseAction,
          typedCheckpoint: {
            type: "strategy",
            status: "suppressed",
            mode: "deterministic-note",
            reason: "maxPerTask reached (1)",
          },
        },
        injectStrategyNote: false,
        ledgerKey,
      };
    }
    return {
      action: {
        ...baseAction,
        typedCheckpoint: {
          type: "strategy",
          status: "fired",
          mode: "deterministic-note",
          reason: "M3 initial strategy contract",
        },
      },
      injectStrategyNote: true,
      ledgerKey,
    };
  }

  if (!(sessionState.filesModified && sessionState.verifierRan && sessionState.lastVerifierPassed === false && sessionState.lastVerifierHadPrecedingMutation === true && sessionState.lastVerifierCommandClass)) {
    return { action: baseAction, injectStrategyNote: false };
  }
  if (!hasStableConversationIdentity(context, sessionId)) {
    return {
      action: {
        ...baseAction,
        typedCheckpoint: {
          type: "verify_failure",
          status: "suppressed",
          mode: "advisor",
          reason: "stable task identity unavailable after compaction",
        },
      },
      injectStrategyNote: false,
    };
  }

  const typedObservationSummary = observationSummary ? enrichVerifyFailureSummary(observationSummary, sessionState) : undefined;
  const ledgerKey = typedCheckpointLedgerKey(alias, context, "verify_failure", sessionId);
  if (timeState && !hasReferenceTimeBudget(timeAwareConfig, timeState)) {
    return {
      action: {
        ...baseAction,
        typedCheckpoint: {
          type: "verify_failure",
          status: "suppressed",
          mode: "advisor",
          reason: "insufficient reference time budget",
        },
      },
      injectStrategyNote: false,
      ledgerKey,
    };
  }

  if (hasRecordedTypedCheckpoint(ledgerKey)) {
    return {
      action: {
        ...baseAction,
        typedCheckpoint: {
          type: "verify_failure",
          status: "suppressed",
          mode: "advisor",
          reason: "maxPerTask reached (1)",
        },
      },
      injectStrategyNote: false,
      ledgerKey,
    };
  }

  return {
    action: {
      kind: "run",
      mode: "advisor",
      scope: "failure",
      reason: "M3 verify_failure checkpoint: diagnose the failed verifier and propose one discriminating next command",
      observationSummary: typedObservationSummary,
      typedCheckpoint: {
        type: "verify_failure",
        status: "fired",
        mode: "advisor",
        reason: "latest verifier after the final successful mutation failed",
      },
    },
    injectStrategyNote: false,
    ledgerKey,
  };
}

export function reserveTypedCheckpoint(key: string): boolean {
  if (hasRecordedTypedCheckpoint(key) || typedCheckpointReservations.has(key)) return false;
  if (typedCheckpointReservations.size >= MAX_TYPED_CHECKPOINT_ENTRIES) return false;
  typedCheckpointReservations.add(key);
  return true;
}

export function releaseTypedCheckpointReservation(key: string): void {
  typedCheckpointReservations.delete(key);
}

export function recordTypedCheckpoint(key: string): void {
  typedCheckpointReservations.delete(key);
  const count = typedCheckpointLedger.get(key) ?? 0;
  typedCheckpointLedger.delete(key);
  typedCheckpointLedger.set(key, count + 1);
  while (typedCheckpointLedger.size > MAX_TYPED_CHECKPOINT_ENTRIES) {
    typedCheckpointLedger.delete(typedCheckpointLedger.keys().next().value!);
  }
}

export function resetTypedCheckpoints(): void {
  typedCheckpointLedger.clear();
  typedCheckpointReservations.clear();
}

function hasRecordedTypedCheckpoint(key: string): boolean {
  const count = typedCheckpointLedger.get(key) ?? 0;
  if (count < 1) return false;
  // Refresh active tasks so only identities beyond the host lifecycle are evicted.
  typedCheckpointLedger.delete(key);
  typedCheckpointLedger.set(key, count);
  return true;
}

export function normalizeVerifyFailureGuidance(text: string): { text: string; valid: boolean } {
  const lines = text.split(/\r?\n/);
  const labels = ["Diagnosis", "Next command", "Expected signal", "Stop condition"];
  const valid = lines.length === labels.length && labels.every((label, index) =>
    new RegExp(`^${label}:\\s+\\S.*$`).test(lines[index] ?? ""),
  );
  if (valid) return { text, valid: true };
  return {
    valid: false,
    text: [
      "[Structured verify-failure contract invalid; treat the note below as unstructured critique and choose one safe discriminating command yourself.]",
      text.trim(),
    ].join("\n\n"),
  };
}

function enrichVerifyFailureSummary(summary: ToolObservationSummary, state: SessionStateSummary): ToolObservationSummary {
  const verifier = redactSensitiveText(state.lastVerifierCommandClass ?? "unknown verifier");
  const files = (state.confirmedModifiedFiles ?? []).slice(0, 20).map(redactSensitiveText);
  const failureSignals = (state.lastVerifierFailureSignals ?? ["tool-result-error"]).map(redactSensitiveText).slice(0, 8);
  const text = [
    "M3 verify-failure evidence (raw verifier output omitted at the provider boundary):",
    `- Failed verifier command class: ${verifier}`,
    `- Failure categories: ${failureSignals.length ? failureSignals.join(", ") : "tool-result-error"}`,
    `- Confirmed files modified before that verifier: ${files.length ? files.join(", ") : "unknown"}`,
  ].join("\n");
  return {
    ...summary,
    latestFailureSignals: failureSignals,
    failureSignals,
    text,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

function typedCheckpointLedgerKey(alias: string, context: Context, type: "strategy" | "verify_failure", sessionId?: string): string {
  return createHash("sha256").update(`${alias}|${type}|${conversationIdentity(context, sessionId)}`).digest("hex");
}
