import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "./pi-compat.js";
import { runAdvisor } from "./advisor.js";
import { asyncAdvisorUnattributedUsage, maybeUseAsyncAdvisor, type AsyncAdvisorDecision } from "./async-advisor.js";
import { loadConfig } from "./config.js";
import { assistantText, buildToolObservationSummary, countAdvisorInjections, isToolLoopContinuation, latestMessageHasMoaMarker, latestUserText, redactSensitiveText, stripMarkersFromContext, withAdvisorGuidance, withBenchmarkIntegrityNote, withFullMoaGuidance, withTimeAwarenessNote } from "./context.js";
import { FullMoaError, runFullMoa } from "./moa.js";
import { chooseAction, chooseMode } from "./policy.js";
import { ReferenceCallError } from "./reference-call.js";
import { applyModelPreset } from "./presets.js";
import { doneGateLedgerKey, readDoneGateLedger, recordDoneGateFire, shouldArmDoneGate, withDoneGateNote } from "./done-gate.js";
import { readRescueLedger, recordRescue, rescueLedgerKey } from "./rescue-ledger.js";
import { assistantRequestsVerifier, buildSessionStateSummary, type SessionStateSummary } from "./session-state.js";
import { timeEnvFromProcess, computeTimeState } from "./time.js";
import { createTraceRecorder } from "./trace.js";
import type { AdvisorResult, FullMoaResult, GsdMoaConfig, InnerCallDetails, MoaAction, MoaRunDetails, PolicyInput, TimeState } from "./types.js";
import { effortForTrace, routeToModel, streamOptionsForRoute, type UpstreamClient, compatUpstreamClient } from "./upstream.js";
import { addUsage } from "./usage.js";

export interface StreamDependencies {
  config?: GsdMoaConfig;
  upstream?: UpstreamClient;
}

interface DoneGateRunDiagnostic {
  armed: boolean;
  fired: boolean;
  armReason?: string;
  suppressedReason?: string;
  filesModified: boolean;
  verifierRan: boolean;
  lastVerifierPassed?: boolean;
  commandsRun: number;
  firstStopReason?: string;
  postGateBehavior?: "verification-requested" | "justified" | "ignored" | "incomplete" | "error";
}

export function assembleMoaPolicyInput(
  config: GsdMoaConfig,
  aliasId: string,
  context: Context,
  timeState?: TimeState,
  sessionId?: string,
): PolicyInput {
  const contextIsToolLoopContinuation = isToolLoopContinuation(context);
  const recentToolSummary = contextIsToolLoopContinuation ? buildToolObservationSummary(context, config.checkpoint.maxToolResults) : undefined;
  const contextInjections = countAdvisorInjections(context);
  const ledgerEntry = readRescueLedger(rescueLedgerKey(aliasId, context, sessionId));
  const ledgerToolResultsSinceLast = ledgerEntry
    ? Math.max(0, (recentToolSummary?.totalToolResultCount ?? 0) - ledgerEntry.totalToolResultsAtLast)
    : Number.MAX_SAFE_INTEGER;
  const aliasConfig = config.aliases[aliasId];
  const effectiveScopes = { ...config.checkpoint.scopes, ...(aliasConfig?.checkpointScopes ?? {}) };
  return {
    alias: aliasId,
    latestUserText: latestUserText(context, true),
    hasToolResults: contextIsToolLoopContinuation,
    hasFreshMoaMarker: latestMessageHasMoaMarker(context),
    recentToolSummary,
    timeState,
    advisorInjectionCount: Math.max(contextInjections.count, ledgerEntry?.count ?? 0),
    toolResultsSinceLastInjection: Math.min(contextInjections.toolResultsSinceLast, ledgerToolResultsSinceLast),
    effectiveScopes,
  };
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
    let buildTerminalError: ((error: unknown, aborted: boolean) => AssistantMessage) | undefined;
    try {
      const config = applyModelPreset(deps.config ?? loadConfig(), model.id);
      const upstream = deps.upstream ?? compatUpstreamClient;
      const timeState = computeTimeState(config.timeAware, timeEnvFromProcess(), Date.now());
      const policyInput = assembleMoaPolicyInput(config, model.id, context, timeState, options?.sessionId);
      const contextIsToolLoopContinuation = Boolean(policyInput.hasToolResults);
      const recentToolSummary = policyInput.recentToolSummary;
      const rescueKey = rescueLedgerKey(model.id, context, options?.sessionId);
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
      let asyncAdvisor: AsyncAdvisorDecision | undefined;
      const failedReferenceCalls: InnerCallDetails[] = [];
      let doneGateDetails: DoneGateRunDiagnostic | undefined;
      let primaryEffort: string | undefined;
      let primaryStarted = false;
      let priorPrimaryUsageForError: AssistantMessage["usage"] | undefined;
      // Install terminal accounting before reference calls and primary route setup:
      // cancellation or configuration failures after billed inner work must retain it.
      buildTerminalError = (error, aborted) => {
        const errorMessage = makeErrorMessage(model, error, aborted);
        const primaryUsage = errorMessage.usage;
        if (doneGateDetails?.fired) doneGateDetails = { ...doneGateDetails, postGateBehavior: "error" };
        const combinedUsage = addUsage(
          advisor?.usage,
          fullMoa?.usage,
          ...failedReferenceCalls.map((call) => call.usage),
          priorPrimaryUsageForError,
          primaryUsage,
        );
        errorMessage.usage = combinedUsage;
        const diagnostic = moaDiagnostic(
          config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage,
          primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState,
          asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls,
          priorPrimaryUsageForError,
          primaryStarted,
        );
        errorMessage.diagnostics = [...(errorMessage.diagnostics ?? []), diagnostic];
        trace?.finishError(errorMessage, diagnostic.details);
        return errorMessage;
      };
      if (action.kind === "run" && action.mode === "advisor") {
        asyncAdvisor = maybeUseAsyncAdvisor(config, model, context, policy, action, upstream, options, timeState);
        if (asyncAdvisor) {
          if (asyncAdvisor.status === "injected" && asyncAdvisor.advisor) {
            advisor = asyncAdvisor.advisor;
            guidanceInjected = true;
            finalContext = withAdvisorGuidance(primaryContext, advisor.text, policy);
          } else {
            guidanceInjected = false;
            guidanceSkippedReason = asyncAdvisor.status === "failed"
              ? `async advisor failed: ${asyncAdvisor.error ?? "unknown error"}`
              : `async advisor ${asyncAdvisor.status}`;
            if (asyncAdvisor.failureDetails) failedReferenceCalls.push(referenceFailureCall(asyncAdvisor.failureDetails, "reference", asyncAdvisor.error));
            diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
          }
        } else {
          try {
            advisor = await runAdvisor(config, context, policy, upstream, options, trace, action.observationSummary, timeState);
            guidanceInjected = true;
            finalContext = withAdvisorGuidance(primaryContext, advisor.text, policy);
          } catch (error) {
            if (error instanceof ReferenceCallError) failedReferenceCalls.push(referenceFailureCall(error.details, "reference", safeErrorMessage(error)));
            if (options?.signal?.aborted) throw error;
            trace?.recordReferenceLayerFailure("advisor", error);
            guidanceInjected = false;
            guidanceSkippedReason = `advisor failed: ${safeErrorMessage(error)}`;
            diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
          }
        }
      } else if (action.kind === "run" && action.mode === "full_moa") {
        try {
          fullMoa = await runFullMoa(config, context, policy, upstream, options, trace, action.observationSummary, timeState);
          if (options?.signal?.aborted) {
            throw options.signal.reason instanceof Error ? options.signal.reason : new Error("full_moa aborted");
          }
          if (fullMoa.proposals.length > 0) {
            guidanceInjected = true;
            finalContext = withFullMoaGuidance(primaryContext, fullMoa, policy);
          } else {
            guidanceInjected = false;
            guidanceSkippedReason = `full_moa failed: all proposers failed: ${fullMoa.failures.map((failure) => failure.message).join("; ")}`;
            diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
          }
        } catch (error) {
          if (error instanceof FullMoaError) fullMoa = error.result;
          if (options?.signal?.aborted) throw error;
          trace?.recordReferenceLayerFailure("full_moa", error);
          guidanceInjected = false;
          guidanceSkippedReason = `full_moa failed: ${safeErrorMessage(error)}`;
          diagnosticPolicy = { ...policy, mode: "single", reason: guidanceSkippedReason };
        }
      } else if (requestedPolicy.mode !== "single" || (contextIsToolLoopContinuation && requestedPolicy.requestedMode !== "single")) {
        guidanceInjected = false;
        guidanceSkippedReason = action.reason;
      }

      if (guidanceInjected === true && action.kind === "run" && action.scope === "failure") {
        recordRescue(rescueKey, recentToolSummary?.totalToolResultCount ?? 0);
      }

      if (timeState) finalContext = withTimeAwarenessNote(finalContext, timeState);
      if (config.benchmarkIntegrity) finalContext = withBenchmarkIntegrityNote(finalContext);

      const doneGateKey = config.doneGate.enabled ? doneGateLedgerKey(model.id, context) : undefined;
      const sessionState = config.doneGate.enabled ? buildSessionStateSummary(context) : undefined;
      const doneGateDecision = sessionState && doneGateKey
        ? shouldArmDoneGate(config, context, sessionState, readDoneGateLedger(doneGateKey)?.count ?? 0, timeState)
        : undefined;
      doneGateDetails = doneGateDecision && sessionState ? doneGateDiagnostic(doneGateDecision.armed, false, doneGateDecision.reason, sessionState) : undefined;

      trace?.recordFinalContext(finalContext);
      const primaryModel = routeToModel(config.primary);
      const primaryOptions = streamOptionsForRoute(config.primary, options, config.defaultEffort);
      primaryEffort = effortForTrace(primaryOptions);
      trace?.recordPrimaryCall({ route: config.primary, effort: primaryEffort, startedAt: Date.now() });
      primaryStarted = true;
      const inner = upstream.stream(primaryModel, finalContext, primaryOptions);

      if (!doneGateDecision?.armed) {
        for await (const event of inner) {
          trace?.recordPrimaryEvent(event);
          if (event.type === "done") {
            const primaryUsage = event.message.usage;
            const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), primaryUsage);
            event.message.usage = combinedUsage;
            const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls);
            event.message.diagnostics = [
              ...(event.message.diagnostics ?? []),
              diagnostic,
            ];
            trace?.finish(event.message, diagnostic.details);
          } else if (event.type === "error") {
            const primaryUsage = event.error.usage;
            const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), primaryUsage);
            event.error.usage = combinedUsage;
            const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls);
            event.error.diagnostics = [
              ...(event.error.diagnostics ?? []),
              diagnostic,
            ];
            trace?.finishError(event.error, diagnostic.details);
          }
          stream.push(event);
        }
        stream.end();
        return;
      }

      const buffered: AssistantMessageEvent[] = [];
      for await (const event of inner) {
        trace?.recordPrimaryEvent(event);
        buffered.push(event);
        if (event.type === "error") {
          const primaryUsage = event.error.usage;
          const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), primaryUsage);
          event.error.usage = combinedUsage;
          doneGateDetails = doneGateDetails ? { ...doneGateDetails, firstStopReason: event.reason } : undefined;
          const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, primaryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls);
          event.error.diagnostics = [
            ...(event.error.diagnostics ?? []),
            diagnostic,
          ];
          trace?.finishError(event.error, diagnostic.details);
          for (const bufferedEvent of buffered) stream.push(bufferedEvent);
          stream.end();
          return;
        }
        if (event.type !== "done") continue;

        const firstPrimaryUsage = event.message.usage;
        doneGateDetails = doneGateDetails ? { ...doneGateDetails, firstStopReason: event.message.stopReason ?? event.reason } : undefined;
        if (assistantHasToolCalls(event.message) || event.reason !== "stop") {
          const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), firstPrimaryUsage);
          event.message.usage = combinedUsage;
          const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, firstPrimaryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls);
          event.message.diagnostics = [
            ...(event.message.diagnostics ?? []),
            diagnostic,
          ];
          trace?.finish(event.message, diagnostic.details);
          for (const bufferedEvent of buffered) stream.push(bufferedEvent);
          stream.end();
          return;
        }

        if (!doneGateKey) throw new Error("done gate key missing");
        recordDoneGateFire(doneGateKey);
        doneGateDetails = doneGateDetails ? { ...doneGateDetails, fired: true } : undefined;
        priorPrimaryUsageForError = firstPrimaryUsage;
        const retryContext = withDoneGateNote(finalContext);
        trace?.recordFinalContext(retryContext);
        trace?.recordPrimaryCall({ route: config.primary, effort: primaryEffort, startedAt: Date.now() });
        const retry = upstream.stream(primaryModel, retryContext, primaryOptions);
        for await (const retryEvent of retry) {
          trace?.recordPrimaryEvent(retryEvent);
          if (retryEvent.type === "done") {
            const retryUsage = retryEvent.message.usage;
            const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), firstPrimaryUsage, retryUsage);
            retryEvent.message.usage = combinedUsage;
            const postGateBehavior = classifyDoneGateRetry(retryEvent.message, retryEvent.reason, sessionState?.modifiedFiles ?? []);
            doneGateDetails = doneGateDetails ? { ...doneGateDetails, postGateBehavior } : undefined;
            const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, retryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls, firstPrimaryUsage);
            retryEvent.message.diagnostics = [
              ...(retryEvent.message.diagnostics ?? []),
              diagnostic,
            ];
            trace?.finish(retryEvent.message, diagnostic.details);
          } else if (retryEvent.type === "error") {
            const retryUsage = retryEvent.error.usage;
            const combinedUsage = addUsage(advisor?.usage, fullMoa?.usage, ...failedReferenceCalls.map((call) => call.usage), firstPrimaryUsage, retryUsage);
            retryEvent.error.usage = combinedUsage;
            doneGateDetails = doneGateDetails ? { ...doneGateDetails, postGateBehavior: "error" } : undefined;
            const diagnostic = moaDiagnostic(config, diagnosticPolicy, action, advisor, fullMoa, retryUsage, combinedUsage, primaryEffort, trace?.filePath, guidanceInjected, guidanceSkippedReason, timeState, asyncAdvisor, policyInput.advisorInjectionCount, doneGateDetails, failedReferenceCalls, firstPrimaryUsage);
            retryEvent.error.diagnostics = [
              ...(retryEvent.error.diagnostics ?? []),
              diagnostic,
            ];
            trace?.finishError(retryEvent.error, diagnostic.details);
          }
          stream.push(retryEvent);
        }
        stream.end();
        return;
      }
      stream.end();
    } catch (error) {
      const aborted = Boolean(options?.signal?.aborted);
      const errorMessage = buildTerminalError?.(error, aborted) ?? makeErrorMessage(model, error, aborted);
      if (!buildTerminalError) trace?.fail(error);
      stream.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: errorMessage,
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
  primaryEffort?: string,
  tracePath?: string,
  guidanceInjected?: boolean,
  guidanceSkippedReason?: string,
  timeState?: TimeState,
  asyncAdvisor?: AsyncAdvisorDecision,
  advisorInjectionCount?: number,
  doneGate?: DoneGateRunDiagnostic,
  failedReferenceCalls: InnerCallDetails[] = [],
  priorPrimaryUsage?: AssistantMessage["usage"],
  primaryStarted = true,
): NonNullable<AssistantMessage["diagnostics"]>[number] {
  const timeSuppressed = timeState && action.kind === "single" && action.reason.startsWith("time reserve") ? action.reason : undefined;
  const details: MoaRunDetails & { combinedUsage: AssistantMessage["usage"]; tracePath?: string } = {
    mode: policy.mode,
    requestedMode: policy.requestedMode,
    reason: policy.reason,
    ...(action.kind === "run" ? { checkpointScope: action.scope } : {}),
    ...(action.observationSummary ? {
      observationDigest: action.observationSummary.digest,
      observationToolResultCount: action.observationSummary.toolResultCount,
      observationLatestFailureSignals: action.observationSummary.latestFailureSignals,
      observationFailureSignals: action.observationSummary.failureSignals,
      rescueTrailingFailureStreak: action.observationSummary.trailingFailureStreak,
      ...(action.observationSummary.repeatedFailureSignature ? { rescueSignature: action.observationSummary.repeatedFailureSignature } : {}),
      ...(advisorInjectionCount !== undefined ? { rescueAdvisorInjectionCount: advisorInjectionCount } : {}),
      observationFilesMentioned: action.observationSummary.filesMentioned,
    } : {}),
    cacheHit: fullMoa
      ? fullMoa.innerCalls.length > 0 && fullMoa.innerCalls.every((call) => call.cacheHit === true)
      : advisor?.cacheHit,
    guidanceInjected,
    ...(guidanceSkippedReason ? { guidanceSkippedReason } : {}),
    ...(fullMoa?.synthesisError ? { synthesisFailedReason: fullMoa.synthesisError } : {}),
    ...(fullMoa?.failures.length ? { referenceFailures: fullMoa.failures } : {}),
    ...(config.benchmarkIntegrity ? { benchmarkIntegrity: true } : {}),
    ...(timeState ? {
      timeAware: {
        remainingMs: timeState.remainingMs,
        ...(timeState.elapsedMs !== undefined ? { elapsedMs: timeState.elapsedMs } : {}),
        ...(timeState.phase ? { phase: timeState.phase } : {}),
        ...(timeSuppressed ? { suppressed: timeSuppressed } : {}),
      },
    } : {}),
    ...(asyncAdvisorUnattributedUsage() ? { unattributedAsyncUsage: asyncAdvisorUnattributedUsage() } : {}),
    ...(asyncAdvisor ? {
      asyncAdvisor: {
        status: asyncAdvisor.status,
        ...(asyncAdvisor.ageMs !== undefined ? { ageMs: asyncAdvisor.ageMs } : {}),
        ...(asyncAdvisor.error ? { error: asyncAdvisor.error } : {}),
      },
    } : {}),
    ...(doneGate ? { doneGate } : {}),
    innerCalls: [
      ...(advisor
        ? [{ role: "reference" as const, provider: config.reference.provider, model: config.reference.model, usage: advisor.usage, cacheHit: advisor.cacheHit, durationMs: advisor.durationMs, effort: advisor.effort }]
        : []),
      ...(fullMoa?.innerCalls ?? []),
      ...failedReferenceCalls,
      ...(priorPrimaryUsage ? [{ role: "primary" as const, provider: config.primary.provider, model: config.primary.model, usage: priorPrimaryUsage, effort: primaryEffort }] : []),
      ...(primaryStarted ? [{ role: "primary" as const, provider: config.primary.provider, model: config.primary.model, usage: primaryUsage, effort: primaryEffort }] : []),
    ],
    ...(fullMoa ? { portfolio: fullMoa.portfolio } : {}),
    combinedUsage,
    ...(tracePath ? { tracePath } : {}),
  };
  return { type: "gsd-moa.details", timestamp: Date.now(), details: details as unknown as Record<string, unknown> };
}

function referenceFailureCall(details: ReferenceCallError["details"], role: "reference" | "synthesizer", error?: string): InnerCallDetails {
  return {
    role,
    provider: details.provider,
    model: details.model,
    usage: details.usage,
    cacheHit: details.cacheHit,
    durationMs: details.durationMs,
    effort: details.effort,
    ...(error ? { error } : {}),
  };
}

function doneGateDiagnostic(armed: boolean, fired: boolean, reason: string, sessionState: SessionStateSummary): DoneGateRunDiagnostic {
  return {
    armed,
    fired,
    ...(armed ? { armReason: reason } : { suppressedReason: reason }),
    filesModified: sessionState.filesModified,
    verifierRan: sessionState.verifierRan,
    ...(sessionState.lastVerifierPassed !== undefined ? { lastVerifierPassed: sessionState.lastVerifierPassed } : {}),
    commandsRun: sessionState.commandsRun,
  };
}

function classifyDoneGateRetry(message: AssistantMessage, eventReason: string, modifiedFiles: string[]): NonNullable<DoneGateRunDiagnostic["postGateBehavior"]> {
  if (assistantHasToolCalls(message)) return assistantRequestsVerifier(message, modifiedFiles) ? "verification-requested" : "ignored";
  if (eventReason !== "stop" || message.stopReason !== "stop") return "incomplete";
  const text = assistantText(message);
  const inability = /\b(cannot|can't|unable|impossible|unavailable|not installed|missing|no access|not accessible)\b/i.test(text);
  const verificationContext = /\b(test|tests|verify|verification|checker|execute|execution|run|environment|dependency|tool)\b/i.test(text);
  return inability && verificationContext ? "justified" : "ignored";
}

function assistantHasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((item) => {
    const type = (item as { type?: unknown }).type;
    return type === "toolCall" || type === "tool-call";
  });
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
