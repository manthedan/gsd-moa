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
const COMMAND_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal|eval|python|node)$/i;
const STATE_CHANGE_COMMAND_RE = /(>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bpatch\b|\binstall\b|\bmkdir\b|\btouch\b|\bgit\s+(apply|checkout)\b)/i;
const STATE_CHANGE_RESULT_RE = /\b(wrote|created|updated|modified|deleted|patched|generated|saved)\b/i;
const VERIFIER_RE = /\b(pytest|py_compile|unittest|python3?\s+-m\s+(pytest|unittest|py_compile)|npm\s+(test|run\s+(test|check))|cargo\s+(test|check)|go\s+test|make\s+(test|check)|mvn\s+test|tox\b|jest\b|vitest\b|check(er)?\.(py|sh)|verify|validate)\b/i;
const RUN_ARTIFACT_RE = /\b(python3?|node|tsx|ts-node|ruby|bash|sh)\b|\bgo\s+run\b/i;
const FILE_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9_/-]+/g;

interface SeenVerifier {
  evidence: string;
}

export function buildSessionStateSummary(context: Context): SessionStateSummary {
  const modifiedFiles: string[] = [];
  const verifierEvidence: string[] = [];
  const verifierByCallId = new Map<string, SeenVerifier>();
  let filesModified = false;
  let commandsRun = 0;
  let verifierRan = false;
  let lastVerifierPassed: boolean | undefined;

  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const toolCall of assistantToolCalls(message)) {
        const name = toolCall.name;
        const args = toolCall.arguments ?? {};
        const command = commandString(args);
        const invocation = invocationText(name, args, command);
        if (COMMAND_LIKE_TOOL_RE.test(name)) commandsRun += 1;

        if (FILE_MOD_TOOL_RE.test(name) || (command && BASH_LIKE_TOOL_RE.test(name) && STATE_CHANGE_COMMAND_RE.test(command))) {
          filesModified = true;
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
    if (!message.isError && STATE_CHANGE_RESULT_RE.test(raw)) {
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
  if (VERIFIER_RE.test(invocation)) return trimEvidence(command ?? invocation);
  if (command && BASH_LIKE_TOOL_RE.test(name) && RUN_ARTIFACT_RE.test(command) && commandReferencesModifiedFile(command, modifiedFiles)) {
    return trimEvidence(command);
  }
  return undefined;
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
