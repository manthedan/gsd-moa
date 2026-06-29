import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { runAdvisor } from "./advisor.js";
import { loadConfig } from "./config.js";
import { hasRecentToolResults, latestUserText, stripMarkersFromContext, withAdvisorGuidance, withFullMoaGuidance } from "./context.js";
import { runFullMoa } from "./moa.js";
import { chooseMode } from "./policy.js";
import { applyModelPreset } from "./presets.js";
import { createTraceRecorder } from "./trace.js";
import type { AdvisorResult, FullMoaResult, GsdMoaConfig, MoaRunDetails } from "./types.js";
import { routeToModel, streamOptionsForRoute, type UpstreamClient, compatUpstreamClient } from "./upstream.js";
import { addUsage } from "./usage.js";

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
    let trace: ReturnType<typeof createTraceRecorder>;
    try {
      const config = applyModelPreset(deps.config ?? loadConfig(), model.id);
      const upstream = deps.upstream ?? compatUpstreamClient;
      const policy = chooseMode(config, {
        alias: model.id,
        latestUserText: latestUserText(context, true),
        hasToolResults: hasRecentToolResults(context),
      });
      trace = createTraceRecorder(config, model, context, policy);

      const primaryContext = stripMarkersFromContext(context);
      let finalContext = primaryContext;
      let advisor: AdvisorResult | undefined;
      let fullMoa: FullMoaResult | undefined;
      if (policy.mode === "advisor") {
        advisor = await runAdvisor(config, context, policy, upstream, options, trace);
        finalContext = withAdvisorGuidance(primaryContext, advisor.text, policy);
      } else if (policy.mode === "full_moa") {
        fullMoa = await runFullMoa(config, context, policy, upstream, options, trace);
        finalContext = withFullMoaGuidance(primaryContext, fullMoa, policy);
      }

      trace?.recordFinalContext(finalContext);
      const primaryModel = routeToModel(config.primary);
      const inner = upstream.stream(primaryModel, finalContext, streamOptionsForRoute(config.primary, options));
      for await (const event of inner) {
        trace?.recordPrimaryEvent(event);
        if (event.type === "done") {
          const primaryUsage = event.message.usage;
          const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, primaryUsage);
          event.message.usage = combinedUsage;
          const diagnostic = moaDiagnostic(config, policy, advisor, fullMoa, primaryUsage, combinedUsage, trace?.filePath);
          event.message.diagnostics = [
            ...(event.message.diagnostics ?? []),
            diagnostic,
          ];
          trace?.finish(event.message, diagnostic.details);
        } else if (event.type === "error") {
          const primaryUsage = event.error.usage;
          const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, primaryUsage);
          event.error.usage = combinedUsage;
          const diagnostic = moaDiagnostic(config, policy, advisor, fullMoa, primaryUsage, combinedUsage, trace?.filePath);
          event.error.diagnostics = [
            ...(event.error.diagnostics ?? []),
            diagnostic,
          ];
          trace?.finishError(event.error, diagnostic.details);
        }
        stream.push(event);
      }
      stream.end();
    } catch (error) {
      trace?.fail(error);
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

function moaDiagnostic(
  config: GsdMoaConfig,
  policy: ReturnType<typeof chooseMode>,
  advisor: AdvisorResult | undefined,
  fullMoa: FullMoaResult | undefined,
  primaryUsage: AssistantMessage["usage"],
  combinedUsage: AssistantMessage["usage"],
  tracePath?: string,
): NonNullable<AssistantMessage["diagnostics"]>[number] {
  const details: MoaRunDetails & { combinedUsage: AssistantMessage["usage"]; tracePath?: string } = {
    mode: policy.mode,
    requestedMode: policy.requestedMode,
    reason: policy.reason,
    cacheHit: fullMoa
      ? fullMoa.innerCalls.every((call) => call.cacheHit === true)
      : advisor?.cacheHit,
    innerCalls: [
      ...(advisor
        ? [{ role: "reference" as const, provider: config.reference.provider, model: config.reference.model, usage: advisor.usage, cacheHit: advisor.cacheHit }]
        : []),
      ...(fullMoa?.innerCalls ?? []),
      { role: "primary" as const, provider: config.primary.provider, model: config.primary.model, usage: primaryUsage },
    ],
    ...(fullMoa ? { portfolio: fullMoa.portfolio } : {}),
    combinedUsage,
    ...(tracePath ? { tracePath } : {}),
  };
  return { type: "gsd-moa.details", timestamp: Date.now(), details: details as unknown as Record<string, unknown> };
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
