import type { AliasMode, GsdMoaConfig, MoaMode, PolicyDecision, PolicyInput } from "./types.js";

const ADVISOR_MARKERS = ["<!-- gsd-moa:advisor -->", "<!-- gsd-moa:on -->"];
const FULL_MOA_MARKERS = ["<!-- gsd-moa:full -->", "<!-- gsd-moa:full_moa -->"];
const SINGLE_MARKERS = ["<!-- gsd-moa:single -->", "<!-- gsd-moa:off -->"];
const ALL_MARKERS = [...ADVISOR_MARKERS, ...FULL_MOA_MARKERS, ...SINGLE_MARKERS];

export function stripMoaMarkers(text: string): { text: string; markers: string[] } {
  const markers: string[] = [];
  let stripped = text;
  for (const marker of ALL_MARKERS) {
    if (stripped.includes(marker)) markers.push(marker);
    stripped = stripped.split(marker).join("");
  }
  return { text: stripped.trim(), markers };
}

export function chooseMode(config: GsdMoaConfig, input: PolicyInput): PolicyDecision {
  const alias = config.aliases[input.alias];
  if (!alias) {
    throw new Error(`Unknown ${input.alias} model alias for gsd-moa provider`);
  }

  const { text: strippedText, markers } = stripMoaMarkers(input.latestUserText);
  const requestedMode = alias.mode;

  if (markers.some((m) => SINGLE_MARKERS.includes(m))) {
    return decision(requestedMode, "single", "explicit single/off marker", strippedText, markers);
  }
  if (markers.some((m) => ADVISOR_MARKERS.includes(m))) {
    return decision(requestedMode, "advisor", "explicit advisor marker", strippedText, markers);
  }
  if (markers.some((m) => FULL_MOA_MARKERS.includes(m))) {
    return decision(requestedMode, "full_moa", "explicit full MoA marker", strippedText, markers);
  }

  if (requestedMode === "single") return decision(requestedMode, "single", "single alias", strippedText, markers);
  if (requestedMode === "advisor") return decision(requestedMode, "advisor", "advisor alias", strippedText, markers);
  if (requestedMode === "full_moa") return decision(requestedMode, "full_moa", "full MoA alias", strippedText, markers);

  // Tool-loop continuations favor single to avoid extra latency while final model is handling tool results.
  if (input.hasToolResults) return decision(requestedMode, "single", "tool-loop continuation", strippedText, markers);

  const normalized = strippedText.toLowerCase();
  const singleHit = config.auto.singleKeywords.find((kw) => normalized.includes(kw.toLowerCase()));
  if (singleHit) return decision(requestedMode, "single", `single keyword: ${singleHit}`, strippedText, markers);

  const fullMoaHit = config.auto.fullMoaKeywords.find((kw) => normalized.includes(kw.toLowerCase()));
  if (fullMoaHit) return decision(requestedMode, "full_moa", `full MoA keyword: ${fullMoaHit}`, strippedText, markers);

  const advisorHit = config.auto.advisorKeywords.find((kw) => normalized.includes(kw.toLowerCase()));
  if (advisorHit) return decision(requestedMode, "advisor", `advisor keyword: ${advisorHit}`, strippedText, markers);

  return decision(requestedMode, config.auto.defaultMode, "auto default", strippedText, markers);
}

function decision(
  requestedMode: AliasMode,
  mode: MoaMode,
  reason: string,
  strippedText: string,
  markers: string[],
): PolicyDecision {
  return { requestedMode, mode, reason, strippedText, markers };
}
