/**
 * Script-level language statistics for bilingual (EN/ZH) reasoning analysis.
 *
 * Deterministic, dependency-free. Operates on plain text; strip code segments
 * first so identifiers/keywords don't count as English reasoning.
 */

export type Script = "cjk" | "latin";

export interface LangRun {
  script: Script;
  /** Index of the first letter of the run in the analyzed (code-stripped) text. */
  start: number;
  /** Count of letters (script-classified chars only) in the run. */
  letters: number;
}

export interface LangStats {
  cjkLetters: number;
  latinLetters: number;
  /** cjkLetters / (cjkLetters + latinLetters); 0 when no letters. */
  cjkFrac: number;
  /** Script runs after minimum-run smoothing. */
  runs: LangRun[];
  /** Number of script transitions between consecutive smoothed runs. */
  switches: number;
}

/**
 * Minimum letters for a run to count as a genuine language segment rather than
 * noise. Latin needs a higher floor: stray identifiers, unit symbols, and API
 * names survive code-stripping inside Chinese prose. Two CJK chars are already
 * a content word.
 */
export const MIN_RUN_LETTERS: Record<Script, number> = { cjk: 2, latin: 4 };

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // Extension A
  [0xf900, 0xfaff], // Compatibility Ideographs
  [0x20000, 0x2a6df], // Extension B
];

export function classifyChar(codePoint: number): Script | undefined {
  if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) return "latin";
  for (const [lo, hi] of CJK_RANGES) if (codePoint >= lo && codePoint <= hi) return "cjk";
  return undefined;
}

/**
 * Remove fenced code blocks, inline backtick spans, and common tool-output
 * shapes so that only natural-language prose is analyzed.
 */
export function stripCodeSegments(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s{4,}\S.*$/gm, " "); // indented code lines
}

export function computeLangStats(text: string, minRun: Record<Script, number> = MIN_RUN_LETTERS): LangStats {
  const stripped = stripCodeSegments(text);
  // Raw runs: consecutive letters of one script; neutral chars (digits,
  // punctuation, whitespace, other scripts) do not break a run.
  const rawRuns: LangRun[] = [];
  let index = 0;
  for (const ch of stripped) {
    const script = classifyChar(ch.codePointAt(0)!);
    if (script) {
      const last = rawRuns[rawRuns.length - 1];
      if (last && last.script === script) last.letters += 1;
      else rawRuns.push({ script, start: index, letters: 1 });
    }
    index += ch.length;
  }

  let cjkLetters = 0;
  let latinLetters = 0;
  for (const run of rawRuns) {
    if (run.script === "cjk") cjkLetters += run.letters;
    else latinLetters += run.letters;
  }

  // Smoothing: drop sub-threshold runs, then merge adjacent same-script runs.
  const kept = rawRuns.filter((run) => run.letters >= minRun[run.script]);
  const runs: LangRun[] = [];
  for (const run of kept) {
    const last = runs[runs.length - 1];
    if (last && last.script === run.script) last.letters += run.letters;
    else runs.push({ ...run });
  }

  const letters = cjkLetters + latinLetters;
  return {
    cjkLetters,
    latinLetters,
    cjkFrac: letters === 0 ? 0 : cjkLetters / letters,
    runs,
    switches: Math.max(0, runs.length - 1),
  };
}
