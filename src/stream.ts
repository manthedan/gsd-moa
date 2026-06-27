import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { loadConfig } from "./config.js";
import { hasRecentToolResults, latestUserText } from "./context.js";
import { chooseMode } from "./policy.js";
import type { GsdMoaConfig } from "./types.js";
import { routeToModel, streamOptionsForRoute, type UpstreamClient, compatUpstreamClient } from "./upstream.js";

export interface StreamDependencies {
  config?: GsdMoaConfig;
  upstream?: UpstreamClient;
}

export function streamGsdMoa(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  deps: StreamDependencies = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const config = deps.config ?? loadConfig();
    const upstream = deps.upstream ?? compatUpstreamClient;
    const policy = chooseMode(config, {
      alias: model.id,
      latestUserText: latestUserText(context),
      hasToolResults: hasRecentToolResults(context),
    });

    try {
      if (policy.mode !== "single") {
        throw new Error(`Mode '${policy.mode}' is not implemented yet; use gpt55-glm52-single until advisor mode ships.`);
      }

      const primaryModel = routeToModel(config.primary);
      const inner = upstream.stream(primaryModel, context, streamOptionsForRoute(config.primary, options));
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      stream.push({
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: makeErrorMessage(model, error, options?.signal?.aborted),
      });
      stream.end();
    }
  })();

  return stream;
}

export function makeErrorMessage(model: Model<Api>, error: unknown, aborted = false): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
