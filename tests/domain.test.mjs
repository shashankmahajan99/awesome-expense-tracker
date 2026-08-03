import test from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, duplicateEvidence, explainMatches, importance, matchExplanation, normalizeMerchant, shouldNotify } from "../src/domain.mjs";

test("normalizes merchant names", () => assert.equal(normalizeMerchant("  Acme Pvt. Ltd  "), "Acme"));
test("dedupe keys are stable", () => {
  const transaction = { merchant: "Zomato", amountPaise: 74000, occurredAt: "2026-08-02T13:18:00Z" };
  assert.equal(dedupeKey(transaction), dedupeKey({ ...transaction }));
});
test("overlapping statements from the same account are deduplicated",()=>{const existing={amount_paise:162500,merchant:"ACH D-ICICI LOAN EMI",description:"ACH D-ICICI LOAN EMI",occurred_at:"2026-08-05T12:00:00Z",time_verified:0,account_tag:"ICICI Savings",source:"icici-july.pdf"};const incoming={amountPaise:162500,merchant:"ACH D ICICI LOAN EMI",description:"ACH D-ICICI LOAN EMI",occurredAt:"2026-08-05T12:00:00Z",timeVerified:false,accountTag:"ICICI Savings"};assert.equal(duplicateEvidence(existing,incoming,"icici-august.pdf"),"statement-overlap");});
test("separate verified payments are not collapsed merely because merchant and amount repeat",()=>{const existing={amount_paise:45000,merchant:"Cafe Coffee Day",occurred_at:"2026-08-05T09:00:00Z",time_verified:1,account_tag:"ICICI Savings",source:"icici.csv"};const incoming={amountPaise:45000,merchant:"Cafe Coffee Day",occurredAt:"2026-08-05T18:00:00Z",timeVerified:true,accountTag:"ICICI Savings"};assert.equal(duplicateEvidence(existing,incoming,"icici.csv"),null);});
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
