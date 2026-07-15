/**
 * Procedural generator for the langbench verifier-backed task families.
 *
 * Every item is generated from a seed, rendered in parallel English and
 * Chinese, and has a programmatically checkable answer. Task content is
 * language-neutral by construction (numbers, token lists, code) so the
 * reasoning-language treatment is not confounded by task grounding.
 *
 * Families:
 *  - chain-arith: long integer operation chains (mental execution).
 *  - seq-track:   list state tracking under a sequence of edit operations.
 *  - mod-arith:   modular exponentiation plus products.
 *  - repair:      fix a seeded bug in a small Python function (exec-verified).
 *
 * Usage: node --import tsx langbench/generate.ts --count 40 --seed 20260714 --out langbench/items.jsonl [--level 1|2|3]
 * (--hard is kept as an alias for --level 2; level 3 is the "extreme" tier)
 */

import { writeFileSync } from "node:fs";

export interface LangbenchItem {
  id: string;
  family: "chain-arith" | "seq-track" | "mod-arith" | "repair" | "knapsack" | "substr-count";
  seed: number;
  prompt: { en: string; zh: string };
  /** Expected value for exact-match families; expected behavior note for repair. */
  answer: string;
  verify: "exact" | "python";
  /** For repair: python source of the test harness appended to the candidate. */
  tests?: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

const ANSWER_LINE_EN = 'End your response with a single line "ANSWER: <value>" and nothing after it.';
const ANSWER_LINE_ZH = '回复的最后一行必须是 "ANSWER: <值>"，其后不要有任何内容。';

// ---------------------------------------------------------------- chain-arith

function genChainArith(seed: number, level: number): LangbenchItem {
  const rng = mulberry32(seed);
  const steps = level >= 3 ? int(rng, 26, 34) : level === 2 ? int(rng, 14, 18) : int(rng, 9, 12);
  let value = int(rng, 12, 99);
  const startValue = value;
  const enOps: string[] = [];
  const zhOps: string[] = [];
  for (let i = 0; i < steps; i++) {
    const op = pick(rng, ["add", "sub", "mul", "div", "mod"] as const);
    if (op === "add") {
      const n = int(rng, 7, 96);
      value += n;
      enOps.push(`add ${n}`);
      zhOps.push(`加 ${n}`);
    } else if (op === "sub") {
      if (value <= 12) {
        // Keep the running value strictly positive so "remainder" stays unambiguous.
        const n = int(rng, 7, 96);
        value += n;
        enOps.push(`add ${n}`);
        zhOps.push(`加 ${n}`);
      } else {
        const n = int(rng, 5, Math.min(97, value - 1));
        value -= n;
        enOps.push(`subtract ${n}`);
        zhOps.push(`减 ${n}`);
      }
    } else if (op === "mul") {
      const n = int(rng, 2, 7);
      value *= n;
      enOps.push(`multiply by ${n}`);
      zhOps.push(`乘以 ${n}`);
    } else if (op === "div") {
      const divisors = [2, 3, 4, 5, 6, 7].filter((d) => value % d === 0 && value / d >= 2);
      if (divisors.length === 0) {
        const n = int(rng, 7, 96);
        value += n;
        enOps.push(`add ${n}`);
        zhOps.push(`加 ${n}`);
      } else {
        const d = pick(rng, divisors);
        value /= d;
        enOps.push(`divide by ${d}`);
        zhOps.push(`除以 ${d}`);
      }
    } else {
      const m = int(rng, 5, 23);
      value %= m;
      if (value === 0) value = m; // keep the chain alive
      enOps.push(`take the remainder after dividing by ${m}${value === m ? ", then if the result is 0 use " + m : ""}`);
      zhOps.push(`除以 ${m} 取余数${value === m ? `，若结果为 0 则改用 ${m}` : ""}`);
    }
  }
  const en = [
    `Start with the number given below and apply the operations strictly in order. Track the running value carefully and do not skip steps.`,
    `Start value: ${startValue}`,
    ...enOps.map((op, i) => `${i + 1}. ${op}`),
    `What is the final value?`,
    ANSWER_LINE_EN,
  ].join("\n");
  const zh = [
    `从下面给出的初始数开始，严格按顺序执行每一步运算。仔细跟踪当前值，不要跳过任何步骤。`,
    `初始值：${startValue}`,
    ...zhOps.map((op, i) => `${i + 1}. ${op}`),
    `最终值是多少？`,
    ANSWER_LINE_ZH,
  ].join("\n");
  return { id: `chain-arith-${seed}`, family: "chain-arith", seed, prompt: { en, zh }, answer: String(value), verify: "exact" };
}

// ------------------------------------------------------------------ seq-track

function genSeqTrack(seed: number, level: number): LangbenchItem {
  const rng = mulberry32(seed);
  const tokens = ["P1", "K2", "M3", "T4", "R5", "B6", "D7", "G8", "L9", "S0"];
  const size = level >= 3 ? 10 : level === 2 ? 9 : 7;
  let list = tokens.slice(0, size);
  const opCount = level >= 3 ? int(rng, 22, 28) : level === 2 ? int(rng, 12, 15) : int(rng, 8, 11);
  const enOps: string[] = [];
  const zhOps: string[] = [];
  for (let i = 0; i < opCount; i++) {
    const op = pick(rng, ["swap", "reverse", "rotate", "delete", "insert"] as const);
    if (op === "swap" && list.length >= 2) {
      const a = int(rng, 1, list.length);
      let b = int(rng, 1, list.length);
      if (b === a) b = (b % list.length) + 1;
      [list[a - 1], list[b - 1]] = [list[b - 1]!, list[a - 1]!];
      enOps.push(`Swap the items at positions ${a} and ${b}.`);
      zhOps.push(`交换第 ${a} 个和第 ${b} 个位置上的元素。`);
    } else if (op === "reverse" && list.length >= 3) {
      const a = int(rng, 1, list.length - 1);
      const b = int(rng, a + 1, list.length);
      list = [...list.slice(0, a - 1), ...list.slice(a - 1, b).reverse(), ...list.slice(b)];
      enOps.push(`Reverse the segment from position ${a} to position ${b} (inclusive).`);
      zhOps.push(`将第 ${a} 个到第 ${b} 个位置（含两端）的片段整体反转。`);
    } else if (op === "rotate") {
      const k = int(rng, 1, Math.max(1, list.length - 1));
      list = [...list.slice(list.length - k), ...list.slice(0, list.length - k)];
      enOps.push(`Rotate the whole list to the right by ${k} position${k === 1 ? "" : "s"}.`);
      zhOps.push(`将整个列表向右循环移动 ${k} 位。`);
    } else if (op === "delete" && list.length > 4) {
      const a = int(rng, 1, list.length);
      list.splice(a - 1, 1);
      enOps.push(`Delete the item at position ${a}.`);
      zhOps.push(`删除第 ${a} 个位置上的元素。`);
    } else {
      const unused = tokens.filter((t) => !list.includes(t));
      if (unused.length === 0) {
        i -= 1;
        continue;
      }
      const t = pick(rng, unused);
      const a = int(rng, 1, list.length + 1);
      list.splice(a - 1, 0, t);
      enOps.push(`Insert the new item ${t} so that it becomes position ${a}.`);
      zhOps.push(`插入新元素 ${t}，使其位于第 ${a} 个位置。`);
    }
  }
  const initial = tokens.slice(0, size).join("-");
  const en = [
    `A list initially contains, in order: ${initial}. Positions are 1-based and always refer to the CURRENT state of the list. Apply the operations strictly in order.`,
    ...enOps.map((op, i) => `${i + 1}. ${op}`),
    `Write the final list from first to last, joined by dashes (for example: A1-B2-C3).`,
    ANSWER_LINE_EN,
  ].join("\n");
  const zh = [
    `一个列表初始依次包含：${initial}。位置从 1 开始计数，并且始终指列表的当前状态。严格按顺序执行以下操作。`,
    ...zhOps.map((op, i) => `${i + 1}. ${op}`),
    `写出最终列表（从头到尾），用短横线连接（例如：A1-B2-C3）。`,
    ANSWER_LINE_ZH,
  ].join("\n");
  return { id: `seq-track-${seed}`, family: "seq-track", seed, prompt: { en, zh }, answer: list.join("-"), verify: "exact" };
}

// ------------------------------------------------------------------ mod-arith

function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function genModArith(seed: number, level: number): LangbenchItem {
  const rng = mulberry32(seed);
  const hard = level >= 2;
  const m = pick(rng, hard ? [53, 59, 61, 67, 71, 73, 79, 83, 89, 97] : [11, 13, 17, 19, 23, 29, 31, 37, 41, 43]);
  const a = int(rng, 3, 20);
  const b = int(rng, hard ? 25 : 12, hard ? 60 : 30);
  const c = int(rng, 11, 99);
  const d = int(rng, 11, 99);
  if (level >= 3) {
    // Two independent power terms: twice the square-and-multiply bookkeeping.
    const e = int(rng, 3, 20);
    const f = int(rng, 40, 90);
    const answer = Number(
      (powMod(BigInt(a), BigInt(b + 30), BigInt(m)) + powMod(BigInt(e), BigInt(f), BigInt(m)) + (BigInt(c * d) % BigInt(m))) % BigInt(m),
    );
    const en = [
      `Compute (${a}^${b + 30} + ${e}^${f} + ${c}×${d}) mod ${m}. Work it out step by step by hand; do not just assert a result.`,
      ANSWER_LINE_EN,
    ].join("\n");
    const zh = [
      `计算 (${a}^${b + 30} + ${e}^${f} + ${c}×${d}) mod ${m}。请一步一步手工推导，不要直接断言结果。`,
      ANSWER_LINE_ZH,
    ].join("\n");
    return { id: `mod-arith-${seed}`, family: "mod-arith", seed, prompt: { en, zh }, answer: String(answer), verify: "exact" };
  }
  const answer = Number((powMod(BigInt(a), BigInt(b), BigInt(m)) + BigInt(c * d) % BigInt(m)) % BigInt(m));
  const en = [
    `Compute (${a}^${b} + ${c}×${d}) mod ${m}. Work it out step by step by hand; do not just assert a result.`,
    ANSWER_LINE_EN,
  ].join("\n");
  const zh = [
    `计算 (${a}^${b} + ${c}×${d}) mod ${m}。请一步一步手工推导，不要直接断言结果。`,
    ANSWER_LINE_ZH,
  ].join("\n");
  return { id: `mod-arith-${seed}`, family: "mod-arith", seed, prompt: { en, zh }, answer: String(answer), verify: "exact" };
}

// --------------------------------------------------------------------- repair

interface RepairTemplate {
  name: string;
  broken: (p: { n: number; k: number }) => string;
  tests: (p: { n: number; k: number }) => string;
}

const REPAIR_TEMPLATES: RepairTemplate[] = [
  {
    name: "running-max-window",
    broken: ({ k }) => `def max_window_sums(xs, k=${k}):
    """Return the maximum sum over all windows of exactly k consecutive items."""
    best = None
    for i in range(len(xs) - k):
        s = sum(xs[i:i + k])
        if best is None or s > best:
            best = s
    return best`,
    tests: ({ k }) => `assert max_window_sums([1, 2, 3, 4, 5], ${k}) == ${[1, 2, 3, 4, 5].slice(5 - k).reduce((x, y) => x + y, 0)}
assert max_window_sums([5, -1, -1, 5, 5], 2) == 10
assert max_window_sums([2, 2], 2) == 4
print("OK")`,
  },
  {
    name: "count-strictly-greater",
    broken: ({ n }) => `def count_greater(xs, threshold=${n}):
    """Count how many values are strictly greater than threshold."""
    count = 0
    for x in xs:
        if x >= threshold:
            count += 1
    return count`,
    tests: ({ n }) => `assert count_greater([${n}, ${n + 1}, ${n - 1}, ${n}]) == 1
assert count_greater([${n + 5}, ${n + 6}]) == 2
assert count_greater([]) == 0
print("OK")`,
  },
  {
    name: "interleave-tail",
    broken: () => `def interleave(a, b):
    """Interleave two lists; when one runs out, append the rest of the other."""
    out = []
    for i in range(min(len(a), len(b))):
        out.append(a[i])
        out.append(b[i])
    out.extend(a[len(b):])
    return out`,
    tests: () => `assert interleave([1, 2, 3], ["a"]) == [1, "a", 2, 3]
assert interleave([1], ["a", "b", "c"]) == [1, "a", "b", "c"]
assert interleave([], [7]) == [7]
print("OK")`,
  },
];

function genRepair(seed: number): LangbenchItem {
  const rng = mulberry32(seed);
  const template = pick(rng, REPAIR_TEMPLATES);
  const p = { n: int(rng, 5, 40), k: int(rng, 2, 4) };
  const broken = template.broken(p);
  const tests = template.tests(p);
  const en = [
    `The Python function below has exactly one bug. Fix it with the smallest possible change and output the ENTIRE corrected function in a single \`\`\`python code block. Do not change the function name or signature.`,
    "```python",
    broken,
    "```",
    `It must pass tests like:`,
    "```python",
    tests.split("\n").slice(0, 2).join("\n"),
    "```",
  ].join("\n");
  const zh = [
    `下面的 Python 函数恰好包含一个 bug。请用尽可能小的改动修复它，并将修复后的完整函数输出在一个 \`\`\`python 代码块中。不要改变函数名或参数。`,
    "```python",
    broken,
    "```",
    `它必须通过类似这样的测试：`,
    "```python",
    tests.split("\n").slice(0, 2).join("\n"),
    "```",
  ].join("\n");
  return { id: `repair-${template.name}-${seed}`, family: "repair", seed, prompt: { en, zh }, answer: `passes: ${template.name}`, verify: "python", tests };
}

// ------------------------------------------------------------------- knapsack

function genKnapsack(seed: number, level: number): LangbenchItem {
  const rng = mulberry32(seed);
  // Calibrated 2026-07-15: GLM-5.2 never finds the optimum at n=14/16 (floor)
  // and open-budget calls run 10+ min. Smaller instances + a budget cap keep
  // the family in the discriminative band.
  const n = level >= 3 ? 13 : level === 2 ? 12 : 10;
  const weights = Array.from({ length: n }, () => int(rng, 17, 89));
  const values = Array.from({ length: n }, () => int(rng, 15, 99));
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.45);
  // Exact optimum via DP over capacity.
  const dp = new Array<number>(capacity + 1).fill(0);
  for (let i = 0; i < n; i++) {
    for (let c = capacity; c >= weights[i]!; c--) {
      dp[c] = Math.max(dp[c]!, dp[c - weights[i]!]! + values[i]!);
    }
  }
  const optimum = dp[capacity]!;
  const rows = weights.map((w, i) => `item ${i + 1}: weight ${w}, value ${values[i]}`);
  const zhRows = weights.map((w, i) => `物品 ${i + 1}：重量 ${w}，价值 ${values[i]}`);
  const en = [
    `A knapsack has capacity ${capacity}. Choose any subset of the items below (each usable at most once) so the total weight is at most ${capacity} and the total value is as large as possible.`,
    ...rows,
    `What is the MAXIMUM achievable total value? You must find the true optimum, not just a good solution — check systematically.`,
    ANSWER_LINE_EN,
  ].join("\n");
  const zh = [
    `一个背包的容量为 ${capacity}。从下面的物品中任选一个子集（每件最多用一次），使总重量不超过 ${capacity}，且总价值尽可能大。`,
    ...zhRows,
    `可以达到的最大总价值是多少？必须找到真正的最优解，而不只是一个较好的解——请系统地检查。`,
    ANSWER_LINE_ZH,
  ].join("\n");
  return { id: `knapsack-${seed}`, family: "knapsack", seed, prompt: { en, zh }, answer: String(optimum), verify: "exact" };
}

// --------------------------------------------------------------- substr-count

function genSubstrCount(seed: number, level: number): LangbenchItem {
  const rng = mulberry32(seed);
  const length = level >= 3 ? 240 : level === 2 ? 180 : 120;
  // Biased digit alphabet so short patterns occur often enough to be countable
  // but frequently enough to punish sloppy scanning.
  const alphabet = "0112233445";
  let digits = "";
  for (let i = 0; i < length; i++) digits += alphabet[int(rng, 0, alphabet.length - 1)];
  // Pick the bigram whose true count is closest to length/15 so every item has
  // a substantive, non-guessable count (ties broken lexicographically).
  const bigramCounts = new Map<string, number>();
  for (let i = 0; i + 2 <= digits.length; i++) {
    const bigram = digits.slice(i, i + 2);
    bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
  }
  const target = Math.round(length / 15);
  const pattern = [...bigramCounts.entries()]
    .sort((a, b) => Math.abs(a[1] - target) - Math.abs(b[1] - target) || (a[0] < b[0] ? -1 : 1))[0]![0];
  const count = bigramCounts.get(pattern)!;
  const grouped = digits.replace(/(.{10})/g, "$1 ").trim();
  const en = [
    `Count how many times the two-digit pattern "${pattern}" occurs in the digit string below. Occurrences may overlap (count every starting position). Spaces are only visual grouping — ignore them.`,
    grouped,
    ANSWER_LINE_EN,
  ].join("\n");
  const zh = [
    `数一数两位数字模式 "${pattern}" 在下面的数字串中出现了多少次。允许重叠（统计每一个起始位置）。空格只是视觉分组——请忽略。`,
    grouped,
    ANSWER_LINE_ZH,
  ].join("\n");
  return { id: `substr-count-${seed}`, family: "substr-count", seed, prompt: { en, zh }, answer: String(count), verify: "exact" };
}

// ------------------------------------------------------------------------ CLI

export function generateItems(countPerFamily: number, baseSeed: number, level: number | boolean): LangbenchItem[] {
  const numericLevel = typeof level === "boolean" ? (level ? 2 : 1) : level;
  const items: LangbenchItem[] = [];
  for (let i = 0; i < countPerFamily; i++) {
    items.push(genChainArith(baseSeed + i * 6 + 0, numericLevel));
    items.push(genSeqTrack(baseSeed + i * 6 + 1, numericLevel));
    items.push(genModArith(baseSeed + i * 6 + 2, numericLevel));
    items.push(genRepair(baseSeed + i * 6 + 3));
    items.push(genKnapsack(baseSeed + i * 6 + 4, numericLevel));
    items.push(genSubstrCount(baseSeed + i * 6 + 5, numericLevel));
  }
  return items;
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const count = Number(get("--count", "40"));
  const seed = Number(get("--seed", "20260714"));
  const out = get("--out", "langbench/items.jsonl")!;
  const level = args.includes("--hard") ? 2 : Number(get("--level", "1"));
  const items = generateItems(count, seed, level);
  writeFileSync(out, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const byFamily = new Map<string, number>();
  for (const item of items) byFamily.set(item.family, (byFamily.get(item.family) ?? 0) + 1);
  console.log(`wrote ${items.length} items to ${out} (${[...byFamily.entries()].map(([f, n]) => `${f}: ${n}`).join(", ")}, level=${level})`);
}

if (process.argv[1]?.endsWith("generate.ts")) main();
