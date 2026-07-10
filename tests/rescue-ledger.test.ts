import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "../src/pi-compat.js";
import { readRescueLedger, recordRescue, rescueLedgerKey, resetRescueLedger } from "../src/rescue-ledger.ts";

describe("rescue ledger", () => {
  it("keys by alias and conversation identity", () => {
    resetRescueLedger();
    const base: Context = {
      messages: [
        { role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 1 },
        { role: "user", content: "later message", timestamp: 2 },
      ],
    };
    const sameConversation: Context = {
      messages: [
        { role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 1 },
        { role: "user", content: "different later message", timestamp: 100 },
      ],
    };
    const repeatedPromptInAnotherSession: Context = {
      messages: [{ role: "user", content: "<!-- gsd-moa:full --> fix tests", timestamp: 99 }],
    };

    const key = rescueLedgerKey("alias-a", base);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.notEqual(key, rescueLedgerKey("alias-a", sameConversation));
    assert.notEqual(key, rescueLedgerKey("alias-a", repeatedPromptInAnotherSession));
    assert.notEqual(rescueLedgerKey("alias-a", base, "session-one"), rescueLedgerKey("alias-a", base, "session-two"));
    assert.notEqual(rescueLedgerKey("alias-a", base, "session-one"), rescueLedgerKey("alias-a", repeatedPromptInAnotherSession, "session-one"));
    assert.notEqual(key, rescueLedgerKey("alias-b", base));
    assert.notEqual(key, rescueLedgerKey("alias-a", { messages: [{ role: "user", content: "fix build", timestamp: 1 }] }));
  });

  it("records and reads rescue counts", () => {
    resetRescueLedger();
    const key = rescueLedgerKey("alias", { messages: [{ role: "user", content: "task", timestamp: 1 }] });

    assert.equal(readRescueLedger(key), undefined);
    recordRescue(key, 3);
    assert.deepEqual(readRescueLedger(key), { count: 1, totalToolResultsAtLast: 3 });
    recordRescue(key, 7);
    assert.deepEqual(readRescueLedger(key), { count: 2, totalToolResultsAtLast: 7 });
  });

  it("evicts insertion-oldest entries above 64", () => {
    resetRescueLedger();
    const keys = Array.from({ length: 65 }, (_, index) => rescueLedgerKey("alias", { messages: [{ role: "user", content: `task ${index}`, timestamp: 1 }] }));

    keys.forEach((key, index) => recordRescue(key, index));

    assert.equal(readRescueLedger(keys[0]!), undefined);
    assert.deepEqual(readRescueLedger(keys[1]!), { count: 1, totalToolResultsAtLast: 1 });
    assert.deepEqual(readRescueLedger(keys[64]!), { count: 1, totalToolResultsAtLast: 64 });
  });

  it("resets all entries", () => {
    resetRescueLedger();
    const key = rescueLedgerKey("alias", { messages: [{ role: "user", content: "task", timestamp: 1 }] });
    recordRescue(key, 1);
    resetRescueLedger();
    assert.equal(readRescueLedger(key), undefined);
  });
});
