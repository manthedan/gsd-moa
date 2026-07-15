/**
 * Paired per-item analysis of langbench results.
 *
 * For each (inputLang, policy) condition: accuracy, adherence (cjkFrac),
 * switches, tokens. Then paired comparison of every policy against a baseline
 * policy on the SAME items: mean per-item accuracy difference with a paired
 * bootstrap 95% CI over items, plus win/loss/tie sign counts.
 *
 * Usage: node --import tsx langbench/analyze.ts --results langbench/results-glm.jsonl [--baseline off] [--lang en]
 */

import { readFileSync } from "node:fs";
import { mulberry32 } from "./generate.ts";

interface Row {
  key: string;
  itemId: string;
  family: string;
  inputLang: "en" | "zh";
  policy: string;
  rollout: number;
  correct: boolean;
  cjkFrac: number;
  switches: number;
  completionTokens: number | null;
  latencyMs: number;
  error?: string;
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits);
}

/** Paired bootstrap CI over items for the mean difference between two per-item maps. */
function pairedBootstrapCi(
  itemIds: string[],
  a: Map<string, number>,
  b: Map<string, number>,
  resamples = 10_000,
  seed = 1234,
): { lo: number; hi: number } {
  const diffs = itemIds.map((id) => (a.get(id) ?? 0) - (b.get(id) ?? 0));
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rng() * diffs.length)]!;
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  return { lo: means[Math.floor(resamples * 0.025)]!, hi: means[Math.floor(resamples * 0.975)]! };
}

function main(): void {
  const resultsPath = arg("--results")!;
  const baseline = arg("--baseline", "off")!;
  const langFilter = arg("--lang");

  const byKey = new Map<string, Row>(); // retried rows override earlier errored ones
  for (const line of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as Row;
    byKey.set(row.key, row);
  }
  const allRows = [...byKey.values()].filter((row) => !langFilter || row.inputLang === langFilter);
  // API-error rows (no model output) carry no accuracy signal — report and drop.
  const rows: Row[] = allRows.filter((row) => !(row.error && !(row as Row & { text?: string }).text));
  const droppedApiErrors = allRows.length - rows.length;

  const conditions = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.inputLang}|${row.policy}`;
    if (!conditions.has(key)) conditions.set(key, []);
    conditions.get(key)!.push(row);
  }

  console.log(`# Langbench analysis — ${resultsPath}`);
  console.log(`rows=${rows.length} (dropped ${droppedApiErrors} api-error rows)${langFilter ? `, lang=${langFilter}` : ""}\n`);
  console.log(`| lang | policy | n | accuracy | cjkFrac | switches | mean out-tokens | mean latency s |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const [key, group] of [...conditions.entries()].sort()) {
    const [lang, policy] = key.split("|");
    console.log(
      `| ${lang} | ${policy} | ${group.length} | ${fmt(mean(group.map((r) => (r.correct ? 1 : 0))))} | ` +
      `${fmt(mean(group.map((r) => r.cjkFrac)))} | ${fmt(mean(group.map((r) => r.switches)), 1)} | ` +
      `${Math.round(mean(group.map((r) => r.completionTokens ?? 0)))} | ${fmt(mean(group.map((r) => r.latencyMs)) / 1000, 1)} |`,
    );
  }

  // Paired comparisons per input language: per-item accuracy (mean over rollouts).
  for (const lang of [...new Set(rows.map((row) => row.inputLang))].sort()) {
    const langRows = rows.filter((row) => row.inputLang === lang);
    const policies = [...new Set(langRows.map((row) => row.policy))].sort();
    if (!policies.includes(baseline)) continue;

    const perItem = new Map<string, Map<string, number>>(); // policy -> itemId -> acc
    for (const policy of policies) {
      const itemAcc = new Map<string, number[]>();
      for (const row of langRows.filter((r) => r.policy === policy)) {
        if (!itemAcc.has(row.itemId)) itemAcc.set(row.itemId, []);
        itemAcc.get(row.itemId)!.push(row.correct ? 1 : 0);
      }
      perItem.set(policy, new Map([...itemAcc.entries()].map(([id, accs]) => [id, mean(accs)])));
    }

    const baseMap = perItem.get(baseline)!;
    console.log(`\n## Paired vs baseline "${baseline}" — input lang ${lang}\n`);
    console.log(`| policy | items | Δ accuracy | 95% CI | item wins | losses | ties |`);
    console.log(`|---|---|---|---|---|---|---|`);
    for (const policy of policies) {
      if (policy === baseline) continue;
      const map = perItem.get(policy)!;
      const shared = [...map.keys()].filter((id) => baseMap.has(id)).sort();
      if (shared.length === 0) continue;
      const diffs = shared.map((id) => map.get(id)! - baseMap.get(id)!);
      const ci = pairedBootstrapCi(shared, map, baseMap);
      const wins = diffs.filter((d) => d > 1e-9).length;
      const losses = diffs.filter((d) => d < -1e-9).length;
      console.log(
        `| ${policy} | ${shared.length} | ${diffs.length ? (mean(diffs) >= 0 ? "+" : "") + fmt(mean(diffs)) : "—"} | ` +
        `[${fmt(ci.lo)}, ${fmt(ci.hi)}] | ${wins} | ${losses} | ${shared.length - wins - losses} |`,
      );
    }

    // Per-family breakdown for the strongest-looking contrast is often wanted;
    // print family accuracy per policy compactly.
    console.log(`\n### Per-family accuracy — input lang ${lang}\n`);
    const families = [...new Set(langRows.map((row) => row.family))].sort();
    console.log(`| policy | ${families.join(" | ")} |`);
    console.log(`|---|${families.map(() => "---").join("|")}|`);
    for (const policy of policies) {
      const cells = families.map((family) => {
        const group = langRows.filter((row) => row.policy === policy && row.family === family);
        return group.length ? fmt(mean(group.map((r) => (r.correct ? 1 : 0))), 2) : "—";
      });
      console.log(`| ${policy} | ${cells.join(" | ")} |`);
    }
  }
}

main();
