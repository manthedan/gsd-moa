import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { sanitizeReferenceContext } from "./context.js";
import { runReferenceCall } from "./reference-call.js";
import type { TraceRecorder } from "./trace.js";
import type { AdvisorResult, GsdMoaConfig, PolicyDecision, ToolObservationSummary } from "./types.js";
import type { UpstreamClient } from "./upstream.js";

export async function runAdvisor(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
  observationSummary?: ToolObservationSummary,
): Promise<AdvisorResult> {
  const referenceContext = buildAdvisorContext(config, context, policy, observationSummary);
  const result = await runReferenceCall(config, config.reference, referenceContext, {
    role: "reference",
    cacheScope: "advisor",
    promptVersion: config.prompts.advisorVersion,
  }, upstream, options, trace);
  return { text: result.text, usage: result.usage, cacheHit: result.cacheHit, key: result.key };
}

export function buildAdvisorContext(config: GsdMoaConfig, context: Context, policy: PolicyDecision, observationSummary?: ToolObservationSummary): Context {
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: config.reference.input?.includes("image") ?? false });
  return {
    ...safe,
    messages: observationSummary
      ? [...safe.messages, { role: "user", content: observationSummary.text, timestamp: Date.now() }]
      : safe.messages,
    systemPrompt: [
      `You are the configured reference model acting as a private advisor for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.advisorVersion}.`,
      `Give concise critique, risks, missing tests, and implementation advice.`,
      `Do not request or call tools. Do not produce patches.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}
