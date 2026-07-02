import { applyAliasPreset } from "./registry.js";
import type { GsdMoaConfig } from "./types.js";

export function applyModelPreset(config: GsdMoaConfig, alias: string): GsdMoaConfig {
  return applyAliasPreset(config, alias);
}
