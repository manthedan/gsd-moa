import type { Context, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai/compat";
import { readAdvisorCache, writeAdvisorCache } from "./cache.js";
import { mergeUpstreamRoute } from "./config.js";
import { assistantText, sanitizeReferenceContext } from "./context.js";
import type { TraceRecorder } from "./trace.js";
import type {
  FullMoaProposal,
  FullMoaProposerConfig,
  FullMoaResult,
  GsdMoaConfig,
  InnerCallDetails,
  PolicyDecision,
  UpstreamRoute,
} from "./types.js";
import { routeToModel, streamOptionsForRoute, type UpstreamClient } from "./upstream.js";
import { addUsage } from "./usage.js";

export async function runFullMoa(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<FullMoaResult> {
  if (!config.fullMoa.enabled) {
    throw new Error("full_moa mode requested but fullMoa.enabled is false");
  }

  const proposals = await Promise.all(
    config.fullMoa.proposers.map((proposer) => runProposer(config, context, policy, proposer, upstream, options, trace)),
  );

  const synthesis = config.fullMoa.synthesis.enabled
    ? await runSynthesis(config, context, policy, proposals, upstream, options, trace)
    : undefined;

  const guidance = formatProposalBundle(proposals, synthesis?.text);
  const usage = addUsage(...proposals.map((proposal) => proposal.usage), synthesis?.usage);
  const innerCalls: InnerCallDetails[] = [
    ...proposals.map((proposal) => ({
      role: "proposer" as const,
      id: proposal.id,
      label: proposal.label,
      provider: proposal.provider,
      model: proposal.model,
      usage: proposal.usage,
      cacheHit: proposal.cacheHit,
    })),
    ...(synthesis
      ? [{
          role: "synthesizer" as const,
          provider: synthesis.provider,
          model: synthesis.model,
          usage: synthesis.usage,
          cacheHit: synthesis.cacheHit,
        }]
      : []),
  ];

  return { proposals, synthesis, guidance, usage, innerCalls };
}

async function runProposer(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposer: FullMoaProposerConfig,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<FullMoaProposal> {
  const route = fullMoaRoute(config.reference, proposer.route);
  const proposerContext = buildProposerContext(config, context, policy, proposer, route);
  const cache = readAdvisorCache(config, proposerContext);
  const startedAt = Date.now();
  if (cache.hit) {
    trace?.recordReferenceCall({
      role: "proposer",
      id: proposer.id,
      label: proposer.label,
      route,
      context: proposerContext,
      cacheHit: true,
      cacheKey: cache.key,
      cachedText: cache.text,
      startedAt,
      endedAt: Date.now(),
    });
    return {
      id: proposer.id,
      label: proposer.label,
      text: cache.text,
      usage: undefined,
      cacheHit: true,
      provider: route.provider,
      model: route.model,
      key: cache.key,
    };
  }

  const model = routeToModel(route);
  const message = await upstream.complete(model, proposerContext, streamOptionsForRoute(route, options));
  const text = assistantText(message).trim();
  writeAdvisorCache(config, cache.key, text, message.usage);
  trace?.recordReferenceCall({
    role: "proposer",
    id: proposer.id,
    label: proposer.label,
    route,
    context: proposerContext,
    message,
    cacheHit: false,
    cacheKey: cache.key,
    startedAt,
    endedAt: Date.now(),
  });
  return {
    id: proposer.id,
    label: proposer.label,
    text,
    usage: message.usage,
    cacheHit: false,
    provider: route.provider,
    model: route.model,
    key: cache.key,
  };
}

async function runSynthesis(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposals: FullMoaProposal[],
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<NonNullable<FullMoaResult["synthesis"]>> {
  const route = fullMoaRoute(config.reference, config.fullMoa.synthesis.route);
  const synthesisContext = buildSynthesisContext(config, context, policy, proposals, route);
  const cache = readAdvisorCache(config, synthesisContext);
  const startedAt = Date.now();
  if (cache.hit) {
    trace?.recordReferenceCall({
      role: "synthesizer",
      route,
      context: synthesisContext,
      cacheHit: true,
      cacheKey: cache.key,
      cachedText: cache.text,
      startedAt,
      endedAt: Date.now(),
    });
    return {
      text: cache.text,
      usage: undefined,
      cacheHit: true,
      provider: route.provider,
      model: route.model,
      key: cache.key,
    };
  }

  const model = routeToModel(route);
  const message = await upstream.complete(model, synthesisContext, streamOptionsForRoute(route, options));
  const text = assistantText(message).trim();
  writeAdvisorCache(config, cache.key, text, message.usage);
  trace?.recordReferenceCall({
    role: "synthesizer",
    route,
    context: synthesisContext,
    message,
    cacheHit: false,
    cacheKey: cache.key,
    startedAt,
    endedAt: Date.now(),
  });
  return {
    text,
    usage: message.usage,
    cacheHit: false,
    provider: route.provider,
    model: route.model,
    key: cache.key,
  };
}

export function buildProposerContext(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposer: FullMoaProposerConfig,
  route: UpstreamRoute = config.reference,
): Context {
  const safe = sanitizeReferenceContext(context, policy);
  return {
    ...safe,
    systemPrompt: [
      `You are ${proposer.label} in a private full-MoA layer for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.fullMoaVersion}. Proposer id: ${proposer.id}.`,
      `Reference route: ${route.provider}/${route.model}; api=${route.api ?? "default"}; baseUrl=${route.baseUrl ?? "default"}.`,
      proposer.prompt,
      `Produce an independent proposal or critique. Do not request or call tools. Do not produce repository patches.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}

export function buildSynthesisContext(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposals: FullMoaProposal[],
  route: UpstreamRoute = config.reference,
): Context {
  const safe = sanitizeReferenceContext(context, policy);
  const proposalMessage: UserMessage = {
    role: "user",
    content: formatProposalBundle(proposals, undefined, false),
    timestamp: Date.now(),
  };
  return {
    ...safe,
    messages: [...safe.messages, proposalMessage],
    systemPrompt: [
      `You are the private synthesizer layer in a full-MoA provider for a Pi coding agent.`,
      `Prompt version: ${config.prompts.fullMoaVersion}.`,
      `Reference route: ${route.provider}/${route.model}; api=${route.api ?? "default"}; baseUrl=${route.baseUrl ?? "default"}.`,
      config.fullMoa.synthesis.prompt,
      `Do not request or call tools. Do not produce repository patches.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}

function formatProposalBundle(proposals: FullMoaProposal[], synthesis?: string, includeRuntimeMetadata = true): string {
  return [
    "Full-MoA independent proposal bundle:",
    ...proposals.map((proposal, index) => [
      `## Proposal ${index + 1}: ${proposal.label}`,
      includeRuntimeMetadata
        ? `id=${proposal.id}; route=${proposal.provider}/${proposal.model}; cacheHit=${proposal.cacheHit}`
        : `id=${proposal.id}; route=${proposal.provider}/${proposal.model}`,
      proposal.text.trim(),
    ].join("\n")),
    ...(synthesis ? ["## Synthesis", synthesis.trim()] : []),
  ].join("\n\n");
}

function fullMoaRoute(reference: UpstreamRoute, override: Partial<UpstreamRoute> | undefined): UpstreamRoute {
  return mergeUpstreamRoute(reference, override);
}
