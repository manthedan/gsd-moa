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
import { buildToolObservationSummary, isToolLoopContinuation, latestMessageHasMoaMarker, latestUserText, redactSensitiveText, stripMarkersFromContext, withAdvisorGuidance, withFullMoaGuidance } from "./context.js";
import { runFullMoa } from "./moa.js";
import { chooseAction, chooseMode } from "./policy.js";
import { applyModelPreset } from "./presets.js";
import { createTraceRecorder } from "./trace.js";
import type { AdvisorResult, FullMoaResult, GsdMoaConfig, MoaAction, MoaRunDetails } from "./types.js";
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
      const contextIsToolLoopContinuation = isToolLoopContinuation(context);
      const recentToolSummary = contextIsToolLoopContinuation ? buildToolObservationSummary(context, config.checkpoint.maxToolResults) : undefined;
      const policyInput = {
        alias: model.id,
        latestUserText: latestUserText(context, true),
        hasToolResults: contextIsToolLoopContinuation,
        hasFreshMoaMarker: latestMessageHasMoaMarker(context),
        recentToolSummary,
      };
      const requestedPolicy = chooseMode(config, policyInput);
      const action = chooseAction(config, requestedPolicy, policyInput);
      const policy = action.kind === "run"
        ? { ...requestedPolicy, mode: action.mode, reason: action.reason }
        : { ...requestedPolicy, mode: "single" as const, reason: action.reason };
      let diagnosticPolicy = policy;
      trace = createTraceRecorder(config, model, context, policy, action);

      const primaryContext = stripMarkersFromContext(context);
      let finalContext = primaryContext;
      let advisor: AdvisorResult | undefined;
      let fullMoa: FullMoaResult | undefined;
      let guidanceInjected: boolean | undefined;
      let guidanceSkippedReason: string | undefined;
      if (action.kind === "run" && action.mode === "advisor") {
        try {
          advisor = await runAdvisor(config, context, policy, upstream, options, trace, action.observationSummary);
          guidanceInjected = true;
          finalContext = withAdvisorGuidance(primaryContext, advisor.text, policy);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          trace?.recordReferenceLayerFailure("advisor", error);
          guidanceInjected = false;
          guidanceSkippedReason = `advisor failed: ${safeErrorMessage(error)}`;
          diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
        }
      } else if (action.kind === "run" && action.mode === "full_moa") {
        try {
          fullMoa = await runFullMoa(config, context, policy, upstream, options, trace, action.observationSummary);
          guidanceInjected = true;
          finalContext = withFullMoaGuidance(primaryContext, fullMoa, policy);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          trace?.recordReferenceLayerFailure("full_moa", error);
          guidanceInjected = false;
          guidanceSkippedReason = `full_moa failed: ${safeErrorMessage(error)}`;
          diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
        }
      } else if (requestedPolicy.mode !== "single" && contextIsToolLoopContinuation) {
        guidanceInjected = false;
        guidanceSkippedReason = action.reason;
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
          const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage, trace?.filePath, guidanceInjected, guidanceSkippedReason);
          event.message.diagnostics = [
            ...(event.message.diagnostics ?? []),
            diagnostic,
          ];
          trace?.finish(event.message, diagnostic.details);
        } else if (event.type === "error") {
          const primaryUsage = event.error.usage;
          const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, primaryUsage);
          event.error.usage = combinedUsage;
          const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage, trace?.filePath, guidanceInjected, guidanceSkippedReason);
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
  action: MoaAction,
  advisor: AdvisorResult | undefined,
  fullMoa: FullMoaResult | undefined,
  primaryUsage: AssistantMessage["usage"],
  combinedUsage: AssistantMessage["usage"],
  tracePath?: string,
  guidanceInjected?: boolean,
  guidanceSkippedReason?: string,
): NonNullable<AssistantMessage["diagnostics"]>[number] {
  const details: MoaRunDetails & { combinedUsage: AssistantMessage["usage"]; tracePath?: string } = {
    mode: policy.mode,
    requestedMode: policy.requestedMode,
    reason: policy.reason,
    ...(action.kind === "run" ? { checkpointScope: action.scope } : {}),
    ...(action.kind === "run" && action.observationSummary ? {
      observationDigest: action.observationSummary.digest,
      observationToolResultCount: action.observationSummary.toolResultCount,
      observationLatestFailureSignals: action.observationSummary.latestFailureSignals,
      observationFailureSignals: action.observationSummary.failureSignals,
      observationFilesMentioned: action.observationSummary.filesMentioned,
    } : {}),
    cacheHit: fullMoa
      ? fullMoa.innerCalls.every((call) => call.cacheHit === true)
      : advisor?.cacheHit,
    guidanceInjected,
    ...(guidanceSkippedReason ? { guidanceSkippedReason } : {}),
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

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
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
