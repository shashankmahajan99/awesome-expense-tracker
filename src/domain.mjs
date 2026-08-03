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

const explanationCategories = {
  "Food & dining": ["food", "meal", "dinner", "lunch", "breakfast", "restaurant", "cafe", "swiggy", "zomato", "dominos", "pizza"],
  Groceries: ["grocery", "groceries", "supermarket", "blinkit", "zepto", "bigbasket", "instamart"],
  Travel: ["travel", "trip", "cab", "taxi", "uber", "ola", "metro", "train", "flight", "fuel", "petrol", "diesel", "toll", "parking", "indian oil"],
  Shopping: ["shopping", "clothes", "amazon", "flipkart", "myntra", "ajio"],
  Bills: ["bill", "bills", "electricity", "water", "gas", "recharge", "broadband", "mobile", "rent", "emi"],
  Health: ["health", "doctor", "pharmacy", "medicine", "medical", "hospital", "apollo"],
  Entertainment: ["entertainment", "movie", "cinema", "netflix", "spotify", "hotstar", "game", "gaming"],
};

const explanationStopWords = new Set(["a", "all", "and", "are", "as", "at", "for", "from", "in", "is", "it", "my", "of", "on", "or", "payment", "payments", "spend", "spending", "that", "the", "these", "this", "to", "today", "transaction", "transactions", "was", "were"]);
function normalizedWords(value = "") { return String(value).toLowerCase().match(/[a-z0-9]+/g) || []; }
function phraseIncluded(value, phrase) { return new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+")}([^a-z0-9]|$)`, "i").test(value); }

function amountSelectors(value) {
  const number = (raw) => Number(String(raw).replaceAll(",", ""));
  const selectors = [];
  const between = value.match(/\bbetween\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:and|to|-)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (between) selectors.push({ type: "range", minimum: Math.min(number(between[1]), number(between[2])), maximum: Math.max(number(between[1]), number(between[2])), index: between.index || 0 });
  for (const match of value.matchAll(/\b(?:under|below|less than|up to)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/gi)) selectors.push({ type: "maximum", maximum: number(match[1]), index: match.index || 0 });
  for (const match of value.matchAll(/\b(?:over|above|more than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/gi)) selectors.push({ type: "minimum", minimum: number(match[1]), index: match.index || 0 });
  const coveredRanges = selectors.map((selector) => selector.index);
  for (const match of value.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\b/gi)) {
    const amount = number(match[1] || match[2]);
    if (!Number.isFinite(amount) || (amount >= 1900 && amount <= 2100) || coveredRanges.some((index) => Math.abs(index - (match.index || 0)) < 18)) continue;
    selectors.push({ type: "exact", amount, index: match.index || 0 });
  }
  return selectors;
}

function selectorMatches(selector, amount) {
  if (selector.type === "exact") return Math.abs(amount - selector.amount) < .01;
  if (selector.type === "range") return amount >= selector.minimum && amount <= selector.maximum;
  if (selector.type === "minimum") return amount > selector.minimum;
  return amount < selector.maximum;
}

function categoryMentions(value) {
  const mentions = [];
  for (const [category, phrases] of Object.entries(explanationCategories)) {
    for (const phrase of phrases) {
      let from = 0;
      while (from < value.length) {
        const index = value.indexOf(phrase, from); if (index < 0) break;
        if (phraseIncluded(value.slice(Math.max(0, index - 1), index + phrase.length + 1), phrase)) mentions.push({ category, phrase, index });
        from = index + phrase.length;
      }
    }
  }
  return mentions;
}

export function explainMatches(text, transactions) {
  const value = String(text || "").toLowerCase();
  const selectors = amountSelectors(value); const mentions = categoryMentions(value);
  const explicitQueue = /\b(everything|every payment|every transaction|the rest|these payments|these transactions)\b/i.test(value);
  const bareAll = /\ball\b/i.test(value) && !mentions.length;
  const matchAll = (explicitQueue || bareAll) && !selectors.length;
  const inputTokens = new Set(normalizedWords(value).filter((word) => word.length > 2 && !explanationStopWords.has(word) && !/^\d+$/.test(word)));
  return transactions.flatMap((transaction) => {
    const merchant = normalizeMerchant(transaction.merchant).toLowerCase();
    const haystack = `${merchant} ${transaction.description || ""} ${transaction.category || ""}`.toLowerCase();
    const amount = Number(transaction.amountPaise ?? Math.round(Number(transaction.amount || 0) * 100)) / 100;
    const matchedSelectors = selectors.filter((selector) => selectorMatches(selector, amount));
    const merchantNamed = merchant.length > 2 && phraseIncluded(value, merchant);
    const merchantTokens = new Set(normalizedWords(haystack).filter((word) => word.length > 2 && !explanationStopWords.has(word)));
    const tokenMatch = [...inputTokens].some((word) => merchantTokens.has(word));
    const semanticCategories = mentions.filter(({ category }) => explanationCategories[category].some((phrase) => phraseIncluded(haystack, phrase)));
    if (!matchAll && !matchedSelectors.length && !merchantNamed && !tokenMatch && !semanticCategories.length) return [];
    const categoryChoices = semanticCategories.length ? semanticCategories : mentions;
    const anchor = matchedSelectors[0]?.index ?? value.indexOf(merchant);
    const category = categoryChoices.length
      ? [...categoryChoices].sort((left, right) => Math.abs(left.index - Math.max(0, anchor)) - Math.abs(right.index - Math.max(0, anchor)))[0].category
      : null;
    return [{ transaction, category }];
  });
}

export function matchExplanation(text, transactions) {
  return explainMatches(text, transactions).map((match) => match.transaction);
}

export function shouldNotify(summary, preferences, alreadyNotified = false) {
  if (alreadyNotified || !summary.count) return false;
  if (preferences.personality === "Strict") return true;
  if (preferences.personality === "Gentle") return summary.amountPaise >= 200000;
  if (summary.amountPaise < Number(preferences.minimumTotalPaise || 30000)) return false;
  return summary.count >= 2 || summary.highestAmountPaise >= Number(preferences.importantAmountPaise || 100000);
}
