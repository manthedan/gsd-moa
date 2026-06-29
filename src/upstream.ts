import {
  completeSimple,
  getModel,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { UpstreamRoute } from "./types.js";

export interface UpstreamClient {
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

export const compatUpstreamClient: UpstreamClient = {
  stream: (model, context, options) => streamSimple(model, context, withRouteApiKey(model, options)),
  complete: (model, context, options) => completeSimple(model, context, withRouteApiKey(model, options)),
};

export function routeToModel(route: UpstreamRoute): Model<Api> {
  const builtin = getModel(route.provider as never, route.model) as Model<Api> | undefined;
  return {
    id: route.model,
    name: builtin?.name ?? route.model,
    api: route.api ?? builtin?.api ?? "openai-completions",
    provider: route.provider,
    baseUrl: route.baseUrl ?? builtin?.baseUrl ?? "",
    reasoning: route.reasoning ?? builtin?.reasoning ?? false,
    thinkingLevelMap: route.thinkingLevelMap ?? builtin?.thinkingLevelMap,
    input: route.input ?? builtin?.input ?? ["text"],
    cost: route.cost ?? builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow ?? builtin?.contextWindow ?? 128000,
    maxTokens: route.maxTokens ?? builtin?.maxTokens ?? 4096,
    headers: route.headers ?? builtin?.headers,
    compat: route.compat ?? builtin?.compat,
  } as Model<Api>;
}

export function resolveConfigValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("${") && value.endsWith("}")) return process.env[value.slice(2, -1)];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

function withRouteApiKey(model: Model<Api>, options?: SimpleStreamOptions): SimpleStreamOptions | undefined {
  // If caller already provided an apiKey, keep it. Route-specific keys are applied by orchestration.
  return options;
}

export function streamOptionsForRoute(route: UpstreamRoute, options?: SimpleStreamOptions): SimpleStreamOptions {
  const apiKey = resolveConfigValue(route.apiKey);
  const { apiKey: _providerApiKey, ...rest } = options ?? {};
  return {
    ...rest,
    ...(apiKey ? { apiKey } : {}),
    headers: { ...(options?.headers ?? {}), ...(route.headers ?? {}) },
  };
}
