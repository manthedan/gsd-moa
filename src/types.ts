import type { Api, Model, ThinkingLevelMap, Usage } from "./pi-compat.js";

export const PROVIDER_ID = "gsd-moa" as const;

export type MoaMode = "single" | "advisor" | "full_moa";
export type AliasMode = MoaMode | "auto";
export type ModelRef = string | { provider: string; model: string };
export type InputCapability = "text" | "image" | "video" | "audio";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type DefaultReasoningEffort = ReasoningEffort | "inherit";

export interface UpstreamRoute {
  provider: string;
  model: string;
  api?: Api;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  reasoning?: boolean;
  effort?: ReasoningEffort;
  temperature?: number;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

export type RoutePresetConfig = Partial<UpstreamRoute>;

export interface AliasConfig {
  mode: AliasMode;
}

export interface AutoPolicyConfig {
  defaultMode: MoaMode;
  advisorKeywords: string[];
  fullMoaKeywords: string[];
  singleKeywords: string[];
}

export interface CacheConfig {
  enabled: boolean;
  dir: string;
  ttlSeconds: number;
}

export interface TraceConfig {
  enabled: boolean;
  dir: string;
  includeContexts: boolean;
  includeOutputs: boolean;
}

export interface PromptConfig {
  advisorVersion: string;
  fullMoaVersion: string;
}

export interface CheckpointPolicyConfig {
  enabled: boolean;
  maxToolResults: number;
  driftToolResultThreshold: number;
}

export type TimePhase = "explore" | "implement" | "validate" | "reserve";

export interface TimeAwareConfig {
  enabled: boolean;
  reserveRatio: number;
  exploreRatio: number;
  implementRatio: number;
  validateRatio: number;
  graceRatio: number;
  minReserveMs: number;
  downgradeInValidate: boolean;
}

export interface AsyncAdvisorConfig {
  enabled: boolean;
  maxPendingMs: number;
}

export interface TimeState {
  remainingMs: number;
  elapsedMs?: number;
  budgetMs?: number;
  phase?: TimePhase;
  inReserve: boolean;
}

export interface ReferenceWhenConfig {
  anyCapability?: InputCapability[];
  anyKeyword?: string[];
}

export interface FullMoaProposerConfig {
  id: string;
  label: string;
  enabled?: boolean;
  prompt?: string;
  modelRef?: ModelRef;
  routePreset?: string;
  route?: Partial<UpstreamRoute>;
  when?: ReferenceWhenConfig;
  maxTokens?: number;
}

export interface FullMoaSynthesisConfig {
  enabled: boolean;
  prompt: string;
  modelRef?: ModelRef;
  routePreset?: string;
  route?: Partial<UpstreamRoute>;
}

export interface FullMoaConfig {
  enabled: boolean;
  proposers: FullMoaProposerConfig[];
  synthesis: FullMoaSynthesisConfig;
}

export interface GsdMoaConfig {
  defaultEffort: DefaultReasoningEffort;
  benchmarkIntegrity: boolean;
  routePresets: Record<string, RoutePresetConfig>;
  primary: UpstreamRoute;
  reference: UpstreamRoute;
  fullMoa: FullMoaConfig;
  aliases: Record<string, AliasConfig>;
  auto: AutoPolicyConfig;
  cache: CacheConfig;
  trace: TraceConfig;
  prompts: PromptConfig;
  checkpoint: CheckpointPolicyConfig;
  timeAware: TimeAwareConfig;
  asyncAdvisor: AsyncAdvisorConfig;
  referenceTimeoutMs: number;
  referenceMaxTokens?: number;
}

export interface ToolObservationSummary {
  toolResultCount: number;
  totalToolResultCount: number;
  failedToolResultCount: number;
  latestFailureSignals: string[];
  failureSignals: string[];
  successSignals: string[];
  filesMentioned: string[];
  likelyStateChange: boolean;
  digest: string;
  text: string;
}

export interface PolicyInput {
  alias: string;
  latestUserText: string;
  hasToolResults?: boolean;
  hasFreshMoaMarker?: boolean;
  recentToolSummary?: ToolObservationSummary;
  timeState?: TimeState;
}

export interface PolicyDecision {
  requestedMode: AliasMode;
  mode: MoaMode;
  reason: string;
  strippedText: string;
  markers: string[];
}

export type CheckpointScope = "initial" | "explicit" | "failure" | "drift";

export type MoaAction =
  | { kind: "single"; reason: string }
  | { kind: "run"; mode: Exclude<MoaMode, "single">; scope: CheckpointScope; reason: string; observationSummary?: ToolObservationSummary };

export interface AdvisorResult {
  text: string;
  usage?: Usage;
  cacheHit: boolean;
  key: string;
  durationMs: number;
  effort?: string;
}

export interface InnerCallDetails {
  role: "primary" | "reference" | "proposer" | "synthesizer";
  id?: string;
  label?: string;
  provider: string;
  model: string;
  usage?: Usage;
  cacheHit?: boolean;
  durationMs?: number;
  selectionReason?: string;
  effort?: string;
}

export interface PortfolioDecision {
  id: string;
  label: string;
  selected: boolean;
  reason: string;
}

export interface FullMoaProposal {
  id: string;
  label: string;
  text: string;
  usage?: Usage;
  cacheHit: boolean;
  provider: string;
  model: string;
  key: string;
  durationMs: number;
  selectionReason?: string;
  effort?: string;
}

export interface FullMoaFailure {
  id: string;
  label: string;
  message: string;
}

export interface FullMoaResult {
  proposals: FullMoaProposal[];
  failures: FullMoaFailure[];
  synthesis?: {
    text: string;
    usage?: Usage;
    cacheHit: boolean;
    provider: string;
    model: string;
    key: string;
    durationMs: number;
    effort?: string;
  };
  synthesisError?: string;
  guidance: string;
  usage?: Usage;
  innerCalls: InnerCallDetails[];
  portfolio: PortfolioDecision[];
}

export interface MoaRunDetails {
  mode: MoaMode;
  requestedMode: AliasMode;
  reason: string;
  checkpointScope?: CheckpointScope;
  observationDigest?: string;
  observationToolResultCount?: number;
  observationLatestFailureSignals?: string[];
  observationFailureSignals?: string[];
  observationFilesMentioned?: string[];
  cacheHit?: boolean;
  guidanceInjected?: boolean;
  guidanceSkippedReason?: string;
  synthesisFailedReason?: string;
  timeAware?: {
    remainingMs: number;
    elapsedMs?: number;
    phase?: TimePhase;
    suppressed?: string;
  };
  benchmarkIntegrity?: boolean;
  asyncAdvisor?: {
    status: "fired" | "pending" | "injected" | "failed";
    ageMs?: number;
    error?: string;
  };
  innerCalls: InnerCallDetails[];
  portfolio?: PortfolioDecision[];
}

export type UpstreamModel = Model<Api>;
