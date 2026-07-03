import type { Context, SimpleStreamOptions, UserMessage } from "./pi-compat.js";
import { resolveProposerRoute, resolveSynthesisRoute } from "./config.js";
import { benchmarkIntegrityReferenceLine, latestUserText, redactSensitiveText, sanitizeReferenceContext } from "./context.js";
import { runReferenceCall } from "./reference-call.js";
import { formatReferenceTimeLine } from "./time.js";
import type { TraceRecorder } from "./trace.js";
import type {
  FullMoaFailure,
  FullMoaProposal,
  FullMoaProposerConfig,
  FullMoaResult,
  GsdMoaConfig,
  InnerCallDetails,
  PolicyDecision,
  PortfolioDecision,
  TimeState,
  ToolObservationSummary,
  UpstreamRoute,
} from "./types.js";
import type { UpstreamClient } from "./upstream.js";
import { addUsage } from "./usage.js";

export async function runFullMoa(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Promise<FullMoaResult> {
  if (!config.fullMoa.enabled) {
    throw new Error("full_moa mode requested but fullMoa.enabled is false");
  }

  const portfolio = selectPortfolio(config, context, policy);
  const selected = portfolio.filter((decision) => decision.selected);
  if (selected.length === 0) throw new Error("full_moa mode selected no reference proposers");

  const proposersById = new Map(config.fullMoa.proposers.map((proposer) => [proposer.id, proposer]));
  const settled = await Promise.allSettled(
    selected.map((decision) => runProposer(config, context, policy, proposersById.get(decision.id)!, decision.reason, upstream, options, trace, observationSummary, timeState)),
  );
  const proposals = settled
    .filter((result): result is PromiseFulfilledResult<FullMoaProposal> => result.status === "fulfilled")
    .map((result) => result.value);
  const failures: FullMoaFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const decision = selected[index]!;
      failures.push({ id: decision.id, label: decision.label, message: safeErrorMessage(result.reason) });
    }
  });
  const failedById = new Map(failures.map((failure) => [failure.id, failure.message]));
  const finalPortfolio = portfolio.map((decision) => {
    const failure = failedById.get(decision.id);
    return failure ? { ...decision, selected: true, reason: `failed: ${failure}` } : decision;
  });
  if (proposals.length === 0) throw new Error(`all full_moa proposers failed: ${failures.map((failure) => failure.message).join("; ")}`);

  let synthesis: NonNullable<FullMoaResult["synthesis"]> | undefined;
  let synthesisError: string | undefined;
  if (config.fullMoa.synthesis.enabled) {
    try {
      synthesis = await runSynthesis(config, context, policy, proposals, failures, upstream, options, trace, observationSummary, timeState);
    } catch (error) {
      synthesisError = safeErrorMessage(error);
      synthesis = undefined;
    }
  }

  const guidance = formatReferenceBundle(proposals, failures, synthesis?.text);
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
      durationMs: proposal.durationMs,
      selectionReason: proposal.selectionReason,
      effort: proposal.effort,
    })),
    ...(synthesis
      ? [{
          role: "synthesizer" as const,
          provider: synthesis.provider,
          model: synthesis.model,
          usage: synthesis.usage,
          cacheHit: synthesis.cacheHit,
          durationMs: synthesis.durationMs,
          effort: synthesis.effort,
        }]
      : []),
  ];

  return { proposals, failures, synthesis, synthesisError, guidance, usage, innerCalls, portfolio: finalPortfolio };
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
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Promise<FullMoaProposal> {
  const route = resolveProposerRoute(config.reference, proposer, config.routePresets);
  const proposerContext = buildProposerContext(config, context, policy, proposer, route, selectionReason, observationSummary, timeState);
  const result = await runReferenceCall(config, route, proposerContext, {
    role: "proposer",
    id: proposer.id,
    label: proposer.label,
    cacheScope: `full_moa:reference:${proposer.id}`,
    promptVersion: config.prompts.fullMoaVersion,
    maxTokens: proposer.maxTokens,
  }, upstream, options, trace, timeState);
  return {
    id: proposer.id,
    label: proposer.label,
    text: result.text,
    usage: result.usage,
    cacheHit: result.cacheHit,
    provider: result.provider,
    model: result.model,
    key: result.key,
    durationMs: result.durationMs,
    selectionReason,
    effort: result.effort,
  };
}

async function runSynthesis(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposals: FullMoaProposal[],
  failures: FullMoaFailure[],
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Promise<NonNullable<FullMoaResult["synthesis"]>> {
  const route = resolveSynthesisRoute(config.reference, config.fullMoa.synthesis, config.routePresets);
  const synthesisContext = buildSynthesisContext(config, context, policy, proposals, failures, route, observationSummary, timeState);
  const result = await runReferenceCall(config, route, synthesisContext, {
    role: "synthesizer",
    cacheScope: "full_moa:synthesis",
    promptVersion: config.prompts.fullMoaVersion,
  }, upstream, options, trace, timeState);
  return {
    text: result.text,
    usage: result.usage,
    cacheHit: result.cacheHit,
    provider: result.provider,
    model: result.model,
    key: result.key,
    durationMs: result.durationMs,
    effort: result.effort,
  };
}

export function buildProposerContext(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  proposer: FullMoaProposerConfig,
  route: UpstreamRoute = config.reference,
  selectionReason?: string,
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Context {
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: route.input?.includes("image") ?? false });
  return {
    ...safe,
    messages: observationSummary
      ? [...safe.messages, { role: "user", content: observationSummary.text, timestamp: Date.now() } satisfies UserMessage]
      : safe.messages,
    systemPrompt: [
      `You are ${proposer.label} in a private Mixture-of-Agents reference layer for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.fullMoaVersion}. Reference id: ${proposer.id}.`,
      `You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files, repositories, or URLs, and you should not try to or apologize for being unable to. A separate final acting model has those capabilities and will take the actual actions.`,
      `The conversation below is the current state of a task handled by that acting model. Give your best private analysis of that state: understand the goal, reason about the problem, and advise on what to do next. Surface the best approach, concrete next steps and tool-use strategy, likely pitfalls and risks, and anything the acting model may miss or get wrong. Assume referenced files, URLs, or systems exist and reason from the context given rather than asking for access.`,
      `Respond with advice directly — no preamble, no disclaimers about tools or access. Your response is private guidance handed to the final acting model, not an answer shown to the user.`,
      selectionReason ? `Portfolio selection: ${selectionReason}.` : undefined,
      proposer.prompt,
      `Do not request or call tools. Do not claim to have changed files or executed commands.`,
      benchmarkIntegrityReferenceLine(config),
      formatReferenceTimeLine(timeState),
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
  failures: FullMoaFailure[] = [],
  route: UpstreamRoute = config.reference,
  observationSummary?: ToolObservationSummary,
  timeState?: TimeState,
): Context {
  const safe = sanitizeReferenceContext(context, policy, { preserveImages: route.input?.includes("image") ?? false });
  const proposalMessage: UserMessage = {
    role: "user",
    content: formatReferenceBundle(proposals, failures, undefined, false),
    timestamp: Date.now(),
  };
  return {
    ...safe,
    messages: [
      ...safe.messages,
      ...(observationSummary ? [{ role: "user", content: observationSummary.text, timestamp: Date.now() } satisfies UserMessage] : []),
      proposalMessage,
    ],
    systemPrompt: [
      `You are the private synthesizer layer in a Mixture-of-Agents provider for a Pi coding agent.`,
      `Prompt version: ${config.prompts.fullMoaVersion}.`,
      config.fullMoa.synthesis.prompt,
      `Do not request or call tools. Do not claim to have changed files or executed commands.`,
      benchmarkIntegrityReferenceLine(config),
      formatReferenceTimeLine(timeState),
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}

function formatReferenceBundle(proposals: FullMoaProposal[], failures: FullMoaFailure[] = [], synthesis?: string, includeRuntimeMetadata = true): string {
  return [
    "Full-MoA independent reference bundle:",
    ...proposals.map((proposal, index) => [
      `## Reference ${index + 1}: ${proposal.label}`,
      includeRuntimeMetadata
        ? `id=${proposal.id}; route=${proposal.provider}/${proposal.model}; cacheHit=${proposal.cacheHit}${proposal.selectionReason ? `; selected=${proposal.selectionReason}` : ""}`
        : `id=${proposal.id}; route=${proposal.provider}/${proposal.model}`,
      proposal.text.trim(),
    ].join("\n")),
    ...failures.map((failure, index) => `Reference ${proposals.length + index + 1}: ${failure.label} — [failed: ${failure.message}]`),
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
  const text = `${policy.strippedText}\n${latestUserText(context, true)}`.toLowerCase();
  const capabilities = new Set<string>(["text"]);
  if (hasImageSignal(context, text)) capabilities.add("image");
  if (/\b(youtube|youtu\.be|video|mp4|mov|webm|transcribe|ocr|screen recording)\b/i.test(text)) capabilities.add("video");
  if (/\b(audio|podcast|mp3|wav|m4a|transcribe)\b/i.test(text)) capabilities.add("audio");
  return { text, capabilities, explicitIncludes: explicitIncludeIds(text) };
}

function hasImageSignal(context: Context, text: string): boolean {
  if (/\b(image|screenshot|diagram|ocr|png|jpe?g|gif|webp)\b/i.test(text)) return true;
  return context.messages.some((message) => {
    if (message.role !== "user") return false;
    if (typeof message.content === "string") return false;
    return message.content.some((item) => item.type === "image");
  });
}

function explicitIncludeIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:gsd-moa:include|moa:include)\s*=\s*([a-z0-9_.-]+)/gi)) ids.add(match[1]);
  return ids;
}

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
