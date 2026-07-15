import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Api,
  Model,
} from "./pi-compat.js";
import { redactSensitiveText } from "./context.js";
import type { GsdMoaConfig, MoaAction, PolicyDecision, UpstreamRoute } from "./types.js";

export interface TraceRecorder {
  readonly runId: string;
  readonly filePath?: string;
  recordFinalContext(context: Context): void;
  recordReferenceCall(entry: TraceReferenceCall): void;
  recordReferenceFailure(entry: TraceReferenceCall): void;
  recordReferenceLayerFailure(layer: "advisor" | "full_moa", error: unknown): void;
  recordPrimaryCall(entry: TracePrimaryCall): void;
  recordPrimaryEvent(event: AssistantMessageEvent): void;
  finish(message: AssistantMessage, diagnostics: unknown): void;
  finishError(message: AssistantMessage, diagnostics: unknown): void;
  fail(error: unknown, diagnostics?: unknown): void;
}

export interface TracePrimaryCall {
  route: UpstreamRoute;
  effort?: string;
  startedAt: number;
}

export interface TraceReferenceCall {
  role: "reference" | "proposer" | "synthesizer";
  id?: string;
  label?: string;
  route: UpstreamRoute;
  effort?: string;
  context?: Context;
  message?: AssistantMessage;
  cacheHit: boolean;
  cacheKey?: string;
  cachedText?: string;
  startedAt: number;
  endedAt: number;
  error?: string;
}

interface TraceFile {
  version: 1;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "done" | "error";
  model: Pick<Model<Api>, "provider" | "id" | "api">;
  policy: PolicyDecision;
  langPolicy?: string;
  langYokeSchedule?: string;
  action: MoaAction;
  config: unknown;
  inputContext?: Context;
  finalContext?: Context;
  referenceCalls: TraceReferenceCall[];
  primaryCall?: TracePrimaryCall;
  primaryEvents: unknown[];
  finalMessage?: AssistantMessage;
  diagnostics?: unknown;
  error?: string;
  referenceLayerFailures?: Array<{ layer: "advisor" | "full_moa"; error: string; timestamp: string }>;
}

export function createTraceRecorder(
  config: GsdMoaConfig,
  model: Model<Api>,
  inputContext: Context,
  policy: PolicyDecision,
  action: MoaAction,
): TraceRecorder | undefined {
  if (!config.trace.enabled) return undefined;
  return new JsonTraceRecorder(config, model, inputContext, policy, action);
}

class JsonTraceRecorder implements TraceRecorder {
  readonly runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 10)}`;
  readonly filePath: string;
  private readonly data: TraceFile;
  private readonly config: GsdMoaConfig;
  private lastFlushAt = 0;
  private checkpointTimer?: NodeJS.Timeout;

  constructor(config: GsdMoaConfig, model: Model<Api>, inputContext: Context, policy: PolicyDecision, action: MoaAction) {
    this.config = config;
    this.filePath = join(config.trace.dir, `${this.runId}.json`);
    this.data = {
      version: 1,
      runId: this.runId,
      startedAt: new Date().toISOString(),
      status: "running",
      model: { provider: model.provider, id: model.id, api: model.api },
      policy,
      ...(config.langPolicy.policy !== "off" ? {
        langPolicy: config.langPolicy.policy,
        ...(config.langPolicy.yokeSchedule !== undefined ? { langYokeSchedule: config.langPolicy.yokeSchedule } : {}),
      } : {}),
      action: compactAction(action),
      config: redactedConfig(config),
      ...(config.trace.includeContexts ? { inputContext: traceClone(inputContext) } : {}),
      referenceCalls: [],
      primaryEvents: [],
    };
    this.flush();
  }

  recordFinalContext(context: Context): void {
    if (!this.config.trace.includeContexts) return;
    this.data.finalContext = traceClone(context);
    this.flush();
  }

  recordReferenceCall(entry: TraceReferenceCall): void {
    const traceEntry = this.config.trace.includeOutputs ? cloneReferenceCall(entry) : withoutOutputs(entry);
    if (!this.config.trace.includeContexts) delete traceEntry.context;
    this.data.referenceCalls.push(traceEntry);
    this.flush();
  }

  recordReferenceFailure(entry: TraceReferenceCall): void {
    this.recordReferenceCall(entry);
  }

  recordPrimaryCall(entry: TracePrimaryCall): void {
    const clone = traceClone(entry);
    redactRoute(clone.route);
    this.data.primaryCall = clone;
    this.flush();
  }

  recordReferenceLayerFailure(layer: "advisor" | "full_moa", error: unknown): void {
    this.data.referenceLayerFailures ??= [];
    this.data.referenceLayerFailures.push({
      layer,
      error: redactSensitiveText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      timestamp: new Date().toISOString(),
    });
    this.flush();
  }

  recordPrimaryEvent(event: AssistantMessageEvent): void {
    this.data.primaryEvents.push(compactPrimaryEvent(event, this.config.trace.includeOutputs));
    // Delta streams can contain thousands of events. Rewriting the full growing
    // JSON document for every delta creates quadratic synchronous I/O and changes
    // the latency being measured. Persist at completed content/tool boundaries,
    // plus a coarse checkpoint so a crash during one long block loses at most a
    // bounded interval rather than the entire in-progress response.
    const boundary = event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end";
    if (boundary) this.flush();
    else this.scheduleCheckpoint();
  }

  finish(message: AssistantMessage, diagnostics: unknown): void {
    this.finishWithStatus("done", message, diagnostics);
  }

  finishError(message: AssistantMessage, diagnostics: unknown): void {
    this.finishWithStatus("error", message, diagnostics);
    this.data.error = message.errorMessage ? redactSensitiveText(message.errorMessage) : message.errorMessage;
    this.flush();
  }

  fail(error: unknown, diagnostics?: unknown): void {
    this.data.status = "error";
    this.data.endedAt = new Date().toISOString();
    this.data.error = redactSensitiveText(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
    this.data.diagnostics = traceClone(diagnostics);
    this.flush();
  }

  private finishWithStatus(status: "done" | "error", message: AssistantMessage, diagnostics: unknown): void {
    this.data.status = status;
    this.data.endedAt = new Date().toISOString();
    if (this.config.trace.includeOutputs) this.data.finalMessage = traceClone(message);
    this.data.diagnostics = traceClone(diagnostics);
    this.flush();
  }

  private scheduleCheckpoint(): void {
    if (this.checkpointTimer) return;
    const delayMs = Math.max(0, 10_000 - (Date.now() - this.lastFlushAt));
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      this.flush();
    }, delayMs);
    this.checkpointTimer.unref();
  }

  private flush(): void {
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    this.lastFlushAt = Date.now();
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(this.config.trace.dir, { recursive: true, mode: 0o700 });
      writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } catch {
      // Tracing must never break the provider stream. The caller still receives
      // normal assistant events even if the trace directory is unwritable.
    } finally {
      try {
        if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
      } catch {
        // Cleanup is best-effort for the same reason as trace persistence.
      }
    }
  }
}

function cloneReferenceCall(entry: TraceReferenceCall): TraceReferenceCall {
  const clone = traceClone(entry);
  redactRoute(clone.route);
  return clone;
}

function withoutOutputs(entry: TraceReferenceCall): TraceReferenceCall {
  const { context: _context, message: _message, cachedText: _cachedText, ...rest } = entry;
  const clone = traceClone(rest) as TraceReferenceCall;
  redactRoute(clone.route);
  return clone;
}

function compactPrimaryEvent(event: AssistantMessageEvent, includeOutputs: boolean): unknown {
  if (!includeOutputs) return { type: event.type };
  switch (event.type) {
    case "text_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
      return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "thinking_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end":
      return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "toolcall_end":
      return { type: event.type, contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done":
      return { type: event.type, reason: event.reason, message: traceClone(event.message) };
    case "error":
      return { type: event.type, reason: event.reason, error: traceClone(event.error) };
    default:
      return "contentIndex" in event ? { type: event.type, contentIndex: event.contentIndex } : { type: event.type };
  }
}

function compactAction(action: MoaAction): MoaAction {
  if (!action.observationSummary) return traceClone(action);
  const { text: _text, ...summary } = action.observationSummary;
  return traceClone({ ...action, observationSummary: summary }) as MoaAction;
}

function redactedConfig(config: GsdMoaConfig): unknown {
  const copy = traceClone(config);
  redactRoute(copy.primary);
  redactRoute(copy.reference);
  for (const preset of Object.values(copy.routePresets)) redactRoute(preset);
  for (const proposer of copy.fullMoa.proposers) if (proposer.route) redactRoute(proposer.route as UpstreamRoute);
  if (copy.fullMoa.synthesis.route) redactRoute(copy.fullMoa.synthesis.route as UpstreamRoute);
  return copy;
}

function traceClone<T>(value: T): T {
  return toTraceValue(value, new WeakSet<object>()) as T;
}

function toTraceValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
  if (typeof value === "symbol" || typeof value === "undefined") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toTraceValue(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const cloned = toTraceValue(child, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  seen.delete(value);
  return out;
}

function redactRoute(route: Partial<UpstreamRoute>): void {
  if (route.apiKey) route.apiKey = String(route.apiKey).startsWith("$") ? route.apiKey : "[REDACTED]";
  if (route.headers) {
    for (const key of Object.keys(route.headers)) {
      if (/authorization|api[-_]?key|token|secret/i.test(key)) route.headers[key] = "[REDACTED]";
    }
  }
}
