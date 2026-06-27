import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../src/index.ts";
import { GSD_MOA_MODEL_IDS } from "../src/models.ts";

describe("Pi extension registration", () => {
  it("registers provider gsd-moa with all public aliases", () => {
    const registrations: Array<{ id: string; config: any }> = [];
    extension({
      registerProvider(id: string, config: any) { registrations.push({ id, config }); },
    } as any);

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.id, "gsd-moa");
    assert.equal(typeof registrations[0]?.config.streamSimple, "function");
    assert.deepEqual(
      registrations[0]?.config.models.map((m: any) => m.id).sort(),
      [...GSD_MOA_MODEL_IDS].sort(),
    );
  });
});
