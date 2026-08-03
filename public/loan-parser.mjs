const number = (value = "") => {
  const parsed = Number(String(value).replace(/[₹,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const capture = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
};

const amount = (text, labels) => number(capture(text, labels.map((label) => new RegExp(`${label}[^\\d₹]{0,32}(₹?\\s*[\\d,]+(?:\\.\\d{1,2})?)`, "i"))));

const isoDate = (value) => {
  const match = String(value || "").match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!match) return "";
  const year = match[3].length === 2 ? Number(`20${match[3]}`) : Number(match[3]);
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

export function parseLoanText(rawText = "") {
  const text = String(rawText).replace(/\s+/g, " ").trim();
  const lender = capture(text, [/\b(ICICI Bank|HDFC Bank|State Bank of India|SBI|Axis Bank|Kotak Mahindra Bank|Bajaj Finserv|Tata Capital|IDFC FIRST Bank|Yes Bank)\b/i]);
  const loanTypeText = capture(text, [/(home|housing|personal|vehicle|car|education|consumer|credit card)\s+(?:loan|emi)/i]).toLowerCase();
  const typeMap = { housing: "home", car: "vehicle", "credit card": "credit_card" };
  const accountNumber = capture(text, [/(?:loan\s+account|agreement|loan\s+a\/c)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*([A-Z0-9X*-]{4,40})/i]);
  const interestRate = number(capture(text, [/(?:interest|roi|rate of interest)(?:\s+rate)?[^\d]{0,24}(\d+(?:\.\d+)?)\s*%/i]));
  const tenureValue = number(capture(text, [/(?:tenure|term)[^\d]{0,20}(\d{1,4})\s*(months?|years?)/i]));
  const tenureUnit = capture(text, [/(?:tenure|term)[^\d]{0,20}\d{1,4}\s*(months?|years?)/i]).toLowerCase();
  const startRaw = capture(text, [/(?:loan start date|commencement date|first emi date)[^\d]{0,24}(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i]);
  const dueRaw = capture(text, [/(?:next due date|next emi date|due date)[^\d]{0,24}(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i]);
  const noCostEmi = /\bno[- ]cost\s+emi\b/i.test(text);
  const loanType = typeMap[loanTypeText] || loanTypeText || (/\bemi\b/i.test(text) ? "consumer" : "personal");
  const principal = amount(text, ["sanctioned amount", "loan amount", "principal amount", "amount financed"]);
  return {
    name: [lender, loanType === "credit_card" ? "Card EMI" : loanType === "consumer" ? "Consumer EMI" : `${loanType[0]?.toUpperCase() || ""}${loanType.slice(1)} loan`].filter(Boolean).join(" "),
    lender,
    loanType,
    accountNumber,
    principal,
    outstanding: amount(text, ["principal outstanding", "outstanding principal", "outstanding amount", "balance principal"]),
    emiAmount: amount(text, ["monthly instalment", "monthly installment", "emi amount", "instalment amount", "installment amount"]),
    tenureMonths: tenureUnit.startsWith("year") ? tenureValue * 12 : tenureValue,
    interestRate: noCostEmi ? 0 : interestRate,
    totalInterest: noCostEmi ? 0 : amount(text, ["total interest", "interest payable"]),
    processingFee: amount(text, ["processing fee", "processing charges"]),
    startDate: isoDate(startRaw),
    nextDueDate: isoDate(dueRaw),
    noCostEmi,
  };
}
