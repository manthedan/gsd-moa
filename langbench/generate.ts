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
 * Usage: node --import tsx langbench/generate.ts --count 40 --seed 20260714 --out langbench/items.jsonl [--hard]
 */

import { writeFileSync } from "node:fs";

export interface LangbenchItem {
  id: string;
  family: "chain-arith" | "seq-track" | "mod-arith" | "repair";
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

function genChainArith(seed: number, hard: boolean): LangbenchItem {
  const rng = mulberry32(seed);
  const steps = hard ? int(rng, 14, 18) : int(rng, 9, 12);
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

function genSeqTrack(seed: number, hard: boolean): LangbenchItem {
  const rng = mulberry32(seed);
  const tokens = ["P1", "K2", "M3", "T4", "R5", "B6", "D7", "G8", "L9", "S0"];
  const size = hard ? 9 : 7;
  let list = tokens.slice(0, size);
  const opCount = hard ? int(rng, 12, 15) : int(rng, 8, 11);
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

function genModArith(seed: number, hard: boolean): LangbenchItem {
  const rng = mulberry32(seed);
  const m = pick(rng, hard ? [53, 59, 61, 67, 71, 73, 79, 83, 89, 97] : [11, 13, 17, 19, 23, 29, 31, 37, 41, 43]);
  const a = int(rng, 3, 20);
  const b = int(rng, hard ? 25 : 12, hard ? 60 : 30);
  const c = int(rng, 11, 99);
  const d = int(rng, 11, 99);
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

// ------------------------------------------------------------------------ CLI

export function generateItems(countPerFamily: number, baseSeed: number, hard: boolean): LangbenchItem[] {
  const items: LangbenchItem[] = [];
  for (let i = 0; i < countPerFamily; i++) {
    items.push(genChainArith(baseSeed + i * 4 + 0, hard));
    items.push(genSeqTrack(baseSeed + i * 4 + 1, hard));
    items.push(genModArith(baseSeed + i * 4 + 2, hard));
    items.push(genRepair(baseSeed + i * 4 + 3));
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
  const hard = args.includes("--hard");
  const items = generateItems(count, seed, hard);
  writeFileSync(out, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const byFamily = new Map<string, number>();
  for (const item of items) byFamily.set(item.family, (byFamily.get(item.family) ?? 0) + 1);
  console.log(`wrote ${items.length} items to ${out} (${[...byFamily.entries()].map(([f, n]) => `${f}: ${n}`).join(", ")}, hard=${hard})`);
}

if (process.argv[1]?.endsWith("generate.ts")) main();
