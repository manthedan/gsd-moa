import type { AssistantMessage, Context, Message, TextContent, UserMessage } from "@earendil-works/pi-ai/compat";
import type { FullMoaResult, PolicyDecision } from "./types.js";

export function latestUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") return messageText(msg);
  }
  return "";
}

export function hasRecentToolResults(context: Context): boolean {
  return context.messages.slice(-4).some((m) => m.role === "toolResult");
}

export function sanitizeReferenceContext(context: Context, decision?: PolicyDecision): Context {
  const messages: Message[] = [];

  for (const msg of context.messages) {
    if (msg.role === "toolResult") continue;
    if (msg.role === "user") {
      const content = messageText(msg);
      const text = decision ? stripKnownMarkers(content) : content;
      if (text.trim()) {
        messages.push({ role: "user", content: text, timestamp: msg.timestamp } satisfies UserMessage);
      }
      continue;
    }
    if (msg.role === "assistant") {
      const text = assistantText(msg);
      if (text.trim()) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text } satisfies TextContent],
          api: msg.api,
          provider: msg.provider,
          model: msg.model,
          usage: msg.usage,
          stopReason: msg.stopReason,
          timestamp: msg.timestamp,
        } satisfies AssistantMessage);
      }
    }
  }

  return { messages };
}

export function stripMarkersFromContext(context: Context): Context {
  return {
    ...context,
    messages: context.messages.map((msg) => {
      if (msg.role !== "user") return msg;
      if (typeof msg.content === "string") {
        return { ...msg, content: stripKnownMarkers(msg.content) } satisfies UserMessage;
      }
      return {
        ...msg,
        content: msg.content.map((item) =>
          item.type === "text" ? ({ ...item, text: stripKnownMarkers(item.text) } satisfies TextContent) : item,
        ),
      } satisfies UserMessage;
    }),
  };
}

export function withAdvisorGuidance(context: Context, guidance: string, policy: PolicyDecision): Context {
  const advice = [
    "Private advisor guidance from GLM-5.2. Use it as optional critique; do not mention it unless useful.",
    `Routing: requested=${policy.requestedMode}, selected=${policy.mode}, reason=${policy.reason}.`,
    "Guidance:",
    guidance.trim(),
  ].join("\n");

  return {
    ...context,
    systemPrompt: [context.systemPrompt, advice].filter(Boolean).join("\n\n"),
  };
}

export function withFullMoaGuidance(context: Context, result: FullMoaResult, policy: PolicyDecision): Context {
  const advice = [
    "Private full-MoA proposal bundle. Use it as auxiliary judgment; do not mention internal routing unless useful.",
    `Routing: requested=${policy.requestedMode}, selected=${policy.mode}, reason=${policy.reason}.`,
    "Independent proposals:",
    ...result.proposals.map((proposal, index) => [
      `Proposal ${index + 1}: ${proposal.label} (${proposal.provider}/${proposal.model}, cacheHit=${proposal.cacheHit})`,
      proposal.text.trim(),
    ].join("\n")),
    ...(result.synthesis
      ? [
          "Synthesis layer:",
          result.synthesis.text.trim(),
        ]
      : []),
    "Final instruction: synthesize one coherent answer/action path. Only you may use tools.",
  ].join("\n\n");

  return {
    ...context,
    systemPrompt: [context.systemPrompt, advice].filter(Boolean).join("\n\n"),
  };
}

export function messageText(message: UserMessage): string {
  if (typeof message.content === "string") return stripKnownMarkers(message.content);
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => stripKnownMarkers(item.text))
    .join("\n");
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function stripKnownMarkers(text: string): string {
  return text
    .replace(/<!--\s*gsd-moa:(advisor|on|full|full_moa|single|off)\s*-->/gi, "")
    .trim();
}
