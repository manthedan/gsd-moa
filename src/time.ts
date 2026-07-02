import type { TimeAwareConfig, TimePhase, TimeState } from "./types.js";

export interface TimeEnvInput {
  deadlineEpochMs?: number;
  budgetMs?: number;
}

export function timeEnvFromProcess(env: NodeJS.ProcessEnv = process.env): TimeEnvInput {
  return {
    deadlineEpochMs: parsePositiveNumber(env.GSD_MOA_DEADLINE_EPOCH_MS),
    budgetMs: parsePositiveNumber(env.GSD_MOA_BUDGET_MS),
  };
}

export function computeTimeState(
  cfg: TimeAwareConfig,
  env: TimeEnvInput,
  nowMs: number,
): TimeState | undefined {
  if (!cfg.enabled) return undefined;
  if (env.deadlineEpochMs === undefined) return undefined;

  const remainingMs = Math.max(0, Math.floor(env.deadlineEpochMs - nowMs));
  const budgetMs = validPositive(env.budgetMs) ? Math.floor(env.budgetMs) : undefined;
  const reserveMs = computeReserveMs(cfg, budgetMs);

  if (budgetMs === undefined) {
    return {
      remainingMs,
      inReserve: remainingMs === 0 || remainingMs < reserveMs,
    };
  }

  const elapsedMs = Math.min(budgetMs, Math.max(0, budgetMs - remainingMs));
  const phase = phaseForElapsed(cfg, elapsedMs, budgetMs);
  return {
    remainingMs,
    elapsedMs,
    budgetMs,
    phase,
    inReserve: phase === "reserve" || remainingMs < reserveMs,
  };
}

export function computeReserveMs(cfg: TimeAwareConfig, budgetMs?: number): number {
  if (budgetMs === undefined) return Math.max(0, Math.floor(cfg.minReserveMs));
  const ratioReserve = Math.floor(cfg.reserveRatio * budgetMs);
  return Math.min(budgetMs, Math.max(Math.floor(cfg.minReserveMs), ratioReserve));
}

export function referenceBudgetMs(cfg: TimeAwareConfig, timeState: TimeState | undefined): number | undefined {
  if (!timeState) return undefined;
  return timeState.remainingMs - computeReserveMs(cfg, timeState.budgetMs);
}

export function hasReferenceTimeBudget(cfg: TimeAwareConfig, timeState: TimeState | undefined, floorMs = 5_000): boolean {
  if (!timeState) return true;
  if (timeState.inReserve) return false;
  return referenceBudgetMs(cfg, timeState) === undefined || referenceBudgetMs(cfg, timeState)! >= floorMs;
}

export function formatTimeAwareNote(timeState: TimeState): string {
  const strategy = phaseStrategy(timeState.phase);
  const timing = timeState.budgetMs !== undefined && timeState.elapsedMs !== undefined
    ? `elapsed ${formatDuration(timeState.elapsedMs)}/${formatDuration(timeState.budgetMs)}, remaining ${formatDuration(timeState.remainingMs)}`
    : `remaining ${formatDuration(timeState.remainingMs)}`;
  const phase = timeState.phase ? ` phase=${timeState.phase}.` : ".";
  return `[Time budget: ${timing};${phase}]\nStrategy: ${strategy}`;
}

export function formatReferenceTimeLine(timeState: TimeState | undefined): string | undefined {
  if (!timeState) return undefined;
  const minutes = Math.max(0, Math.ceil(timeState.remainingMs / 60_000));
  const phase = timeState.phase ? `, phase=${timeState.phase}` : "";
  return `Time budget: about ${minutes} minute${minutes === 1 ? "" : "s"} remaining${phase}; keep advice proportionate to the remaining budget; prefer the shortest safe path.`;
}

function phaseForElapsed(cfg: TimeAwareConfig, elapsedMs: number, budgetMs: number): TimePhase {
  const exploreEnd = cfg.exploreRatio * budgetMs;
  const implementEnd = cfg.implementRatio * budgetMs;
  const validateEnd = cfg.validateRatio * budgetMs;
  const grace = cfg.graceRatio * budgetMs;

  if (elapsedMs <= exploreEnd + grace) return "explore";
  if (elapsedMs <= implementEnd + grace) return "implement";
  if (elapsedMs <= validateEnd + grace) return "validate";
  return "reserve";
}

function phaseStrategy(phase: TimePhase | undefined): string {
  switch (phase) {
    case "explore": return "inspection, planning, environment setup";
    case "implement": return "primary solution construction";
    case "validate": return "lock in the result; targeted verification only";
    case "reserve": return "preserve output; do NOT start new state-changing actions; finalize now";
    default: return "keep work proportionate to the remaining budget; prefer the shortest safe path";
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  return `${Math.ceil(totalSeconds / 60)}m`;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return validPositive(parsed) ? parsed : undefined;
}

function validPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
