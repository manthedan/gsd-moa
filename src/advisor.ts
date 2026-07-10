import type { Context, SimpleStreamOptions } from "./pi-compat.js";
import { benchmarkIntegrityReferenceLine, sanitizeReferenceContext } from "./context.js";
import { runReferenceCall } from "./reference-call.js";
import { formatReferenceTimeLine } from "./time.js";
import type { TraceRecorder } from "./trace.js";
import type { AdvisorResult, GsdMoaConfig, PolicyDecision, TimeState, ToolObservationSummary } from "./types.js";
import type { UpstreamClient } from "./upstream.js";

export async function runAdvisor(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Promise<AdvisorResult> {
  const referenceContext = buildAdvisorContext(config, context, policy, observationSummary, timeState);
  const result = await runReferenceCall(config, config.reference, referenceContext, {
    role: "reference",
    cacheScope: "advisor",
    promptVersion: config.prompts.advisorVersion,
  }, upstream, options, trace, timeState);
  return { text: result.text, usage: result.usage, cacheHit: result.cacheHit, key: result.key, durationMs: result.durationMs, effort: result.effort };
}

export function buildAdvisorContext(config: GsdMoaConfig, context: Context, policy: PolicyDecision, observationSummary?: ToolObservationSummary, timeState?: TimeState): Context {
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: config.reference.input?.includes("image") ?? false });
  return {
    ...safe,
    messages: observationSummary
      ? [...safe.messages, { role: "user", content: observationSummary.text, timestamp: Date.now() }]
      : safe.messages,
    systemPrompt: [
      `You are the configured reference model acting as a private advisor for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.advisorVersion}.`,
      policy.reason.startsWith("M3 verify_failure")
        ? `A verifier failed after the latest successful mutation. Return exactly four non-empty lines and no other prose, in this order: "Diagnosis: ...", "Next command: ...", "Expected signal: ...", "Stop condition: ...". Give exactly one discriminating command, label uncertainty in the diagnosis, and do not merely repeat the failed command.`
        : `Give concise critique, risks, missing tests, and implementation advice.`,
      `Do not request or call tools. Do not produce patches.`,
      benchmarkIntegrityReferenceLine(config),
      formatReferenceTimeLine(timeState),
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].filter(Boolean).join("\n"),
    tools: undefined,
  };
}
