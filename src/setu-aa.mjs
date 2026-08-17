const PURPOSE = {
  category: { type: "string" },
  code: "102",
  text: "Customer spending patterns, budget or other reportings",
  refUri: "https://api.rebit.org.in/aa/purpose/102.xml",
};

export function normalizeIndianMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

export function buildConsentRequest({ mobile, redirectUrl, now = new Date() }) {
  const vua = normalizeIndianMobile(mobile);
  if (!vua) throw new Error("Enter a valid 10-digit Indian mobile number");
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return {
    consentDuration: { unit: "YEAR", value: "1" },
    consentMode: "STORE",
    fetchType: "PERIODIC",
    consentTypes: ["TRANSACTIONS", "SUMMARY"],
    fiTypes: ["DEPOSIT"],
    vua,
    purpose: PURPOSE,
    dataRange: { from: from.toISOString(), to: to.toISOString() },
    dataLife: { unit: "YEAR", value: "1" },
    frequency: { unit: "DAY", value: "1" },
    redirectUrl,
    context: [],
    additionalParams: { tags: ["Paisa_Expense_Tracking"] },
  };
}

function transactionRows(account) {
  const transactions = account?.transactions?.transaction ?? account?.transactions ?? [];
  return Array.isArray(transactions) ? transactions : transactions ? [transactions] : [];
}

export function extractDepositTransactions(payload) {
  const output = [];
  for (const fip of Array.isArray(payload?.fiData) ? payload.fiData : []) {
    for (const item of Array.isArray(fip?.data) ? fip.data : []) {
      const account = item?.decryptedFI?.account;
      if (!account || String(account.type || "").toLowerCase() !== "deposit") continue;
      const masked = String(item.maskedAccNumber || account.maskedAccNumber || "");
      const accountTag = `${String(fip.fipID || "Bank").trim()} ${masked.slice(-4)}`.trim();
      for (const row of transactionRows(account)) {
        const type = String(row.type || row.txnType || "DEBIT").toUpperCase();
        if (type !== "DEBIT") continue;
        const amount = Number(row.amount ?? row.transactionAmount ?? 0);
        const occurredAt = row.transactionTimestamp || row.valueDate || row.transactionDate;
        if (!Number.isFinite(amount) || amount <= 0 || !occurredAt || Number.isNaN(new Date(occurredAt).getTime())) continue;
        const narration = String(row.narration || row.reference || row.mode || "Bank transaction").trim();
        output.push({
          externalRef: String(row.txnid || row.transactionId || row.reference || `${item.linkRefNumber}:${occurredAt}:${amount}:${narration}`),
          amountPaise: Math.round(amount * 100),
          merchant: narration.slice(0, 160),
          description: narration.slice(0, 500),
          occurredAt: new Date(occurredAt).toISOString(),
          accountTag: accountTag.slice(0, 100),
          linkRefNumber: String(item.linkRefNumber || account.linkedAccRef || ""),
          fipId: String(fip.fipID || ""),
        });
      }
    }
  }
  return output;
}

export function publicConsent(row) {
  return {
    id: row.id,
    provider: "Setu AA Gateway",
    status: String(row.status || "PENDING").toUpperCase(),
    mobileLastFour: row.mobile_last_four || "",
    consentUrl: row.status === "PENDING" || row.status === "INITIATED" ? row.consent_url || "" : "",
    purposeCode: row.purpose_code || "102",
    purpose: "Understand spending, prepare budgets, and keep your ledger in sync",
    dataRequested: ["Deposit account summaries", "Deposit account transactions"],
    dataRangeFrom: row.data_range_from,
    dataRangeTo: row.data_range_to,
    expiresAt: row.consent_expires_at,
    frequency: "At most once a day",
    dataLife: "Up to one year, or until deletion where applicable",
    accounts: safeArray(row.accounts_json),
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error_message || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeArray(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
