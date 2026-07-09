import type { AssistantMessage, Context } from "./pi-compat.js";
import { detectFailureSignals } from "./context.js";

export interface SessionStateSummary {
  filesModified: boolean;
  modifiedFiles: string[];
  commandsRun: number;
  verifierRan: boolean;
  lastVerifierPassed?: boolean;
  verifierEvidence: string[];
}

const FILE_MOD_TOOL_RE = /^(edit|write|apply[-_]?patch|create[-_]?file|str[-_]?replace)/i;
const BASH_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal)$/i;
const CODE_LIKE_TOOL_RE = /^(eval|python|node)$/i;
const COMMAND_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal|eval|python|node)$/i;
const STATE_CHANGE_COMMAND_RE = /(>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bapply[_-]?patch\b|\bpatch\b|\binstall\b|\bmkdir\b|\btouch\b|\bgit\s+(apply|checkout)\b)/i;
const CODE_STATE_CHANGE_RE = /(?:\bBun\.write\b|\bwriteFile(?:Sync)?\b|\.write_text\b|\bopen\s*\([^)]*[,)]\s*["']?[wa]["']?|\bmkdir\b|\brename\b|\bunlink\b)/i;
const STATE_CHANGE_RESULT_RE = /\b(wrote|created|updated|modified|deleted|patched|generated|saved)\b/i;
const VERIFIER_NAME_RE = /(?:pytest|py_compile|unittest|npm\s+(?:test|run\s+(?:test|check))|cargo\s+(?:test|check)|go\s+test|make\s+(?:test|check)|mvn\s+test|tox|jest|vitest|check(?:er)?\.(?:py|sh)|verify|validate)/i;
const SHELL_VERIFIER_COMMAND_RE = /(?:^|[;&|]\s*)(?:\.?\/?[\w./-]*pytest\b|python3?\s+-m\s+(?:pytest|unittest|py_compile)\b|npm\s+(?:test|run\s+(?:test|check))\b|cargo\s+(?:test|check)\b|go\s+test\b|make\s+(?:test|check)\b|mvn\s+test\b|tox\b|jest\b|vitest\b|(?:python3?\s+)?\.?\/?[\w./-]*check(?:er)?\.(?:py|sh)\b|(?:python3?\s+)?\.?\/?[\w./-]*(?:verify|validate)(?:\.(?:py|sh))?\b)/im;
const CODE_VERIFIER_CALL_RE = new RegExp(String.raw`\b(subprocess\.(run|check_call|check_output)|os\.system|(?:child_process\.)?(exec|execFile|spawn)(Sync)?)\s*\([\s\S]{0,600}\b${VERIFIER_NAME_RE.source}\b`, "i");
const CODE_DIRECT_VERIFIER_RE = /\b(pytest\.main|unittest\.main|py_compile\.compile)\b/i;
const RUN_ARTIFACT_RE = /\b(python3?|node|tsx|ts-node|ruby|bash|sh)\b|\bgo\s+run\b/i;
const FILE_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9_/-]+/g;

interface SeenVerifier {
  evidence: string;
}

export function buildSessionStateSummary(context: Context): SessionStateSummary {
  const modifiedFiles: string[] = [];
  const verifierEvidence: string[] = [];
  const verifierByCallId = new Map<string, SeenVerifier>();
  const mutatingCallIds = new Set<string>();
  let filesModified = false;
  let commandsRun = 0;
  let verifierRan = false;
  let lastVerifierPassed: boolean | undefined;

  const latestUserIndex = context.messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  const currentTurnMessages = context.messages.slice(latestUserIndex + 1);

  for (const message of currentTurnMessages) {
    if (message.role === "assistant") {
      for (const toolCall of assistantToolCalls(message)) {
        const name = toolCall.name;
        const args = toolCall.arguments ?? {};
        const command = commandString(args);
        const invocation = invocationText(name, args, command);
        if (COMMAND_LIKE_TOOL_RE.test(name)) commandsRun += 1;

        if (FILE_MOD_TOOL_RE.test(name) || (command && ((BASH_LIKE_TOOL_RE.test(name) && (STATE_CHANGE_COMMAND_RE.test(command) || CODE_STATE_CHANGE_RE.test(command))) || (CODE_LIKE_TOOL_RE.test(name) && CODE_STATE_CHANGE_RE.test(command))))) {
          filesModified = true;
          if (toolCall.id) mutatingCallIds.add(toolCall.id);
          addFiles(modifiedFiles, filesFromText(invocation));
        }

        const evidence = verifierEvidenceFor(name, command, invocation, modifiedFiles);
        if (evidence) {
          verifierRan = true;
          addCapped(verifierEvidence, evidence, 10);
          if (toolCall.id) verifierByCallId.set(toolCall.id, { evidence });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const raw = message.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
    if (!message.isError && mutatingCallIds.has(message.toolCallId) && STATE_CHANGE_RESULT_RE.test(raw)) {
      filesModified = true;
      addFiles(modifiedFiles, filesFromText(raw));
    }

    const seen = verifierByCallId.get(message.toolCallId);
    if (seen) {
      verifierRan = true;
      lastVerifierPassed = !message.isError && detectFailureSignals(raw, Boolean(message.isError)).length === 0;
    }
  }

  return {
    filesModified,
    modifiedFiles,
    commandsRun,
    verifierRan,
    ...(verifierRan && lastVerifierPassed !== undefined ? { lastVerifierPassed } : {}),
    verifierEvidence,
  };
}

function assistantToolCalls(message: AssistantMessage): Array<{ type: string; id?: string; name: string; arguments?: Record<string, unknown> }> {
  const calls: Array<{ type: string; id?: string; name: string; arguments?: Record<string, unknown> }> = [];
  for (const item of message.content) {
    const typed = item as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if ((typed.type === "toolCall" || typed.type === "tool-call") && typeof typed.name === "string") {
      calls.push({
        type: typed.type,
        ...(typeof typed.id === "string" ? { id: typed.id } : {}),
        name: typed.name,
        ...(isRecord(typed.arguments) ? { arguments: typed.arguments } : {}),
      });
    }
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandString(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd", "script", "code", "input"] as const) {
    if (typeof args[key] === "string") return args[key];
  }
  return undefined;
}

function invocationText(name: string, args: Record<string, unknown>, command: string | undefined): string {
  if (command) return `${name} ${command}`;
  try {
    return `${name} ${JSON.stringify(args)}`;
  } catch {
    return name;
  }
}

function verifierEvidenceFor(name: string, command: string | undefined, invocation: string, modifiedFiles: string[]): string | undefined {
  if (!COMMAND_LIKE_TOOL_RE.test(name)) return undefined;
  const verifierText = verifierSearchText(name, command, invocation);
  if (isVerifierInvocation(name, command, verifierText)) return trimEvidence(command ?? invocation);
  if (command && BASH_LIKE_TOOL_RE.test(name) && RUN_ARTIFACT_RE.test(verifierText) && commandReferencesModifiedFile(verifierText, modifiedFiles)) {
    return trimEvidence(command);
  }
  return undefined;
}

function verifierSearchText(name: string, command: string | undefined, invocation: string): string {
  if (!command) return invocation;
  if (BASH_LIKE_TOOL_RE.test(name)) return verifierSearchTextForShell(command);
  if (CODE_LIKE_TOOL_RE.test(name)) return verifierSearchTextForCode(command);
  return invocation;
}

function isVerifierInvocation(name: string, command: string | undefined, verifierText: string): boolean {
  if (command && BASH_LIKE_TOOL_RE.test(name)) return SHELL_VERIFIER_COMMAND_RE.test(verifierText) || CODE_VERIFIER_CALL_RE.test(verifierText) || CODE_DIRECT_VERIFIER_RE.test(verifierText);
  if (command && CODE_LIKE_TOOL_RE.test(name)) return verifierText.length > 0;
  return SHELL_VERIFIER_COMMAND_RE.test(verifierText);
}

function verifierSearchTextForShell(command: string): string {
  const shellText = stripRedirectionTargets(stripHereDocBodies(command))
    .split("\n")
    .filter((line) => !isPureShellWriteLine(line))
    .join("\n");
  const inlineVerifierCode = interpreterHereDocVerifierCode(command);
  return inlineVerifierCode ? `${shellText}\n${inlineVerifierCode}` : shellText;
}

function interpreterHereDocVerifierCode(command: string): string {
  const bodies = interpreterHereDocBodies(command);
  return bodies.filter((body) => CODE_VERIFIER_CALL_RE.test(body) || CODE_DIRECT_VERIFIER_RE.test(body)).join("\n");
}

function interpreterHereDocBodies(command: string): string[] {
  const lines = command.split("\n");
  const bodies: string[] = [];
  let delimiter: string | undefined;
  let activeInterpreter = false;
  let activeBody: string[] = [];

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) {
        if (activeInterpreter) bodies.push(activeBody.join("\n"));
        delimiter = undefined;
        activeInterpreter = false;
        activeBody = [];
      } else if (activeInterpreter) {
        activeBody.push(line);
      }
      continue;
    }

    const match = /<<-?\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(line);
    if (!match) continue;
    delimiter = match[1];
    activeInterpreter = /(?:^|[;&|]\s*)(?:python3?|node|tsx|ts-node|bun)\b/i.test(line);
    activeBody = [];
  }

  return bodies;
}

function stripHereDocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | undefined;

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }

    kept.push(line);
    const match = /<<-?\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(line);
    if (match) delimiter = match[1];
  }

  return kept.join("\n");
}

function stripRedirectionTargets(command: string): string {
  return command.replace(/\s(?:[<>]{1,2}|\d?[<>]{1,2})\s*(?:"[^"]*"|'[^']*'|\S+)/g, " ");
}

function isPureShellWriteLine(line: string): boolean {
  const trimmed = line.trim();
  if (/[;&]|\|\|/.test(trimmed)) return false;
  return /^(cat|echo|printf)\b/i.test(trimmed) || /^tee\b/i.test(trimmed);
}

function verifierSearchTextForCode(command: string): string {
  if (CODE_VERIFIER_CALL_RE.test(command) || CODE_DIRECT_VERIFIER_RE.test(command)) return command;
  return "";
}

function commandReferencesModifiedFile(command: string, modifiedFiles: string[]): boolean {
  return modifiedFiles.some((file) => new RegExp(`(^|[\\s"'\`])${escapeRegExp(file)}($|[\\s"'\`])`).test(command));
}

function filesFromText(text: string): string[] {
  return Array.from(text.matchAll(FILE_RE)).map((match) => match[0]);
}

function addFiles(target: string[], files: string[]): void {
  for (const file of files) addCapped(target, file, 20);
}

function addCapped(target: string[], value: string, cap: number): void {
  if (!value || target.includes(value) || target.length >= cap) return;
  target.push(value);
}

function trimEvidence(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
