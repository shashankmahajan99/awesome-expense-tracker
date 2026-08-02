import test from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, importance, matchExplanation, normalizeMerchant, shouldNotify } from "../src/domain.mjs";

test("normalizes merchant names", () => assert.equal(normalizeMerchant("  Acme Pvt. Ltd  "), "Acme"));
test("dedupe keys are stable", () => {
  const transaction = { merchant: "Zomato", amountPaise: 74000, occurredAt: "2026-08-02T13:18:00Z" };
  assert.equal(dedupeKey(transaction), dedupeKey({ ...transaction }));
});
test("batch text locates related merchants", () => {
  const matches = matchExplanation("Petrol and toll were for the Gurgaon trip. Blinkit was groceries.", [{ merchant: "Indian Oil" }, { merchant: "Delhi Gurgaon Toll" }, { merchant: "Blinkit" }, { merchant: "Amazon" }]);
  assert.deepEqual(matches.map((item) => item.merchant), ["Indian Oil", "Delhi Gurgaon Toll", "Blinkit"]);
});
test("balanced reminders enforce materiality", () => {
  const preferences = { personality: "Balanced", minimumTotalPaise: 30000, importantAmountPaise: 100000 };
  assert.equal(shouldNotify({ count: 2, amountPaise: 22000, highestAmountPaise: 12000 }, preferences), false);
  assert.equal(shouldNotify({ count: 1, amountPaise: 140000, highestAmountPaise: 140000 }, preferences), true);
});
test("importance increases with amount and uncertainty", () => assert.ok(importance({ amountPaise: 200000, categoryConfidence: .2 }) > importance({ amountPaise: 50000, categoryConfidence: .9 })));
