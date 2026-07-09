import { createHash } from "node:crypto";
import type { Context, UserMessage } from "./pi-compat.js";
import { isToolLoopContinuation, rawMessageText } from "./context.js";
import type { GsdMoaConfig, TimeState } from "./types.js";
import type { SessionStateSummary } from "./session-state.js";

export interface DoneGateLedgerEntry {
  count: number;
}

export interface DoneGateDecision {
  armed: boolean;
  reason: string;
}

const MAX_DONE_GATE_LEDGER_ENTRIES = 64;
const doneGateLedger = new Map<string, DoneGateLedgerEntry>();

export const DONE_GATE_NOTE = `[gsd-moa done gate — deterministic provider check, not from the user]
You are finishing after modifying files, but no verification has been observed in this session. Before finishing, do exactly one of:
(a) run the most relevant verification now — the task's own checker or tests if provided, a compile/import check (e.g. python3 -m py_compile <file>), or a concrete execution of the artifact you changed — and fix what fails; or
(b) if verification is genuinely impossible in this environment, state in one line why, then finish.`;

export function doneGateLedgerKey(aliasId: string, context: Context): string {
  const firstUser = context.messages.find((message) => message.role === "user");
  const firstUserMessageRawText = firstUser ? rawMessageText(firstUser) : "";
  return createHash("sha256").update(`${aliasId}|${firstUserMessageRawText}`).digest("hex");
}

export function readDoneGateLedger(key: string): DoneGateLedgerEntry | undefined {
  const entry = doneGateLedger.get(key);
  return entry ? { ...entry } : undefined;
}

export function recordDoneGateFire(key: string): void {
  const existing = doneGateLedger.get(key);
  doneGateLedger.set(key, { count: (existing?.count ?? 0) + 1 });

  while (doneGateLedger.size > MAX_DONE_GATE_LEDGER_ENTRIES) {
    const oldestKey = doneGateLedger.keys().next().value;
    if (oldestKey === undefined) break;
    doneGateLedger.delete(oldestKey);
  }
}

export function resetDoneGateLedger(): void {
  doneGateLedger.clear();
}

export function shouldArmDoneGate(
  config: GsdMoaConfig,
  context: Context,
  sessionState: SessionStateSummary,
  ledgerCount: number,
  timeState?: TimeState,
): DoneGateDecision {
  if (!config.doneGate.enabled) return { armed: false, reason: "disabled" };
  if (!isToolLoopContinuation(context)) return { armed: false, reason: "not-tool-loop-continuation" };
  if (!sessionState.filesModified) return { armed: false, reason: "no-files-modified" };
  if (sessionState.verifierRan) return { armed: false, reason: "verifier-ran" };
  if (ledgerCount >= config.doneGate.maxPerTask) return { armed: false, reason: "ledger-cap" };
  if (timeState && timeState.remainingMs < config.doneGate.minRemainingMs) return { armed: false, reason: "time-floor" };
  return { armed: true, reason: "armed" };
}

export function withDoneGateNote(context: Context): Context {
  return {
    ...context,
    messages: [...context.messages, { role: "user", content: DONE_GATE_NOTE, timestamp: Date.now() } satisfies UserMessage],
  };
}
