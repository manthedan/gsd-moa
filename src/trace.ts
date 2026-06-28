import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Api,
  Model,
} from "@earendil-works/pi-ai/compat";
import type { GsdMoaConfig, PolicyDecision, UpstreamRoute } from "./types.js";

export interface TraceRecorder {
  readonly runId: string;
  readonly filePath?: string;
  recordFinalContext(context: Context): void;
  recordReferenceCall(entry: TraceReferenceCall): void;
  recordPrimaryEvent(event: AssistantMessageEvent): void;
  finish(message: AssistantMessage, diagnostics: unknown): void;
  finishError(message: AssistantMessage, diagnostics: unknown): void;
  fail(error: unknown, diagnostics?: unknown): void;
}

export interface TraceReferenceCall {
  role: "reference" | "proposer" | "synthesizer";
  id?: string;
  label?: string;
  route: UpstreamRoute;
  context?: Context;
  message?: AssistantMessage;
  cacheHit: boolean;
  cacheKey?: string;
  cachedText?: string;
  startedAt: number;
  endedAt: number;
}

interface TraceFile {
  version: 1;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "done" | "error";
  model: Pick<Model<Api>, "provider" | "id" | "api">;
  policy: PolicyDecision;
  config: unknown;
  inputContext?: Context;
  finalContext?: Context;
  referenceCalls: TraceReferenceCall[];
  primaryEvents: unknown[];
  finalMessage?: AssistantMessage;
  diagnostics?: unknown;
  error?: string;
}

export function createTraceRecorder(
  config: GsdMoaConfig,
  model: Model<Api>,
  inputContext: Context,
  policy: PolicyDecision,
): TraceRecorder | undefined {
  if (!config.trace.enabled) return undefined;
  return new JsonTraceRecorder(config, model, inputContext, policy);
}

class JsonTraceRecorder implements TraceRecorder {
  readonly runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 10)}`;
  readonly filePath: string;
  private readonly data: TraceFile;
  private readonly config: GsdMoaConfig;

  constructor(config: GsdMoaConfig, model: Model<Api>, inputContext: Context, policy: PolicyDecision) {
    this.config = config;
    this.filePath = join(config.trace.dir, `${this.runId}.json`);
    this.data = {
      version: 1,
      runId: this.runId,
      startedAt: new Date().toISOString(),
      status: "running",
      model: { provider: model.provider, id: model.id, api: model.api },
      policy,
      config: redactedConfig(config),
      ...(config.trace.includeContexts ? { inputContext: structuredClone(inputContext) } : {}),
      referenceCalls: [],
      primaryEvents: [],
    };
    this.flush();
  }

  recordFinalContext(context: Context): void {
    if (!this.config.trace.includeContexts) return;
    this.data.finalContext = structuredClone(context);
    this.flush();
  }

  recordReferenceCall(entry: TraceReferenceCall): void {
    const traceEntry = this.config.trace.includeOutputs ? cloneReferenceCall(entry) : withoutOutputs(entry);
    if (!this.config.trace.includeContexts) delete traceEntry.context;
    this.data.referenceCalls.push(traceEntry);
    this.flush();
  }

  recordPrimaryEvent(event: AssistantMessageEvent): void {
    this.data.primaryEvents.push(compactPrimaryEvent(event, this.config.trace.includeOutputs));
    this.flush();
  }

  finish(message: AssistantMessage, diagnostics: unknown): void {
    this.finishWithStatus("done", message, diagnostics);
  }

  finishError(message: AssistantMessage, diagnostics: unknown): void {
    this.finishWithStatus("error", message, diagnostics);
    this.data.error = message.errorMessage;
    this.flush();
  }

  fail(error: unknown, diagnostics?: unknown): void {
    this.data.status = "error";
    this.data.endedAt = new Date().toISOString();
    this.data.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    this.data.diagnostics = diagnostics;
    this.flush();
  }

  private finishWithStatus(status: "done" | "error", message: AssistantMessage, diagnostics: unknown): void {
    this.data.status = status;
    this.data.endedAt = new Date().toISOString();
    if (this.config.trace.includeOutputs) this.data.finalMessage = structuredClone(message);
    this.data.diagnostics = diagnostics;
    this.flush();
  }

  private flush(): void {
    try {
      mkdirSync(this.config.trace.dir, { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
    } catch {
      // Tracing must never break the provider stream. The caller still receives
      // normal assistant events even if the trace directory is unwritable.
    }
  }
}

function cloneReferenceCall(entry: TraceReferenceCall): TraceReferenceCall {
  const clone = structuredClone(entry);
  redactRoute(clone.route);
  return clone;
}

function withoutOutputs(entry: TraceReferenceCall): TraceReferenceCall {
  const { context: _context, message: _message, cachedText: _cachedText, ...rest } = entry;
  const clone = structuredClone(rest) as TraceReferenceCall;
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
      return { type: event.type, reason: event.reason, message: event.message };
    case "error":
      return { type: event.type, reason: event.reason, error: event.error };
    default:
      return "contentIndex" in event ? { type: event.type, contentIndex: event.contentIndex } : { type: event.type };
  }
}

function redactedConfig(config: GsdMoaConfig): unknown {
  const copy = structuredClone(config);
  redactRoute(copy.primary);
  redactRoute(copy.reference);
  for (const proposer of copy.fullMoa.proposers) if (proposer.route) redactRoute(proposer.route as UpstreamRoute);
  if (copy.fullMoa.synthesis.route) redactRoute(copy.fullMoa.synthesis.route as UpstreamRoute);
  return copy;
}

function redactRoute(route: Partial<UpstreamRoute>): void {
  if (route.apiKey) route.apiKey = String(route.apiKey).startsWith("$") ? route.apiKey : "[REDACTED]";
  if (route.headers) {
    for (const key of Object.keys(route.headers)) {
      if (/authorization|api[-_]?key|token|secret/i.test(key)) route.headers[key] = "[REDACTED]";
    }
  }
}
