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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
  usage?: Partial<UsageSummary>;
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
}

export interface TrialRecord {
  jobName: string;
  trialName: string;
  path: string;
  task: string;
  alias: string;
  reward: number | null;
  passed: boolean;
  exceptionClass: string | null;
  wallTimeMs: number | null;
  moa: MoaAggregate & { eventSummaries: MoaEventSummary[] };
}

export interface WallTimeAggregate {
  meanMs: number | null;
  maxMs: number | null;
  samples: number;
}

export interface GroupAggregate {
  task?: string;
  alias: string;
  trials: number;
  passes: number;
  passRate: number;
  exceptionsByClass: CountMap;
  timeouts: number;
  otherExceptions: number;
  wallTimeMs: WallTimeAggregate;
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

interface MutableGroup extends Omit<GroupAggregate, "wallTimeMs" | "passRate"> {
  wallSamples: number[];
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
  return basename(path).includes("__")
    && existsSync(join(path, "config.json"))
    && (existsSync(join(path, "trial.log"))
      || existsSync(join(path, "exception.txt"))
      || existsSync(join(path, "agent"))
      || existsSync(join(path, "verifier")));
}

export function findTrialDirs(dir = "jobs"): string[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];

  const trials: string[] = [];
  for (const jobDir of listDirectories(root)) {
    if (isTrialDir(jobDir)) trials.push(jobDir);
    for (const trialDir of listDirectories(jobDir)) {
      if (isTrialDir(trialDir)) trials.push(trialDir);
    }
  }
  return trials.sort();
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

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    return {
      role: firstString(record.role),
      provider: firstString(record.provider),
      model: firstString(record.model),
      ...(usage ? { usage } : {}),
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
    const key = [call.role ?? "unknown-role", call.provider ?? "unknown-provider", call.model ?? "unknown-model"].join("/");
    increment(aggregate.innerCallsByRoleModel, key);
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

export function parseMoaTelemetry(trialDir: string): MoaAggregate & { eventSummaries: MoaEventSummary[] } {
  const aggregate = emptyMoaAggregate() as MoaAggregate & { eventSummaries: MoaEventSummary[] };
  aggregate.eventSummaries = [];

  const jsonlPath = join(trialDir, "agent", "pi-gsd-moa", "pi-output.jsonl");
  if (!existsSync(jsonlPath)) return aggregate;

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
    if (!record || record.type !== "message_end") continue;
    const diagnostics = getPath(record, "message.diagnostics");
    if (!Array.isArray(diagnostics)) continue;
    for (const diagnostic of diagnostics) {
      const summary = moaEventFromDiagnostic(diagnostic);
      if (!summary) continue;
      aggregate.eventSummaries.push(summary);
      applyMoaEvent(aggregate, summary);
    }
  }
  return aggregate;
}

export function readTrial(trialDir: string): TrialRecord {
  const config = readJson(join(trialDir, "config.json"));
  const result = readJson(join(trialDir, "result.json"));
  const reward = rewardFrom(result);
  const task = taskFrom(config, result, trialDir);
  const alias = aliasFrom(config, result);

  return {
    jobName: basename(resolve(trialDir, "..")),
    trialName: basename(trialDir),
    path: trialDir,
    task,
    alias,
    reward,
    passed: reward !== null && reward >= 1,
    exceptionClass: exceptionClassFrom(trialDir, result),
    wallTimeMs: wallTimeFrom(trialDir, result),
    moa: parseMoaTelemetry(trialDir),
  };
}

function newMutableGroup(alias: string, task?: string): MutableGroup {
  return {
    ...(task ? { task } : {}),
    alias,
    trials: 0,
    passes: 0,
    exceptionsByClass: {},
    timeouts: 0,
    otherExceptions: 0,
    wallSamples: [],
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
}

function addTrialToGroup(group: MutableGroup, trial: TrialRecord): void {
  group.trials += 1;
  if (trial.passed) group.passes += 1;
  if (trial.exceptionClass) {
    increment(group.exceptionsByClass, trial.exceptionClass);
    if (/timeout/i.test(trial.exceptionClass)) group.timeouts += 1;
    else group.otherExceptions += 1;
  }
  if (trial.wallTimeMs !== null) group.wallSamples.push(trial.wallTimeMs);
  mergeMoa(group.moa, trial.moa);
}

function finalizeGroup(group: MutableGroup): GroupAggregate {
  const max = group.wallSamples.length ? Math.max(...group.wallSamples) : null;
  const mean = group.wallSamples.length ? group.wallSamples.reduce((sum, value) => sum + value, 0) / group.wallSamples.length : null;
  const { wallSamples, ...rest } = group;
  return {
    ...rest,
    passRate: group.trials ? group.passes / group.trials : 0,
    wallTimeMs: { meanMs: mean, maxMs: max, samples: wallSamples.length },
  };
}

export function aggregateTbResults(dir = "jobs"): AggregateReport {
  const sourceDir = resolve(dir);
  const trialRecords = findTrialDirs(sourceDir).map(readTrial);
  const taskMaps = new Map<string, Map<string, MutableGroup>>();
  const totalsMap = new Map<string, MutableGroup>();

  for (const trial of trialRecords) {
    let byAlias = taskMaps.get(trial.task);
    if (!byAlias) {
      byAlias = new Map();
      taskMaps.set(trial.task, byAlias);
    }
    let group = byAlias.get(trial.alias);
    if (!group) {
      group = newMutableGroup(trial.alias, trial.task);
      byAlias.set(trial.alias, group);
    }
    addTrialToGroup(group, trial);

    let total = totalsMap.get(trial.alias);
    if (!total) {
      total = newMutableGroup(trial.alias);
      totalsMap.set(trial.alias, total);
    }
    addTrialToGroup(total, trial);
  }

  const tasks = [...taskMaps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, groups]) => ({
      task,
      groups: [...groups.values()].map(finalizeGroup).sort((a, b) => a.alias.localeCompare(b.alias)),
    }));

  return {
    sourceDir,
    generatedAt: new Date().toISOString(),
    trialCount: trialRecords.length,
    trialRecords,
    tasks,
    totalsByAlias: [...totalsMap.values()].map(finalizeGroup).sort((a, b) => a.alias.localeCompare(b.alias)),
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
  if (Object.keys(group.moa.guidanceSkipped).length) parts.push(`skips {${formatCounts(group.moa.guidanceSkipped)}}`);
  if (group.moa.synthesisFailureCount) parts.push(`synthesis failures {${formatCounts(group.moa.synthesisFailures)}}`);
  if (group.moa.timeAwareSuppressions) parts.push(`time-aware suppressions {${formatCounts(group.moa.timeAwareSuppressionPhases)}}`);
  if (Object.keys(group.moa.innerCallsByRoleModel).length) parts.push(`inner calls {${formatCounts(group.moa.innerCallsByRoleModel)}}`);
  return parts;
}

function tableForGroups(groups: GroupAggregate[]): string[] {
  const lines = [
    "| Model alias | Trials | Passes | Pass rate | Exceptions | Wall mean/max | Checkpoints | Cache hit | Tokens in/out | Cost | Suppressions |",
    "|---|---:|---:|---:|---|---:|---|---:|---:|---:|---:|",
  ];
  for (const group of groups) {
    lines.push([
      `| ${group.alias}`,
      group.trials,
      group.passes,
      formatPercent(group.passRate),
      formatCounts(group.exceptionsByClass),
      `${formatMs(group.wallTimeMs.meanMs)} / ${formatMs(group.wallTimeMs.maxMs)}`,
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
      return parts.length ? [`- ${group.alias}: ${parts.join("; ")}`] : [];
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
