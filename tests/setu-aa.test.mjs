import test from "node:test";
import assert from "node:assert/strict";
import { buildConsentRequest, extractDepositTransactions, normalizeIndianMobile } from "../src/setu-aa.mjs";

test("normalizes only valid Indian mobile numbers", () => {
  assert.equal(normalizeIndianMobile("+91 98765 43210"), "9876543210");
  assert.equal(normalizeIndianMobile("5876543210"), null);
  assert.equal(normalizeIndianMobile("98765"), null);
});

test("builds a minimal purpose-102 periodic deposit consent", () => {
  const request = buildConsentRequest({ mobile: "9876543210", redirectUrl: "https://paisa.example/accounts?setu=returned", now: new Date("2026-08-17T12:00:00.000Z") });
  assert.equal(request.purpose.code, "102");
  assert.deepEqual(request.consentTypes, ["TRANSACTIONS", "SUMMARY"]);
  assert.deepEqual(request.fiTypes, ["DEPOSIT"]);
  assert.equal(request.frequency.unit, "DAILY");
  assert.equal(request.dataRange.from, "2025-08-17T12:00:00.000Z");
  assert.equal(request.dataRange.to, "2026-08-17T12:00:00.000Z");
  assert.equal(request.consentTypes.includes("PROFILE"), false);
});

test("extracts debit transactions without retaining holder profile", () => {
  const rows = extractDepositTransactions({ fiData: [{ fipID: "bank-fip", data: [{ linkRefNumber: "link-1", maskedAccNumber: "XXXXXXXX1234", decryptedFI: { account: { type: "deposit", profile: { holders: { holder: [{ pan: "SECRET" }] } }, transactions: { transaction: [{ txnid: "txn-debit", type: "DEBIT", amount: "420.50", transactionTimestamp: "2026-08-17T10:30:00+05:30", narration: "UPI/CAFE" }, { txnid: "txn-credit", type: "CREDIT", amount: "1000", transactionTimestamp: "2026-08-17T11:30:00+05:30", narration: "REFUND" }] } } } }] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalRef, "txn-debit");
  assert.equal(rows[0].amountPaise, 42050);
  assert.equal(rows[0].accountTag, "bank-fip 1234");
  assert.equal(JSON.stringify(rows).includes("SECRET"), false);
});
