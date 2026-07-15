/**
 * Language-switch analysis over gsd-moa trace files.
 *
 * Walks a directory of trace JSONs (one per provider turn; requires
 * GSD_MOA_TRACE=1 and GSD_MOA_TRACE_INCLUDE_OUTPUTS=1 on the arm), extracts
 * assistant thinking + visible text from each turn's finalMessage, and reports
 * per-turn and per-directory CJK/Latin statistics: fraction of Chinese
 * reasoning, number of script switches, and where in the trajectory the
 * switches concentrate.
 *
 * Usage:
 *   node --import tsx scripts/analyze-language-switches.ts --dir <trace-dir> [--json]
 *   (--dir may be repeated; each directory is reported separately)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeLangStats } from "../langbench/lang-stats.ts";

interface TraceDoc {
  runId?: string;
  startedAt?: string;
  status?: string;
  langPolicy?: string;
  model?: { id?: string };
  finalMessage?: { content?: Array<{ type?: string; text?: string; thinking?: string }> };
}

interface TurnStats {
  file: string;
  startedAt: string;
  thinkingCjkFrac: number | null;
  textCjkFrac: number | null;
  switches: number;
  letters: number;
}

function extractParts(doc: TraceDoc): { thinking: string; text: string } {
  const content = doc.finalMessage?.content ?? [];
  const thinking = content.filter((c) => c.type === "thinking").map((c) => c.thinking ?? c.text ?? "").join("\n");
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return { thinking, text };
}

function analyzeDir(dir: string): { turns: TurnStats[]; langPolicy?: string; model?: string } {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());

  const turns: TurnStats[] = [];
  let langPolicy: string | undefined;
  let model: string | undefined;
  for (const file of files) {
    let doc: TraceDoc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as TraceDoc;
    } catch {
      continue; // in-progress or truncated trace
    }
    langPolicy ??= doc.langPolicy;
    model ??= doc.model?.id;
    const { thinking, text } = extractParts(doc);
    if (!thinking && !text) continue;
    const combined = computeLangStats([thinking, text].join("\n"));
    const thinkingStats = thinking ? computeLangStats(thinking) : null;
    const textStats = text ? computeLangStats(text) : null;
    turns.push({
      file,
      startedAt: doc.startedAt ?? "",
      thinkingCjkFrac: thinkingStats && thinkingStats.cjkLetters + thinkingStats.latinLetters > 0 ? thinkingStats.cjkFrac : null,
      textCjkFrac: textStats && textStats.cjkLetters + textStats.latinLetters > 0 ? textStats.cjkFrac : null,
      switches: combined.switches,
      letters: combined.cjkLetters + combined.latinLetters,
    });
  }
  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { turns, langPolicy, model };
}

function weightedMean(pairs: Array<[value: number | null, weight: number]>): number | null {
  let sum = 0;
  let weightTotal = 0;
  for (const [value, weight] of pairs) {
    if (value === null || weight <= 0) continue;
    sum += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? sum / weightTotal : null;
}

function main(): void {
  const dirs: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--dir" && process.argv[i + 1]) dirs.push(process.argv[++i]!);
  }
  const asJson = process.argv.includes("--json");
  if (dirs.length === 0) {
    console.error("usage: analyze-language-switches --dir <trace-dir> [--dir ...] [--json]");
    process.exit(2);
  }

  const reports = dirs.map((dir) => {
    const { turns, langPolicy, model } = analyzeDir(dir);
    const totalSwitches = turns.reduce((acc, turn) => acc + turn.switches, 0);
    const thirds: Array<{ switches: number; letters: number }> = [
      { switches: 0, letters: 0 },
      { switches: 0, letters: 0 },
      { switches: 0, letters: 0 },
    ];
    turns.forEach((turn, index) => {
      const third = Math.min(2, Math.floor((index / Math.max(1, turns.length)) * 3));
      thirds[third]!.switches += turn.switches;
      thirds[third]!.letters += turn.letters;
    });
    return {
      dir,
      model: model ?? "?",
      langPolicy: langPolicy ?? "off",
      turns: turns.length,
      thinkingCjkFrac: weightedMean(turns.map((t) => [t.thinkingCjkFrac, t.letters])),
      textCjkFrac: weightedMean(turns.map((t) => [t.textCjkFrac, t.letters])),
      totalSwitches,
      switchesPerTurn: turns.length ? totalSwitches / turns.length : 0,
      switchesByTrajectoryThird: thirds.map((t) => t.switches),
      perTurn: turns,
    };
  });

  if (asJson) {
    console.log(JSON.stringify(reports.map(({ perTurn, ...rest }) => ({ ...rest, perTurn })), null, 2));
    return;
  }

  console.log(`| dir | model | policy | turns | thinking cjkFrac | text cjkFrac | switches | per turn | by third |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const report of reports) {
    console.log(
      `| ${report.dir} | ${report.model} | ${report.langPolicy} | ${report.turns} | ` +
      `${report.thinkingCjkFrac === null ? "—" : report.thinkingCjkFrac.toFixed(3)} | ` +
      `${report.textCjkFrac === null ? "—" : report.textCjkFrac.toFixed(3)} | ` +
      `${report.totalSwitches} | ${report.switchesPerTurn.toFixed(1)} | ${report.switchesByTrajectoryThird.join("/")} |`,
    );
  }
}

main();
