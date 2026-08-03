import test from "node:test";
import assert from "node:assert/strict";
import { logicalStatementRecords, parseStatementRecords } from "../public/statement-parser.mjs";

const parseDate = (value) => { const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})/); return match ? { occurredAt: `${match[3]}-${match[2]}-${match[1]}T12:00:00.000Z`, timeVerified: false } : null; };

test("reconstructs multiline ICICI statement rows and excludes credits", () => {
  const lines = ["Transaction Date Narration", "01/04/2024", "UPI/merchant one/123456789012", "500.00", "D", "20,000.00", "02/04/2024", "NEFT-CR SALARY", "10,000.00", "C", "30,000.00", "03/04/2024 POS AMAZON", "1,250.00 Dr 28,750.00"];
  assert.equal(logicalStatementRecords(lines).length, 3);
  const rows = parseStatementRecords(lines, { filename: "ICICI.pdf", accountTag: "Savings - ICICI", source: "bank_pdf", parseDate });
  assert.deepEqual(rows.map((row) => row.amount), [500, 1250]);
  assert.match(rows[0].merchant, /merchant one/i);
});

test("uses transaction amount rather than trailing balance", () => {
  const rows = parseStatementRecords(["04/04/2024 UPI/BLINKIT 750.00 D 1,25,900.45"], { filename: "ICICI.pdf", accountTag: "Savings - ICICI", source: "bank_pdf", parseDate });
  assert.equal(rows[0].amount, 750);
});

test("keeps a separately extracted value date with its transaction", () => {
  const lines = ["05/04/2024", "06/04/2024", "UPI/SWIGGY/9988776655", "620.00", "DR", "18,200.00", "07/04/2024", "POS STORE", "900.00 D 17,300.00"];
  const records = logicalStatementRecords(lines);
  assert.equal(records.length, 2);
  assert.match(records[0], /05\/04\/2024.*06\/04\/2024.*SWIGGY/);
  const rows = parseStatementRecords(lines, { filename: "ICICI.pdf", accountTag: "Savings - ICICI", source: "bank_pdf", parseDate });
  assert.deepEqual(rows.map((row) => row.amount), [620, 900]);
});
