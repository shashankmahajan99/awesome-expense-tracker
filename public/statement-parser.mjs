const datePattern = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ]\d{2,4})\b/i;
const amountPattern = /(?:₹|INR|Rs\.?)?\s*(-?[0-9][0-9,]*\.\d{1,2})(?=\s|$|Cr|Dr|\||D\b|C\b)/gi;
const ignored = /opening balance|closing balance|available balance|total debit|total credit|statement summary|page \d|account number|customer id|date\s+(?:narration|transaction)|transaction details.*balance/i;

function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

export function inferStatementCategory(value = "") {
  const text = String(value).toLowerCase();
  const rules = [
    ["Food & dining", /zomato|swiggy|restaurant|cafe|coffee|domino|pizza|burger|kitchen/],
    ["Groceries", /blinkit|zepto|bigbasket|instamart|grocery|supermarket/],
    ["Travel", /uber|ola|rapido|metro|railway|irctc|airlines|flight|petrol|diesel|fuel|indian oil|parking|toll/],
    ["Shopping", /amazon|flipkart|myntra|ajio|retail|store/],
    ["Bills", /electricity|broadband|airtel|jio|vodafone|recharge|utility|rent|emi|dcc fee|service fee|annual fee/],
    ["Health", /hospital|pharmacy|medical|apollo|doctor|clinic|medicine/],
    ["Entertainment", /xsolla|steam|playstation|netflix|spotify|hotstar|cinema|bookmyshow|gaming|game/],
    ["Taxes", /\bigst\b|\bgst\b|\btax\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "Uncategorised";
}

export function logicalStatementRecords(lines) {
  const records = []; let current = "";
  for (const raw of lines) {
    const line = clean(raw); if (!line || ignored.test(line)) continue;
    if (datePattern.test(line)) {
      // PDF extractors often place ICICI's transaction date and value date on
      // separate physical lines. Until an amount has appeared, a second date
      // still belongs to the current transaction rather than starting a new one.
      if (current && !/-?[0-9][0-9,]*\.\d{1,2}/.test(current)) current += ` | ${line}`;
      else { if (current) records.push(current); current = line; }
    }
    else if (current && current.length < 1600) current += ` | ${line}`;
  }
  if (current) records.push(current);
  return records;
}

function amountMatches(record) {
  return [...record.matchAll(amountPattern)].map((match) => ({ raw: match[0], value: Math.abs(Number(match[1].replaceAll(",", ""))), index: match.index ?? 0, end: (match.index ?? 0) + match[0].length })).filter((item) => item.value > 0 && item.value < 100_000_000);
}

function transactionAmount(record, amounts) {
  for (const amount of amounts) {
    const marker = record.slice(amount.end, amount.end + 18).match(/^\s*(?:\||-)?\s*(DR|D|DEBIT|CR|C|CREDIT)\b/i)?.[1]?.toUpperCase();
    if (["DR", "D", "DEBIT"].includes(marker)) return amount;
    if (["CR", "C", "CREDIT"].includes(marker)) return null;
  }
  if (/\b(?:NEFT|IMPS|UPI)[-\/ ]?(?:CR|CREDIT|INWARD)\b|\b(?:SALARY|INTEREST CREDIT|CASH DEPOSIT|REFUND|REVERSAL)\b/i.test(record) && !/\b(?:DR|DEBIT|PAID|PURCHASE|WITHDRAWAL)\b/i.test(record)) return null;
  return amounts[0] || null;
}

export function parseStatementRecords(lines, { filename, accountTag, source, parseDate }) {
  const output = [], seen = new Set();
  for (const record of logicalStatementRecords(lines)) {
    const date = parseDate(record); if (!date) continue;
    const amounts = amountMatches(record), selected = transactionAmount(record, amounts); if (!selected) continue;
    const reference = record.match(/(?:UTR|UPI ref|reference|ref no|transaction id|order id)[:\s\/-]*([A-Z0-9-]{6,40})/i)?.[1] || "";
    let merchant = record.replace(datePattern, " ");
    merchant = merchant.replace(datePattern, " ").replace(amountPattern, " ").replace(/\b(?:DR|CR|DEBIT|CREDIT|D|C)\b/gi, " ").replace(/\|/g, " ");
    merchant = merchant.replace(/\b(?:Chq|Cheque|Ref)\s*(?:No\.?)?\s*[A-Z0-9-]{4,40}\b/gi, " ").replace(/\s+/g, " ").trim().replace(/^[|:\-\s]+|[|:\-\s]+$/g, "").slice(0, 160);
    if (!merchant || /^\d+$/.test(merchant)) merchant = "Bank payment";
    const key = `${date.occurredAt.slice(0, 10)}|${selected.value.toFixed(2)}|${reference.toLowerCase()}|${merchant.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    output.push({ occurredAt: date.occurredAt, timeVerified: date.timeVerified, merchant, description: record.slice(0, 500), amount: selected.value, category: inferStatementCategory(`${merchant} ${record}`), accountTag, sourceFile: filename, source, reference });
  }
  return output;
}
