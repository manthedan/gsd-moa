import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { DEFAULT_CONFIG } from "./config.js";
import { ALIAS_PRESETS, buildProviderModelConfigs, type BuiltinAliasId } from "./registry.js";

export const GSD_MOA_MODEL_IDS = ALIAS_PRESETS.map((entry) => entry.id) as BuiltinAliasId[];

export type GsdMoaModelId = (typeof GSD_MOA_MODEL_IDS)[number];

export const GSD_MOA_MODELS: ProviderModelConfig[] = buildProviderModelConfigs(DEFAULT_CONFIG);
