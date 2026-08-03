import test from "node:test";
import assert from "node:assert/strict";
import { parseLoanText } from "../public/loan-parser.mjs";

test("extracts a conventional bank loan schedule", () => {
  const loan = parseLoanText("ICICI Bank Personal Loan Account No: XX9911 Sanctioned Amount ₹5,00,000 EMI Amount 16,250 Tenure 36 months Rate of Interest 10.50% Total Interest 85,000 Processing Fee 2,999 First EMI Date 05/08/2026 Next Due Date 05/09/2026");
  assert.equal(loan.lender, "ICICI Bank");
  assert.equal(loan.accountNumber, "XX9911");
  assert.equal(loan.principal, 500000);
  assert.equal(loan.emiAmount, 16250);
  assert.equal(loan.tenureMonths, 36);
  assert.equal(loan.interestRate, 10.5);
  assert.equal(loan.startDate, "2026-08-05");
});

test("recognises no-cost EMI and forces interest to zero", () => {
  const loan = parseLoanText("HDFC Bank No Cost EMI Amount Financed 60,000 Monthly Installment 10,000 Tenure 6 months Interest Payable 4,500");
  assert.equal(loan.noCostEmi, true);
  assert.equal(loan.interestRate, 0);
  assert.equal(loan.totalInterest, 0);
  assert.equal(loan.loanType, "consumer");
});
