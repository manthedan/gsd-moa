import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";

export const PROVIDER_ID = "gsd-moa" as const;

export type MoaMode = "single" | "advisor";
export type AliasMode = MoaMode | "auto";

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

export interface AliasConfig {
  mode: AliasMode;
}

export interface AutoPolicyConfig {
  defaultMode: MoaMode;
  advisorKeywords: string[];
  singleKeywords: string[];
}

export interface CacheConfig {
  enabled: boolean;
  dir: string;
  ttlSeconds: number;
}

export interface PromptConfig {
  advisorVersion: string;
}

export interface GsdMoaConfig {
  primary: UpstreamRoute;
  reference: UpstreamRoute;
  aliases: Record<string, AliasConfig>;
  auto: AutoPolicyConfig;
  cache: CacheConfig;
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
  role: "primary" | "reference";
  provider: string;
  model: string;
  usage?: Usage;
}

export interface MoaRunDetails {
  mode: MoaMode;
  requestedMode: AliasMode;
  reason: string;
  cacheHit?: boolean;
  innerCalls: InnerCallDetails[];
}

export type UpstreamModel = Model<Api>;
