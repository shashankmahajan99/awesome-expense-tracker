import test from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, explainMatches, importance, matchExplanation, normalizeMerchant, shouldNotify } from "../src/domain.mjs";

test("normalizes merchant names", () => assert.equal(normalizeMerchant("  Acme Pvt. Ltd  "), "Acme"));
test("dedupe keys are stable", () => {
  const transaction = { merchant: "Zomato", amountPaise: 74000, occurredAt: "2026-08-02T13:18:00Z" };
  assert.equal(dedupeKey(transaction), dedupeKey({ ...transaction }));
});
test("batch text locates related merchants", () => {
  const matches = matchExplanation("Petrol and toll were for the Gurgaon trip. Blinkit was groceries.", [{ merchant: "Indian Oil" }, { merchant: "Delhi Gurgaon Toll" }, { merchant: "Blinkit" }, { merchant: "Amazon" }]);
  assert.deepEqual(matches.map((item) => item.merchant), ["Indian Oil", "Delhi Gurgaon Toll", "Blinkit"]);
});
test("batch explanation understands generic category language", () => {
  const matches = explainMatches("The cab and petrol were office travel", [
    { id: "uber", merchant: "Uber India", amountPaise: 54000 },
    { id: "fuel", merchant: "Indian Oil", amountPaise: 220000 },
    { id: "food", merchant: "Zomato", amountPaise: 62000 },
  ]);
  assert.deepEqual(matches.map(({ transaction, category }) => [transaction.id, category]), [["uber", "Travel"], ["fuel", "Travel"]]);
});
test("batch explanation matches exact amounts and assigns their category", () => {
  const matches = explainMatches("₹450 and ₹720 were groceries", [
    { id: "a", merchant: "Corner shop", amountPaise: 45000 },
    { id: "b", merchant: "Local store", amountPaise: 72000 },
    { id: "c", merchant: "Other", amountPaise: 90000 },
  ]);
  assert.deepEqual(matches.map(({ transaction, category }) => [transaction.id, category]), [["a", "Groceries"], ["b", "Groceries"]]);
});
test("batch explanation supports amount ranges", () => {
  const matches = explainMatches("Everything under ₹500 was food", [
    { id: "a", merchant: "Cafe", amountPaise: 24000 },
    { id: "b", merchant: "Restaurant", amountPaise: 49000 },
    { id: "c", merchant: "Shop", amountPaise: 90000 },
  ]);
  assert.deepEqual(matches.map(({ transaction }) => transaction.id), ["a", "b"]);
  assert.ok(matches.every(({ category }) => category === "Food & dining"));
});
test("all plus a category does not sweep unrelated payments", () => {
  const matches = explainMatches("All food payments were team lunch", [
    { id: "food", merchant: "Zomato", amountPaise: 80000 },
    { id: "cab", merchant: "Uber", amountPaise: 80000 },
  ]);
  assert.deepEqual(matches.map(({ transaction }) => transaction.id), ["food"]);
});
test("balanced reminders enforce materiality", () => {
  const preferences = { personality: "Balanced", minimumTotalPaise: 30000, importantAmountPaise: 100000 };
  assert.equal(shouldNotify({ count: 2, amountPaise: 22000, highestAmountPaise: 12000 }, preferences), false);
  assert.equal(shouldNotify({ count: 1, amountPaise: 140000, highestAmountPaise: 140000 }, preferences), true);
});
test("importance increases with amount and uncertainty", () => assert.ok(importance({ amountPaise: 200000, categoryConfidence: .2 }) > importance({ amountPaise: 50000, categoryConfidence: .9 })));
