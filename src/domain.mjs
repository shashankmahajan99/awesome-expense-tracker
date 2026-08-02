export function normalizeMerchant(value = "") {
  return value.trim().replace(/\s+/g, " ").replace(/\b(pvt|private|ltd|limited)\b\.?/gi, "").trim();
}

export function importance(transaction) {
  const amount = Math.min(Number(transaction.amountPaise || 0) / 100000, 10);
  const uncertainty = Math.max(0, 1 - Number(transaction.categoryConfidence || 0));
  return amount + uncertainty + Number(transaction.unusualMerchantScore || 0) + Number(transaction.transferRisk || 0) + Number(transaction.sharedLikelihood || 0) + Number(transaction.anomalyScore || 0);
}

export function dedupeKey(transaction) {
  const raw = [normalizeMerchant(transaction.merchant).toLowerCase(), transaction.amountPaise, new Date(transaction.occurredAt).toISOString().slice(0, 16)].join("|");
  let hash = 2166136261;
  for (const character of raw) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export function matchExplanation(text, transactions) {
  const value = text.toLowerCase();
  const aliases = {
    "indian oil": ["indian oil", "petrol", "fuel"],
    "delhi gurgaon toll": ["toll", "gurgaon trip"],
    "blinkit": ["blinkit", "grocer", "grocery"],
    "zomato": ["zomato", "dinner", "lunch"],
    "amazon": ["amazon"],
  };
  return transactions.filter((transaction) => {
    const merchant = normalizeMerchant(transaction.merchant).toLowerCase();
    return (aliases[merchant] || [merchant]).some((alias) => value.includes(alias));
  });
}

export function shouldNotify(summary, preferences, alreadyNotified = false) {
  if (alreadyNotified || !summary.count) return false;
  if (preferences.personality === "Strict") return true;
  if (preferences.personality === "Gentle") return summary.amountPaise >= 200000;
  if (summary.amountPaise < Number(preferences.minimumTotalPaise || 30000)) return false;
  return summary.count >= 2 || summary.highestAmountPaise >= Number(preferences.importantAmountPaise || 100000);
}
