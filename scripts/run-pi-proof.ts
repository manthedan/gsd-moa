#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";

interface CliArgs {
  prompt?: string;
  promptFile?: string;
  models: string[];
  outDir: string;
  skipPreflight: boolean;
  noTools: boolean;
  thinking?: string;
}

const DEFAULT_MODELS = ["gsd-moa/gpt55-glm52-single", "gsd-moa/gpt55-glm52-full"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.promptFile ? readFileSync(args.promptFile, "utf8") : args.prompt;
  if (!prompt?.trim()) throw new Error("provide --prompt <text> or --prompt-file <path>");

  if (!args.skipPreflight) await preflight(args.models);

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(join(args.outDir, "prompt.md"), prompt);
  writeFileSync(join(args.outDir, "manifest.json"), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    models: args.models,
    command: process.argv,
    thinking: args.thinking,
  }, null, 2)}\n`);

  const summaries = [];
  for (const model of args.models) {
    const label = safeLabel(model);
    const modelDir = join(args.outDir, label);
    mkdirSync(modelDir, { recursive: true });
    const command = ["pi", "-a", "-e", "./src/index.ts", "--model", model, "--mode", "json", "--no-session", ...(args.thinking ? ["--thinking", args.thinking] : []), ...(args.noTools ? ["--no-tools"] : []), "-p", prompt];
    const env = { GSD_MOA_TRACE: "1", GSD_MOA_TRACE_DIR: join(modelDir, "traces") };
    writeFileSync(join(modelDir, "command.txt"), `${command.map(shellQuote).join(" ")}\n`);
    const result = await run(command, env);
    writeFileSync(join(modelDir, "events.jsonl"), result.stdout);
    writeFileSync(join(modelDir, "stderr.txt"), result.stderr);
    writeFileSync(join(modelDir, "exit-code.txt"), `${result.code}\n`);
    const summary = summarizeEvents(model, result.stdout, result.code);
    summaries.push(summary);
    writeFileSync(join(modelDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }

  writeFileSync(join(args.outDir, "SUMMARY.md"), renderSummary(summaries));
  console.log(args.outDir);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    models: DEFAULT_MODELS,
    outDir: join(".proof", "runs", new Date().toISOString().replace(/[:.]/g, "-")),
    skipPreflight: false,
    noTools: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt") args.prompt = argv[++i];
    else if (arg === "--prompt-file") args.promptFile = argv[++i];
    else if (arg === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (arg === "--out") args.outDir = argv[++i];
    else if (arg === "--thinking") args.thinking = argv[++i];
    else if (arg === "--skip-preflight") args.skipPreflight = true;
    else if (arg === "--no-tools") args.noTools = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run proof:pi -- --prompt 'task' [--models gsd-moa/gpt55-glm52-single,gsd-moa/gpt55-glm52-full] [--thinking high] [--out .proof/runs/name] [--skip-preflight] [--no-tools]");
      process.exit(0);
    } else throw new Error(`unknown arg: ${arg}`);
  }
  args.outDir = resolve(args.outDir);
  return args;
}

async function preflight(models: string[]): Promise<void> {
  const needsFactory = models.some((model) => model.includes("gpt55-glm52") && !model.includes("cliproxycodex"));
  const needsCliproxy = models.some((model) => model.includes("gemini35flash") || model.includes("cliproxycodex"));
  const needsZai = models.some((model) => /advisor|full|auto/.test(model));
  if (needsFactory && !process.env.FACTORY_GPT_API_KEY) {
    throw new Error("FACTORY_GPT_API_KEY is required for the default Factory GPT-5.5 primary route. Export it or pass --skip-preflight if your config does not use it.");
  }
  if (needsZai && !process.env.ZAI_API_KEY) {
    throw new Error("ZAI_API_KEY is required for advisor/full/default-auto GLM-5.2 routes. Export it or pass --skip-preflight if your config does not use it.");
  }
  if (needsFactory) await checkTcp("127.0.0.1", 8317, "Factory GPT proxy http://127.0.0.1:8317/v1");
  if (needsCliproxy) await checkTcp("127.0.0.1", 8318, "CLIProxyAPI http://127.0.0.1:8318/v1");
}

function checkTcp(host: string, port: number, label: string): Promise<void> {
  return new Promise((resolveCheck, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${label} is not reachable. Start Factory Droid's local proxy or pass --skip-preflight if your config uses another route.`));
    }, 1500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolveCheck();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`${label} is not reachable. Start Factory Droid's local proxy or pass --skip-preflight if your config uses another route.`));
    });
  });
}

function run(command: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(command[0], command.slice(1), { cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ stdout, stderr, code }));
  });
}

function summarizeEvents(model: string, jsonl: string, exitCode: number | null) {
  const lines = jsonl.split(/\r?\n/).filter(Boolean);
  const events = lines.flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const messageEnds = events.filter((event) => event.type === "message_end");
  const turnEnds = events.filter((event) => event.type === "turn_end");
  const finalMessage = turnEnds.at(-1)?.message ?? messageEnds.at(-1)?.message;
  const diagnostics = finalMessage?.diagnostics ?? [];
  const moaDetails = diagnostics.find((d: any) => d.type === "gsd-moa.details")?.details;
  return {
    model,
    exitCode,
    eventCount: events.length,
    finalStopReason: finalMessage?.stopReason,
    finalTextChars: textFromMessage(finalMessage).length,
    thinkingChars: thinkingFromMessage(finalMessage).length,
    usage: finalMessage?.usage,
    moaDetails,
    tracePath: moaDetails?.tracePath,
  };
}

function textFromMessage(message: any): string {
  return (message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

function thinkingFromMessage(message: any): string {
  return (message?.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("\n");
}

function renderSummary(summaries: any[]): string {
  return [
    "# Pi Proof Run",
    "",
    "| Model | Exit | Stop | Text chars | Thinking chars | Trace |",
    "| --- | ---: | --- | ---: | ---: | --- |",
    ...summaries.map((s) => `| ${s.model} | ${s.exitCode ?? "null"} | ${s.finalStopReason ?? ""} | ${s.finalTextChars} | ${s.thinkingChars} | ${s.tracePath ? basename(s.tracePath) : ""} |`),
    "",
    "See each model directory for `events.jsonl`, `stderr.txt`, `summary.json`, and provider traces under `traces/` linked by `tracePath`.",
  ].join("\n");
}

function safeLabel(model: string): string {
  return model.replace(/[^a-z0-9._-]+/gi, "_");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
