import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";

export const PROVIDER_ID = "gsd-moa" as const;

export type MoaMode = "single" | "advisor" | "full_moa";
export type AliasMode = MoaMode | "auto";
export type ModelRef = string | { provider: string; model: string };
export type InputCapability = "text" | "image" | "video" | "audio";

export interface UpstreamRoute {
  provider: string;
  model: string;
  api?: Api;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  reasoning?: boolean;
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
  routePresets: Record<string, RoutePresetConfig>;
  primary: UpstreamRoute;
  reference: UpstreamRoute;
  fullMoa: FullMoaConfig;
  aliases: Record<string, AliasConfig>;
  auto: AutoPolicyConfig;
  cache: CacheConfig;
  trace: TraceConfig;
  prompts: PromptConfig;
}

export interface PolicyInput {
  alias: string;
  latestUserText: string;
  hasToolResults?: boolean;
}

export interface PolicyDecision {
  requestedMode: AliasMode;
  mode: MoaMode;
  reason: string;
  strippedText: string;
  markers: string[];
}

export interface AdvisorResult {
  text: string;
  usage?: Usage;
  cacheHit: boolean;
  key: string;
}

export interface InnerCallDetails {
  role: "primary" | "reference" | "proposer" | "synthesizer";
  id?: string;
  label?: string;
  provider: string;
  model: string;
  usage?: Usage;
  cacheHit?: boolean;
  selectionReason?: string;
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
  selectionReason?: string;
}

export interface FullMoaResult {
  proposals: FullMoaProposal[];
  synthesis?: {
    text: string;
    usage?: Usage;
    cacheHit: boolean;
    provider: string;
    model: string;
    key: string;
  };
  guidance: string;
  usage?: Usage;
  innerCalls: InnerCallDetails[];
  portfolio: PortfolioDecision[];
}

export interface MoaRunDetails {
  mode: MoaMode;
  requestedMode: AliasMode;
  reason: string;
  cacheHit?: boolean;
  innerCalls: InnerCallDetails[];
  portfolio?: PortfolioDecision[];
}

export type UpstreamModel = Model<Api>;
