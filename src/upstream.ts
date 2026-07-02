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
  stream: (model, context, options) => streamSimple(model, context, options),
  complete: (model, context, options) => completeSimple(model, context, options),
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

export function resolveConfigValue(value: string | undefined, label = "config value"): string | undefined {
  if (!value) return undefined;
  const envName = value.startsWith("${") && value.endsWith("}")
    ? value.slice(2, -1)
    : value.startsWith("$")
      ? value.slice(1)
      : undefined;
  if (!envName) return value;
  const resolved = process.env[envName];
  if (!resolved) throw new Error(`gsd-moa: environment variable ${envName} referenced by ${label} is not set`);
  return resolved;
}

export function streamOptionsForRoute(route: UpstreamRoute, options?: SimpleStreamOptions): SimpleStreamOptions {
  const apiKey = resolveConfigValue(route.apiKey, "route apiKey");
  const { apiKey: _providerApiKey, ...rest } = options ?? {};
  const headers = Object.fromEntries(
    Object.entries(route.headers ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `route header ${key}`) ?? ""]),
  );
  return {
    ...rest,
    ...(apiKey ? { apiKey } : {}),
    headers: { ...(options?.headers ?? {}), ...headers },
  };
}
