#!/usr/bin/env tsx
/**
 * Terminal-Bench Harbor results aggregator for gsd-moa.
 *
 * Assumptions based on the checked-in `jobs/` artifacts:
 * - Trial directories live under `jobs/<job-ts>/<task>__<id>/` and contain `config.json`,
 *   usually `result.json`, and sometimes `exception.txt`.
 * - The task name is available at `result.task_name`, `config.task.name`, or
 *   `result.config.task.name`.
 * - Harbor's agent `model_name` may be null for the pi-gsd-moa agent; in that case this
 *   script falls back to `result.agent_info.name` and then the agent class name.
 * - Verifier rewards may appear at `verifier_result.reward`,
 *   `verifier_result.rewards.reward`, or top-level `reward`.
 * - MoA telemetry is read only from `message_end` events in
 *   `agent/pi-gsd-moa/pi-output.jsonl`; `turn_end` duplicates are intentionally ignored.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CountMap = Record<string, number>;

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface InnerCallSummary {
  role?: string;
  provider?: string;
  model?: string;
  effort?: string;
  usage?: Partial<UsageSummary>;
  durationMs?: number;
}

export interface TrialTimeSummary {
  toolExecMs: number | null;
  referenceMs: number | null;
  turnSpanMs: number | null;
  modelOtherMs: number | null;
}

export interface MoaEventSummary {
  mode?: string;
  requestedMode?: string;
  checkpointScope?: string;
  cacheHit?: boolean;
  guidanceInjected?: boolean;
  guidanceSkippedReason?: string;
  synthesisFailedReason?: string;
  timeAware?: {
    remainingMs?: number;
    phase?: string;
    suppressed?: boolean;
  };
  innerCalls: InnerCallSummary[];
  combinedUsage?: UsageSummary;
}

export interface MoaAggregate {
  events: number;
  checkpointRuns: CountMap;
  guidanceSkipped: CountMap;
  cacheHits: number;
  cacheLookups: number;
  synthesisFailures: CountMap;
  synthesisFailureCount: number;
  timeAwareSuppressions: number;
  timeAwareSuppressionPhases: CountMap;
  combinedUsageTurns: number;
  combinedUsage: UsageSummary;
  innerCallsByRoleModel: CountMap;
  effortsByRole: Record<string, CountMap>;
}

export interface TrialRecord {
  jobName: string;
  trialName: string;
  path: string;
  label: string;
  task: string;
  alias: string;
  reward: number | null;
  passed: boolean;
  voidReason: string | null;
  exceptionClass: string | null;
  wallTimeMs: number | null;
  time: TrialTimeSummary;
  moa: MoaAggregate & { eventSummaries: MoaEventSummary[]; time: TrialTimeSummary };
}

export interface WallTimeAggregate {
  meanMs: number | null;
  maxMs: number | null;
  samples: number;
}

export interface GroupTimeAggregate {
  toolMeanMs: number | null;
  referenceMeanMs: number | null;
  modelOtherMeanMs: number | null;
  samples: {
    tool: number;
    reference: number;
    modelOther: number;
  };
}

export interface GroupAggregate {
  task?: string;
  alias: string;
  label: string;
  trials: number;
  passes: number;
  voids: number;
  passRate: number;
  exceptionsByClass: CountMap;
  voidReasons: CountMap;
  timeouts: number;
  otherExceptions: number;
  wallTimeMs: WallTimeAggregate;
  time: GroupTimeAggregate;
  moa: MoaAggregate;
}

export interface TaskAggregate {
  task: string;
  groups: GroupAggregate[];
}

export interface AggregateReport {
  sourceDir: string;
  generatedAt: string;
  trialCount: number;
  trialRecords: TrialRecord[];
  tasks: TaskAggregate[];
  totalsByAlias: GroupAggregate[];
}

interface MutableGroup extends Omit<GroupAggregate, "wallTimeMs" | "time" | "passRate"> {
  wallSamples: number[];
  toolTimeSamples: number[];
  referenceTimeSamples: number[];
  modelOtherTimeSamples: number[];
}

const CHECKPOINT_SCOPES = ["initial", "explicit", "failure", "drift"];

function emptyUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function emptyMoaAggregate(): MoaAggregate {
  return {
    events: 0,
    checkpointRuns: Object.fromEntries(CHECKPOINT_SCOPES.map((scope) => [scope, 0])),
    guidanceSkipped: {},
    cacheHits: 0,
    cacheLookups: 0,
    synthesisFailures: {},
    synthesisFailureCount: 0,
    timeAwareSuppressions: 0,
    timeAwareSuppressionPhases: {},
    combinedUsageTurns: 0,
    combinedUsage: emptyUsage(),
    innerCallsByRoleModel: {},
    effortsByRole: {},
  };
}

function increment(map: CountMap, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function isTrialDir(path: string): boolean {
  const name = basename(path);
  if (!/^.+__.+$/.test(name)) return false;
  if (/^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$/.test(name)) return false;
  if (!existsSync(join(path, "config.json"))) return false;
  return ["result.json", "exception.txt", "trial.log", "agent", "verifier"].some((entry) => existsSync(join(path, entry)));
}

export function findTrialDirs(dir = "jobs"): string[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];

  const trials: string[] = [];
  const maxDepthBelowRoot = 3;
  const walk = (current: string, depth: number): void => {
    for (const child of listDirectories(current)) {
      const childDepth = depth + 1;
      if (childDepth > maxDepthBelowRoot) continue;
      if (isTrialDir(child)) trials.push(child);
      if (childDepth < maxDepthBelowRoot) walk(child, childDepth);
    }
  };
  walk(root, 0);
  return trials.sort();
}

function trialLabel(rootDir: string | undefined, trialDir: string): string {
  if (!rootDir) return "-";
  const parts = relative(resolve(rootDir), resolve(trialDir)).split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return "-";
  return parts.slice(0, -2).join("/") || "-";
}

function rewardFrom(result: unknown): number | null {
  return numberValue(getPath(result, "verifier_result.reward"))
    ?? numberValue(getPath(result, "verifier_result.rewards.reward"))
    ?? numberValue(getPath(result, "reward"));
}

function taskFrom(config: unknown, result: unknown, trialDir: string): string {
  return firstString(
    getPath(result, "task_name"),
    getPath(config, "task.name"),
    getPath(result, "config.task.name"),
    getPath(result, "task_id.name"),
  ) ?? basename(trialDir).split("__")[0] ?? "unknown-task";
}

function aliasFrom(config: unknown, result: unknown): string {
  const agentName = firstString(getPath(config, "agent.name"), getPath(result, "config.agent.name"));
  const classAlias = agentName?.split(":").pop()?.split(".").pop();
  return firstString(
    getPath(config, "agent.model_name"),
    getPath(config, "agent.model"),
    getPath(config, "agent.modelAlias"),
    getPath(config, "agent.kwargs.model_name"),
    getPath(config, "agent.kwargs.model"),
    getPath(config, "agent.kwargs.alias"),
    getPath(result, "config.agent.model_name"),
    getPath(result, "agent_info.model_info.name"),
    getPath(result, "agent_info.model_info.id"),
    getPath(result, "agent_info.name"),
    classAlias,
  ) ?? "unknown-model";
}

function exceptionFromText(text: string): string | null {
  const matches = text.match(/\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b/g);
  if (!matches) return null;
  for (const candidate of matches) {
    if (candidate !== "Exception" && candidate !== "BaseException") return candidate;
  }
  return matches[0] ?? null;
}

function exceptionClassFrom(trialDir: string, result: unknown): string | null {
  const exceptionPath = join(trialDir, "exception.txt");
  if (existsSync(exceptionPath)) {
    const fromText = exceptionFromText(readFileSync(exceptionPath, "utf8"));
    if (fromText) return fromText;
  }
  return firstString(getPath(result, "exception_info.exception_type")) ?? null;
}

function envStartTimeoutReasonFromText(text: string): string | null {
  const line = text.split(/\r?\n/).find((candidate) => /Environment start timed out/i.test(candidate));
  return line?.trim() || (/Environment start timed out/i.test(text) ? "Environment start timed out" : null);
}

function readTail(path: string, maxBytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function voidReasonFrom(trialDir: string): string | null {
  const exceptionPath = join(trialDir, "exception.txt");
  if (existsSync(exceptionPath)) {
    const reason = envStartTimeoutReasonFromText(readFileSync(exceptionPath, "utf8"));
    if (reason) return reason;
  }
  const trialLogPath = join(trialDir, "trial.log");
  if (existsSync(trialLogPath)) return envStartTimeoutReasonFromText(readTail(trialLogPath));
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  return parseTimestamp(value);
}

function wallTimeFrom(trialDir: string, result: unknown): number | null {
  const started = parseTimestamp(getPath(result, "started_at"));
  const finished = parseTimestamp(getPath(result, "finished_at"));
  if (started !== null && finished !== null && finished >= started) return finished - started;

  const trialLog = join(trialDir, "trial.log");
  if (!existsSync(trialLog)) return null;
  try {
    const stat = statSync(trialLog);
    if (stat.birthtimeMs > 0 && stat.mtimeMs >= stat.birthtimeMs) return stat.mtimeMs - stat.birthtimeMs;
  } catch {
    return null;
  }
  return null;
}

function usageFrom(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const costValue = numberValue(record.cost) ?? numberValue(getPath(record, "cost.total")) ?? 0;
  const input = numberValue(record.input) ?? 0;
  const output = numberValue(record.output) ?? 0;
  const cacheRead = numberValue(record.cacheRead) ?? 0;
  const cacheWrite = numberValue(record.cacheWrite) ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: numberValue(record.totalTokens) ?? input + output + cacheRead + cacheWrite,
    cost: costValue,
  };
}

function addUsage(target: UsageSummary, usage: Partial<UsageSummary> | undefined): void {
  if (!usage) return;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.totalTokens += usage.totalTokens ?? 0;
  target.cost += usage.cost ?? 0;
}

function summarizeInnerCalls(value: unknown): InnerCallSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((call) => {
    const record = asRecord(call) ?? {};
    const usage = usageFrom(record.usage);
    const durationMs = numberValue(record.durationMs);
    return {
      role: firstString(record.role),
      provider: firstString(record.provider),
      model: firstString(record.model),
      effort: firstString(record.effort) ?? "unset",
      ...(usage ? { usage } : {}),
      ...(durationMs !== null ? { durationMs } : {}),
    };
  });
}

function applyMoaEvent(aggregate: MoaAggregate, event: MoaEventSummary): void {
  aggregate.events += 1;

  if (event.checkpointScope) increment(aggregate.checkpointRuns, event.checkpointScope);
  if (typeof event.cacheHit === "boolean") {
    aggregate.cacheLookups += 1;
    if (event.cacheHit) aggregate.cacheHits += 1;
  }
  if (event.guidanceSkippedReason) increment(aggregate.guidanceSkipped, event.guidanceSkippedReason);
  if (event.synthesisFailedReason) {
    aggregate.synthesisFailureCount += 1;
    increment(aggregate.synthesisFailures, event.synthesisFailedReason);
  }
  if (event.timeAware?.suppressed) {
    aggregate.timeAwareSuppressions += 1;
    increment(aggregate.timeAwareSuppressionPhases, event.timeAware.phase ?? "unknown");
  }
  if (event.combinedUsage) {
    aggregate.combinedUsageTurns += 1;
    addUsage(aggregate.combinedUsage, event.combinedUsage);
  }
  for (const call of event.innerCalls) {
    const role = call.role ?? "unknown-role";
    const key = [role, call.provider ?? "unknown-provider", call.model ?? "unknown-model"].join("/");
    increment(aggregate.innerCallsByRoleModel, key);
    aggregate.effortsByRole[role] ??= {};
    increment(aggregate.effortsByRole[role], call.effort ?? "unset");
  }
}

function moaEventFromDiagnostic(diagnostic: unknown): MoaEventSummary | null {
  const diag = asRecord(diagnostic);
  if (!diag || diag.type !== "gsd-moa.details") return null;
  const details = asRecord(diag.details) ?? diag;
  const timeAware = asRecord(details.timeAware);
  const combinedUsage = usageFrom(details.combinedUsage);

  return {
    mode: firstString(details.mode),
    requestedMode: firstString(details.requestedMode),
    checkpointScope: firstString(details.checkpointScope),
    cacheHit: booleanValue(details.cacheHit),
    guidanceInjected: booleanValue(details.guidanceInjected),
    guidanceSkippedReason: firstString(details.guidanceSkippedReason),
    synthesisFailedReason: firstString(details.synthesisFailedReason),
    ...(timeAware ? {
      timeAware: {
        remainingMs: numberValue(timeAware.remainingMs) ?? undefined,
        phase: firstString(timeAware.phase),
        suppressed: booleanValue(timeAware.suppressed),
      },
    } : {}),
    innerCalls: summarizeInnerCalls(details.innerCalls),
    ...(combinedUsage ? { combinedUsage } : {}),
  };
}

function emptyTrialTime(): TrialTimeSummary {
  return { toolExecMs: null, referenceMs: null, turnSpanMs: null, modelOtherMs: null };
}

function toolCallId(record: Record<string, unknown>): string | undefined {
  return firstString(record.toolCallId, record.tool_call_id, record.callId, record.call_id, record.id, getPath(record, "toolCall.id"));
}

function toolDurationFromEnd(record: Record<string, unknown>): number | null {
  return numberValue(getPath(record, "result.details.wallTimeMs"))
    ?? numberValue(getPath(record, "result.details.durationMs"))
    ?? numberValue(getPath(record, "details.wallTimeMs"))
    ?? numberValue(getPath(record, "details.durationMs"));
}

function eventStartTimestamp(record: Record<string, unknown>): number | null {
  return timestampMs(record.timestamp)
    ?? timestampMs(record.startedAt)
    ?? timestampMs(getPath(record, "message.timestamp"));
}

function eventEndTimestamp(record: Record<string, unknown>): number | null {
  return timestampMs(record.timestamp)
    ?? timestampMs(record.endedAt)
    ?? timestampMs(getPath(record, "message.timestamp"));
}

export function parseMoaTelemetry(trialDir: string): MoaAggregate & { eventSummaries: MoaEventSummary[]; time: TrialTimeSummary } {
  const aggregate = emptyMoaAggregate() as MoaAggregate & { eventSummaries: MoaEventSummary[]; time: TrialTimeSummary };
  aggregate.eventSummaries = [];
  aggregate.time = emptyTrialTime();

  const jsonlPath = join(trialDir, "agent", "pi-gsd-moa", "pi-output.jsonl");
  if (!existsSync(jsonlPath)) return aggregate;

  const toolStarts = new Map<string, number | null>();
  let toolExecMs = 0;
  let toolDurationSamples = 0;
  let sawToolEvent = false;
  let referenceMs = 0;
  let hasReferenceDuration = false;
  let firstMessageTs: number | null = null;
  let lastMessageEndTs: number | null = null;

  const lines = readFileSync(jsonlPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(event);
    if (!record) continue;

    const messageTs = timestampMs(getPath(record, "message.timestamp"));
    if (messageTs !== null && firstMessageTs === null) firstMessageTs = messageTs;
    if (record.type === "message_end" && messageTs !== null) lastMessageEndTs = messageTs;

    if (record.type === "tool_execution_start") {
      sawToolEvent = true;
      const id = toolCallId(record);
      if (id) toolStarts.set(id, eventStartTimestamp(record));
      continue;
    }
    if (record.type === "tool_execution_end") {
      sawToolEvent = true;
      const id = toolCallId(record);
      if (id && toolStarts.has(id)) {
        const startTs = toolStarts.get(id) ?? null;
        const endTs = eventEndTimestamp(record);
        const fromTimestamps = startTs !== null && endTs !== null && endTs >= startTs ? endTs - startTs : null;
        const duration = fromTimestamps ?? toolDurationFromEnd(record);
        if (duration !== null) {
          toolExecMs += duration;
          toolDurationSamples += 1;
        }
        toolStarts.delete(id);
      }
      continue;
    }

    if (record.type !== "message_end") continue;
    const diagnostics = getPath(record, "message.diagnostics");
    if (!Array.isArray(diagnostics)) continue;
    for (const diagnostic of diagnostics) {
      const summary = moaEventFromDiagnostic(diagnostic);
      if (!summary) continue;
      for (const call of summary.innerCalls) {
        if (call.role !== "primary" && call.durationMs !== undefined) {
          referenceMs += call.durationMs;
          hasReferenceDuration = true;
        }
      }
      aggregate.eventSummaries.push(summary);
      applyMoaEvent(aggregate, summary);
    }
  }

  const turnSpanMs = firstMessageTs !== null && lastMessageEndTs !== null && lastMessageEndTs >= firstMessageTs
    ? lastMessageEndTs - firstMessageTs
    : null;
  // Reference durations are cumulative provider-call time; full-MoA proposers run
  // concurrently, so do not subtract that sum from elapsed wall-clock time.
  const referenceTimeMs = hasReferenceDuration ? referenceMs : null;
  const toolTimeMs = toolDurationSamples || !sawToolEvent ? toolExecMs : null;
  const modelOtherMs = turnSpanMs !== null && toolTimeMs !== null
    ? Math.max(0, turnSpanMs - toolTimeMs)
    : null;
  aggregate.time = {
    toolExecMs: toolTimeMs,
    referenceMs: referenceTimeMs,
    turnSpanMs,
    modelOtherMs,
  };
  return aggregate;
}

export function readTrial(trialDir: string, rootDir?: string): TrialRecord {
  const config = readJson(join(trialDir, "config.json"));
  const result = readJson(join(trialDir, "result.json"));
  const reward = rewardFrom(result);
  const task = taskFrom(config, result, trialDir);
  const alias = aliasFrom(config, result);
  const moa = parseMoaTelemetry(trialDir);

  return {
    jobName: basename(resolve(trialDir, "..")),
    trialName: basename(trialDir),
    path: trialDir,
    label: trialLabel(rootDir, trialDir),
    task,
    alias,
    reward,
    passed: reward !== null && reward >= 1,
    voidReason: voidReasonFrom(trialDir),
    exceptionClass: exceptionClassFrom(trialDir, result),
    wallTimeMs: wallTimeFrom(trialDir, result),
    time: moa.time,
    moa,
  };
}

function newMutableGroup(alias: string, label: string, task?: string): MutableGroup {
  return {
    ...(task ? { task } : {}),
    alias,
    label,
    trials: 0,
    passes: 0,
    voids: 0,
    exceptionsByClass: {},
    voidReasons: {},
    timeouts: 0,
    otherExceptions: 0,
    wallSamples: [],
    toolTimeSamples: [],
    referenceTimeSamples: [],
    modelOtherTimeSamples: [],
    moa: emptyMoaAggregate(),
  };
}

function mergeMoa(target: MoaAggregate, source: MoaAggregate): void {
  target.events += source.events;
  target.cacheHits += source.cacheHits;
  target.cacheLookups += source.cacheLookups;
  target.synthesisFailureCount += source.synthesisFailureCount;
  target.timeAwareSuppressions += source.timeAwareSuppressions;
  target.combinedUsageTurns += source.combinedUsageTurns;
  addUsage(target.combinedUsage, source.combinedUsage);

  for (const [key, value] of Object.entries(source.checkpointRuns)) increment(target.checkpointRuns, key, value);
  for (const [key, value] of Object.entries(source.guidanceSkipped)) increment(target.guidanceSkipped, key, value);
  for (const [key, value] of Object.entries(source.synthesisFailures)) increment(target.synthesisFailures, key, value);
  for (const [key, value] of Object.entries(source.timeAwareSuppressionPhases)) increment(target.timeAwareSuppressionPhases, key, value);
  for (const [key, value] of Object.entries(source.innerCallsByRoleModel)) increment(target.innerCallsByRoleModel, key, value);
  for (const [role, efforts] of Object.entries(source.effortsByRole)) {
    target.effortsByRole[role] ??= {};
    for (const [effort, value] of Object.entries(efforts)) increment(target.effortsByRole[role], effort, value);
  }
}

function addTrialToGroup(group: MutableGroup, trial: TrialRecord): void {
  if (trial.voidReason) {
    group.voids += 1;
    increment(group.voidReasons, trial.voidReason);
    return;
  }

  group.trials += 1;
  if (trial.passed) group.passes += 1;
  if (trial.exceptionClass) {
    increment(group.exceptionsByClass, trial.exceptionClass);
    if (/timeout/i.test(trial.exceptionClass)) group.timeouts += 1;
    else group.otherExceptions += 1;
  }
  if (trial.wallTimeMs !== null) group.wallSamples.push(trial.wallTimeMs);
  if (trial.time.toolExecMs !== null) group.toolTimeSamples.push(trial.time.toolExecMs);
  if (trial.time.referenceMs !== null) group.referenceTimeSamples.push(trial.time.referenceMs);
  if (trial.time.modelOtherMs !== null) group.modelOtherTimeSamples.push(trial.time.modelOtherMs);
  mergeMoa(group.moa, trial.moa);
}

function meanSample(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function finalizeGroup(group: MutableGroup): GroupAggregate {
  const max = group.wallSamples.length ? Math.max(...group.wallSamples) : null;
  const mean = meanSample(group.wallSamples);
  const {
    wallSamples,
    toolTimeSamples,
    referenceTimeSamples,
    modelOtherTimeSamples,
    ...rest
  } = group;
  return {
    ...rest,
    passRate: group.trials ? group.passes / group.trials : 0,
    wallTimeMs: { meanMs: mean, maxMs: max, samples: wallSamples.length },
    time: {
      toolMeanMs: meanSample(toolTimeSamples),
      referenceMeanMs: meanSample(referenceTimeSamples),
      modelOtherMeanMs: meanSample(modelOtherTimeSamples),
      samples: {
        tool: toolTimeSamples.length,
        reference: referenceTimeSamples.length,
        modelOther: modelOtherTimeSamples.length,
      },
    },
  };
}

export function aggregateTbResults(dir = "jobs"): AggregateReport {
  const sourceDir = resolve(dir);
  const trialRecords = findTrialDirs(sourceDir).map((trialDir) => readTrial(trialDir, sourceDir));
  const taskMaps = new Map<string, Map<string, MutableGroup>>();
  const totalsMap = new Map<string, MutableGroup>();

  for (const trial of trialRecords) {
    const groupKey = `${trial.alias}\0${trial.label}`;
    let byAlias = taskMaps.get(trial.task);
    if (!byAlias) {
      byAlias = new Map();
      taskMaps.set(trial.task, byAlias);
    }
    let group = byAlias.get(groupKey);
    if (!group) {
      group = newMutableGroup(trial.alias, trial.label, trial.task);
      byAlias.set(groupKey, group);
    }
    addTrialToGroup(group, trial);

    let total = totalsMap.get(groupKey);
    if (!total) {
      total = newMutableGroup(trial.alias, trial.label);
      totalsMap.set(groupKey, total);
    }
    addTrialToGroup(total, trial);
  }

  const sortGroups = (a: GroupAggregate, b: GroupAggregate): number => a.alias.localeCompare(b.alias) || a.label.localeCompare(b.label);
  const tasks = [...taskMaps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, groups]) => ({
      task,
      groups: [...groups.values()].map(finalizeGroup).sort(sortGroups),
    }));

  return {
    sourceDir,
    generatedAt: new Date().toISOString(),
    trialCount: trialRecords.length,
    trialRecords,
    tasks,
    totalsByAlias: [...totalsMap.values()].map(finalizeGroup).sort(sortGroups),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "n/a";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function formatMinutes(value: number | null): string {
  return value === null ? "n/a" : `${(value / 60_000).toFixed(1)}`;
}

function formatTimeBreakdown(group: GroupAggregate): string {
  return [group.time.toolMeanMs, group.time.referenceMeanMs, group.time.modelOtherMeanMs].map(formatMinutes).join("/");
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number, hasUsage: boolean): string {
  if (!hasUsage) return "n/a";
  if (value === 0) return "$0";
  return `$${value.toFixed(4)}`;
}

function formatCounts(map: CountMap): string {
  const entries = Object.entries(map).filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(", ") : "-";
}

function formatEffortsByRole(effortsByRole: Record<string, CountMap>): string {
  const roles = Object.keys(effortsByRole).sort();
  if (!roles.length) return "-";
  return roles.map((role) => {
    const efforts = Object.entries(effortsByRole[role] ?? {})
      .filter(([, count]) => count > 0)
      .map(([effort]) => effort)
      .sort()
      .join("/") || "unset";
    return `${role}: ${efforts}`;
  }).join(", ");
}

function formatCache(group: GroupAggregate): string {
  const lookups = group.moa.cacheLookups;
  if (!lookups) return "n/a";
  return `${group.moa.cacheHits}/${lookups} (${formatPercent(group.moa.cacheHits / lookups)})`;
}

function formatUsage(group: GroupAggregate): string {
  if (!group.moa.combinedUsageTurns) return "n/a";
  return `${formatNumber(group.moa.combinedUsage.input)}/${formatNumber(group.moa.combinedUsage.output)}`;
}

function groupDetails(group: GroupAggregate): string[] {
  const parts: string[] = [];
  if (Object.keys(group.voidReasons).length) parts.push(`voids {${formatCounts(group.voidReasons)}}`);
  if (Object.keys(group.moa.guidanceSkipped).length) parts.push(`skips {${formatCounts(group.moa.guidanceSkipped)}}`);
  if (group.moa.synthesisFailureCount) parts.push(`synthesis failures {${formatCounts(group.moa.synthesisFailures)}}`);
  if (group.moa.timeAwareSuppressions) parts.push(`time-aware suppressions {${formatCounts(group.moa.timeAwareSuppressionPhases)}}`);
  if (Object.keys(group.moa.innerCallsByRoleModel).length) parts.push(`inner calls {${formatCounts(group.moa.innerCallsByRoleModel)}}`);
  if (Object.keys(group.moa.effortsByRole).length) parts.push(`efforts {${formatEffortsByRole(group.moa.effortsByRole)}}`);
  return parts;
}

function tableForGroups(groups: GroupAggregate[]): string[] {
  const lines = [
    "| Model alias | Label | Trials | Voids | Passes | Pass rate | Exceptions | Wall mean/max | Time tool/refΣ/non-tool | Checkpoints | Cache hit | Tokens in/out | Cost | Suppressions |",
    "|---|---|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---:|",
  ];
  for (const group of groups) {
    lines.push([
      `| ${group.alias}`,
      group.label,
      group.trials,
      group.voids,
      group.passes,
      formatPercent(group.passRate),
      formatCounts(group.exceptionsByClass),
      `${formatMs(group.wallTimeMs.meanMs)} / ${formatMs(group.wallTimeMs.maxMs)}`,
      formatTimeBreakdown(group),
      formatCounts(group.moa.checkpointRuns),
      formatCache(group),
      formatUsage(group),
      formatCost(group.moa.combinedUsage.cost, group.moa.combinedUsageTurns > 0),
      group.moa.timeAwareSuppressions,
    ].join(" | ") + " |");
  }
  return lines;
}

export function renderMarkdown(report: AggregateReport): string {
  const lines: string[] = [];
  lines.push("# Terminal-Bench Results Report");
  lines.push("");
  lines.push(`Source: \`${report.sourceDir}\``);
  lines.push(`Trials: ${report.trialCount}`);
  lines.push("");

  if (!report.trialCount) {
    lines.push("No trials found.");
    lines.push("");
    return lines.join("\n");
  }

  for (const task of report.tasks) {
    lines.push(`## ${task.task}`);
    lines.push("");
    lines.push(...tableForGroups(task.groups));
    const details = task.groups.flatMap((group) => {
      const parts = groupDetails(group);
      return parts.length ? [`- ${group.alias} [${group.label}]: ${parts.join("; ")}`] : [];
    });
    if (details.length) {
      lines.push("");
      lines.push("Details:");
      lines.push(...details);
    }
    lines.push("");
  }

  lines.push("## Totals by model alias");
  lines.push("");
  lines.push(...tableForGroups(report.totalsByAlias));
  lines.push("");
  return lines.join("\n");
}

interface CliArgs {
  dir: string;
  json?: string;
  md?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dir: "jobs", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dir") args.dir = argv[++index] ?? args.dir;
    else if (arg === "--json") args.json = argv[++index];
    else if (arg === "--md") args.md = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log("Usage: npx tsx scripts/aggregate-tb-results.ts [--dir jobs] [--json out.json] [--md out.md]");
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    const report = aggregateTbResults(args.dir);
    const markdown = renderMarkdown(report);
    if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    if (args.md) writeFileSync(args.md, markdown);
    else console.log(markdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
