import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const GSD_MOA_MODEL_IDS = [
  "gpt55-glm52-single",
  "gpt55-glm52-advisor",
  "gpt55-glm52-auto",
] as const;

export type GsdMoaModelId = (typeof GSD_MOA_MODEL_IDS)[number];

export const GSD_MOA_MODELS: ProviderModelConfig[] = [
  {
    id: "gpt55-glm52-single",
    name: "GSD MoA: GPT-5.5 + GLM-5.2 (Single)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt55-glm52-advisor",
    name: "GSD MoA: GPT-5.5 + GLM-5.2 (Advisor)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt55-glm52-auto",
    name: "GSD MoA: GPT-5.5 + GLM-5.2 (Auto)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  },
];
