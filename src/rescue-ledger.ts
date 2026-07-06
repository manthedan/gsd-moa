import { createHash } from "node:crypto";
import type { Context } from "./pi-compat.js";
import { rawMessageText } from "./context.js";

export interface RescueLedgerEntry {
  count: number;
  totalToolResultsAtLast: number;
}

const MAX_RESCUE_LEDGER_ENTRIES = 64;
const rescueLedger = new Map<string, RescueLedgerEntry>();

export function rescueLedgerKey(aliasId: string, context: Context): string {
  const firstUser = context.messages.find((message) => message.role === "user");
  const firstUserMessageRawText = firstUser ? rawMessageText(firstUser) : "";
  return createHash("sha256").update(`${aliasId}|${firstUserMessageRawText}`).digest("hex");
}

export function readRescueLedger(key: string): RescueLedgerEntry | undefined {
  const entry = rescueLedger.get(key);
  return entry ? { ...entry } : undefined;
}

export function recordRescue(key: string, totalToolResultCount: number): void {
  const existing = rescueLedger.get(key);
  rescueLedger.set(key, {
    count: (existing?.count ?? 0) + 1,
    totalToolResultsAtLast: totalToolResultCount,
  });

  while (rescueLedger.size > MAX_RESCUE_LEDGER_ENTRIES) {
    const oldestKey = rescueLedger.keys().next().value;
    if (oldestKey === undefined) break;
    rescueLedger.delete(oldestKey);
  }
}

export function resetRescueLedger(): void {
  rescueLedger.clear();
}
