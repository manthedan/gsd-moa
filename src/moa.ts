import type { Context, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai/compat";
import { readReferenceCache, writeAdvisorCache } from "./cache.js";
import { resolveProposerRoute, resolveSynthesisRoute } from "./config.js";
import { assistantText, latestUserText, sanitizeReferenceContext } from "./context.js";
import type { TraceRecorder } from "./trace.js";
import type {
  FullMoaProposal,
  FullMoaProposerConfig,
  FullMoaResult,
  GsdMoaConfig,
  InnerCallDetails,
  PolicyDecision,
  PortfolioDecision,
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

  const portfolio = selectPortfolio(config, context, policy);
  const selected = portfolio.filter((decision) => decision.selected);
  if (selected.length === 0) throw new Error("full_moa mode selected no reference proposers");

  const proposersById = new Map(config.fullMoa.proposers.map((proposer) => [proposer.id, proposer]));
  const proposals = await Promise.all(
    selected.map((decision) => runProposer(config, context, policy, proposersById.get(decision.id)!, decision.reason, upstream, options, trace)),
  );

  const synthesis = config.fullMoa.synthesis.enabled
    ? await runSynthesis(config, context, policy, proposals, upstream, options, trace)
    : undefined;

  const guidance = formatReferenceBundle(proposals, synthesis?.text);
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
      selectionReason: proposal.selectionReason,
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

  return { proposals, synthesis, guidance, usage, innerCalls, portfolio };
}

async function runProposer(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposer: FullMoaProposerConfig,
  selectionReason: string,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<FullMoaProposal> {
  const route = resolveProposerRoute(config.reference, proposer, config.routePresets);
  const proposerContext = buildProposerContext(config, context, policy, proposer, route, selectionReason);
  const cache = readReferenceCache(config, proposerContext, route, `full_moa:reference:${proposer.id}`);
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
      selectionReason,
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
    selectionReason,
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
  const route = resolveSynthesisRoute(config.reference, config.fullMoa.synthesis, config.routePresets);
  const synthesisContext = buildSynthesisContext(config, context, policy, proposals, route);
  const cache = readReferenceCache(config, synthesisContext, route, "full_moa:synthesis");
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
  selectionReason?: string,
): Context {
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: route.input?.includes("image") ?? false });
  return {
    ...safe,
    systemPrompt: [
      `You are ${proposer.label} in a private Mixture-of-Agents reference layer for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.fullMoaVersion}. Reference id: ${proposer.id}.`,
      `You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files, repositories, or URLs, and you should not try to or apologize for being unable to. A separate final acting model has those capabilities and will take the actual actions.`,
      `The conversation below is the current state of a task handled by that acting model. Give your best private analysis of that state: understand the goal, reason about the problem, and advise on what to do next. Surface the best approach, concrete next steps and tool-use strategy, likely pitfalls and risks, and anything the acting model may miss or get wrong. Assume referenced files, URLs, or systems exist and reason from the context given rather than asking for access.`,
      `Respond with advice directly — no preamble, no disclaimers about tools or access. Your response is private guidance handed to the final acting model, not an answer shown to the user.`,
      selectionReason ? `Portfolio selection: ${selectionReason}.` : undefined,
      proposer.prompt,
      `Do not request or call tools. Do not claim to have changed files or executed commands.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].filter(Boolean).join("\n\n"),
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
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: route.input?.includes("image") ?? false });
  const proposalMessage: UserMessage = {
    role: "user",
    content: formatReferenceBundle(proposals, undefined, false),
    timestamp: Date.now(),
  };
  return {
    ...safe,
    messages: [...safe.messages, proposalMessage],
    systemPrompt: [
      `You are the private synthesizer layer in a Mixture-of-Agents provider for a Pi coding agent.`,
      `Prompt version: ${config.prompts.fullMoaVersion}.`,
      config.fullMoa.synthesis.prompt,
      `Do not request or call tools. Do not claim to have changed files or executed commands.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}

function formatReferenceBundle(proposals: FullMoaProposal[], synthesis?: string, includeRuntimeMetadata = true): string {
  return [
    "Full-MoA independent reference bundle:",
    ...proposals.map((proposal, index) => [
      `## Reference ${index + 1}: ${proposal.label}`,
      includeRuntimeMetadata
        ? `id=${proposal.id}; route=${proposal.provider}/${proposal.model}; cacheHit=${proposal.cacheHit}${proposal.selectionReason ? `; selected=${proposal.selectionReason}` : ""}`
        : `id=${proposal.id}; route=${proposal.provider}/${proposal.model}`,
      proposal.text.trim(),
    ].join("\n")),
    ...(synthesis ? ["## Synthesis", synthesis.trim()] : []),
  ].join("\n\n");
}

export function selectPortfolio(config: GsdMoaConfig, context: Context, policy: PolicyDecision): PortfolioDecision[] {
  const features = requestFeatures(context, policy);
  return config.fullMoa.proposers.map((proposer) => {
    if (proposer.enabled === false) {
      return { id: proposer.id, label: proposer.label, selected: false, reason: "disabled" };
    }
    if (features.explicitIncludes.has(proposer.id)) {
      return { id: proposer.id, label: proposer.label, selected: true, reason: "explicit include marker" };
    }
    if (!proposer.when || isEmptyWhen(proposer.when)) {
      return { id: proposer.id, label: proposer.label, selected: true, reason: "unconditional" };
    }
    const keyword = proposer.when.anyKeyword?.find((kw) => keywordMatches(features.text, kw));
    if (keyword) return { id: proposer.id, label: proposer.label, selected: true, reason: `keyword: ${keyword}` };
    const capability = proposer.when.anyCapability?.find((cap) => features.capabilities.has(cap));
    if (capability) return { id: proposer.id, label: proposer.label, selected: true, reason: `capability: ${capability}` };
    return { id: proposer.id, label: proposer.label, selected: false, reason: "conditional predicates did not match" };
  });
}

function keywordMatches(text: string, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  const pattern = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9_])${pattern}($|[^a-z0-9_])`, "i").test(text);
}

function isEmptyWhen(when: NonNullable<FullMoaProposerConfig["when"]>): boolean {
  return !when.anyKeyword?.length && !when.anyCapability?.length;
}

function requestFeatures(context: Context, policy: PolicyDecision): { text: string; capabilities: Set<string>; explicitIncludes: Set<string> } {
  const text = `${policy.strippedText}\n${latestUserText(context, true)}\n${JSON.stringify(context.messages ?? [])}`.toLowerCase();
  const capabilities = new Set<string>(["text"]);
  if (hasImageSignal(context, text)) capabilities.add("image");
  if (/\b(youtube|youtu\.be|video|mp4|mov|webm|transcribe|ocr|screen recording)\b/i.test(text)) capabilities.add("video");
  if (/\b(audio|podcast|mp3|wav|m4a|transcribe)\b/i.test(text)) capabilities.add("audio");
  return { text, capabilities, explicitIncludes: explicitIncludeIds(text) };
}

function hasImageSignal(context: Context, text: string): boolean {
  if (/\b(image|screenshot|diagram|ocr|png|jpe?g|gif|webp)\b/i.test(text)) return true;
  return JSON.stringify(context.messages ?? []).includes('\"type\":\"image\"');
}

function explicitIncludeIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:gsd-moa:include|moa:include)\s*=\s*([a-z0-9_.-]+)/gi)) ids.add(match[1]);
  return ids;
}
