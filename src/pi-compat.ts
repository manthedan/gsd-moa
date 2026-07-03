import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as OmpTypes from "@oh-my-pi/pi-ai/types";

export type Api = OmpTypes.Api;
export type TextContent = OmpTypes.TextContent;
export type UserMessage = OmpTypes.UserMessage;
export type Message = OmpTypes.Message;
export type SimpleStreamOptions = OmpTypes.SimpleStreamOptions;
export interface MoaDiagnostic {
  type: string;
  timestamp: number;
  details: Record<string, unknown>;
}

declare module "@oh-my-pi/pi-ai/types" {
  interface AssistantMessage {
    diagnostics?: MoaDiagnostic[];
  }
}

export type AssistantMessage = OmpTypes.AssistantMessage;
export type AssistantMessageEvent = OmpTypes.AssistantMessageEvent;
export type Usage = OmpTypes.Usage & { cacheWrite1h?: number };
export type Context = Omit<OmpTypes.Context, "systemPrompt"> & { systemPrompt?: string };
export type Model<TApi extends Api = Api> = Omit<OmpTypes.Model<TApi>, "compat"> & {
  compat?: OmpTypes.Model<TApi>["compat"] | Record<string, unknown>;
  thinkingLevelMap?: ThinkingLevelMap;
};
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
export type ModelSpec<TApi extends Api = Api> = OmpTypes.ModelSpec<TApi>;

export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  queue: AssistantMessageEvent[] = [];
  waiting: Array<{ resolve: (value: IteratorResult<AssistantMessageEvent>) => void; reject: (err: unknown) => void }> = [];
  done = false;
  resultSettled = false;
  finalResultPromise: Promise<AssistantMessage>;
  resolveFinalResult!: (result: AssistantMessage) => void;
  rejectFinalResult!: (err: unknown) => void;
  #failed = false;
  #error: unknown;

  constructor() {
    this.finalResultPromise = new Promise<AssistantMessage>((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    this.finalResultPromise.catch(() => {});
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    this.deliver(event);
  }

  deliver(event: AssistantMessageEvent): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended without a final result"));
    }
    while (this.waiting.length > 0) this.waiting.shift()!.resolve({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.done) return;
    this.done = true;
    this.#failed = true;
    this.#error = err;
    this.resultSettled = true;
    this.rejectFinalResult(err);
    while (this.waiting.length > 0) this.waiting.shift()!.reject(err);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift()!;
      else if (this.#failed) throw this.#error;
      else if (this.done) return;
      else {
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => this.waiting.push({ resolve, reject }));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}

export type Runtime = "pi" | "omp";

type PiCompatModule = {
  getModel?: (provider: string, id: string) => Model<Api> | undefined;
  streamSimple?: <TApi extends Api>(model: Model<TApi>, context: unknown, options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };
  completeSimple?: <TApi extends Api>(model: Model<TApi>, context: unknown, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
};

let runtimeCache: Runtime | undefined;
let bundledModels: Record<string, Record<string, unknown>> | undefined;
let piCompatModule: PiCompatModule | undefined;

export function getRuntime(): Runtime {
  if (runtimeCache) return runtimeCache;
  const override = process.env.GSD_MOA_RUNTIME;
  if (override === "pi" || override === "omp") {
    runtimeCache = override;
    return runtimeCache;
  }
  runtimeCache = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "omp" : "pi";
  return runtimeCache;
}

export function resetRuntimeCache(): void {
  runtimeCache = undefined;
  piCompatModule = undefined;
}

export function getModel(provider: string, id: string): Model<Api> | undefined {
  if (getRuntime() === "pi") {
    try {
      return loadPiCompatModule().getModel?.(provider, id);
    } catch {
      return undefined;
    }
  }
  try {
    const importMeta = import.meta as ImportMeta & { require?: (specifier: string) => unknown };
    if (typeof importMeta.require === "function") {
      const catalog = importMeta.require("@oh-my-pi/pi-catalog/models") as {
        getBundledModel?: (provider: string, id: string) => Model<Api> | undefined;
      };
      const model = catalog.getBundledModel?.(provider, id);
      if (model) return model;
    }
    bundledModels ??= readBundledModels();
    return bundledModels[provider]?.[id] as Model<Api> | undefined;
  } catch {
    return undefined;
  }
}

export function buildModel<TApi extends Api>(spec: OmpTypes.ModelSpec<TApi>): Model<TApi> {
  return spec as Model<TApi>;
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void (async () => {
    try {
      const normalized = normalizeContext(context);
      let inner: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };
      if (getRuntime() === "pi") {
        const { streamSimple: rawStreamSimple } = await import("@earendil-works/pi-ai/compat") as unknown as PiCompatModule;
        if (!rawStreamSimple) throw new Error("@earendil-works/pi-ai/compat did not export streamSimple");
        inner = rawStreamSimple(model, normalized, options);
      } else {
        const { streamSimple: rawStreamSimple } = await import("@oh-my-pi/pi-ai/stream");
        inner = rawStreamSimple(model as OmpTypes.Model<TApi>, normalized as OmpTypes.Context, options) as typeof inner;
      }
      for await (const event of inner) outer.push(event as AssistantMessageEvent);
      if (!outer.done) outer.end(await inner.result() as AssistantMessage);
    } catch (error) {
      outer.fail(error);
    }
  })();
  return outer;
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  if (getRuntime() === "pi") {
    const { completeSimple: rawCompleteSimple } = await import("@earendil-works/pi-ai/compat") as unknown as PiCompatModule;
    if (!rawCompleteSimple) throw new Error("@earendil-works/pi-ai/compat did not export completeSimple");
    return rawCompleteSimple(model, normalizeContext(context), options);
  }
  const { completeSimple: rawCompleteSimple } = await import("@oh-my-pi/pi-ai/stream");
  return rawCompleteSimple(model as OmpTypes.Model<TApi>, normalizeContext(context) as OmpTypes.Context, options);
}

export function normalizeContext(
  context: Context | (Omit<Context, "systemPrompt"> & { systemPrompt?: string | string[] }),
): OmpTypes.Context | (Omit<OmpTypes.Context, "systemPrompt"> & { systemPrompt?: string }) {
  if (getRuntime() === "pi") {
    return {
      ...context,
      systemPrompt: Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n\n") : context.systemPrompt,
    } as Omit<OmpTypes.Context, "systemPrompt"> & { systemPrompt?: string };
  }
  return {
    ...context,
    systemPrompt: typeof context.systemPrompt === "string" ? [context.systemPrompt] : context.systemPrompt,
  } as OmpTypes.Context;
}

function loadPiCompatModule(): PiCompatModule {
  piCompatModule ??= createRequire(import.meta.url)("@earendil-works/pi-ai/compat") as PiCompatModule;
  return piCompatModule;
}

function readBundledModels(): Record<string, Record<string, unknown>> {
  const require = createRequire(import.meta.url);
  const path = require.resolve("@oh-my-pi/pi-catalog/models.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
}
