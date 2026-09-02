const BANK_ALIASES = [
  ["OCBC", /\b(?:ocbc|oversea\s*chinese\s*banking)\b/i],
  ["DBS", /\b(?:dbs|posb)\b/i],
  ["Trust", /\btrust(?:\s+bank)?\b/i],
  ["Citi", /\b(?:citi|citibank)\b/i],
  ["UOB", /\buob\b/i],
  ["Ryt", /\bryt(?:\s+bank)?\b/i],
];

export function bankFromText(value, fallback = null) {
  for (const [bank, re] of BANK_ALIASES) {
    if (re.test(value || "")) return bank;
  }
  return fallback;
}

export function cents(currency, value, direction) {
  const amount = Math.round(Number(String(value).replace(/,/g, "")) * 100);
  if (!Number.isFinite(amount)) return null;
  return direction === "outgoing" ? -amount : amount;
}

function parseTime(raw) {
  const match = String(raw || "").match(/(\d{1,2})[.:](\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();
  if (minute > 59 || hour > 23) return null;
  if (meridiem && hour <= 12) {
    if (hour === 12) hour = 0;
    if (meridiem === "PM") hour += 12;
  }
  return { hour, minute };
}

function receivedParts(receivedAt) {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return { year: Number(pick("year")), month: Number(pick("month")), day: Number(pick("day")) };
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDateTime(dateText, timeText, receivedAt) {
  const dateMatch = String(dateText || "").match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?/i);
  const time = parseTime(timeText);
  if (!time) return null;
  const received = receivedParts(receivedAt);
  if (!received) return null;
  let year = received.year;
  let month = received.month;
  let day = received.day;
  if (dateMatch) {
    day = Number(dateMatch[1]);
    month = MONTHS[dateMatch[2].toLowerCase()];
    year = Number(dateMatch[3] || received.year);
  } else {
    // A time-only alert belongs to the closest completed Singapore date.
    const candidate = Date.UTC(year, month - 1, day, time.hour - 8, time.minute);
    const receivedMs = new Date(receivedAt).getTime();
    if (candidate > receivedMs + 5 * 60 * 1000) {
      const prior = new Date(Date.UTC(year, month - 1, day - 1));
      year = prior.getUTCFullYear();
      month = prior.getUTCMonth() + 1;
      day = prior.getUTCDate();
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:00+08:00`;
}

function field(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(text).match(new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() || "";
}

// Labels recognised by field(), longest-first so prefixed variants
// ("From your account") win over their short forms ("From").
const FIELD_LABELS = [
  "Account that money was deposited in",
  "Reference number",
  "Transaction Ref",
  "Date of Transfer",
  "Date of Payment",
  "Date and Time",
  "Time of Transfer",
  "Time of Payment",
  "Time of deposit",
  "From your account",
  "To account",
  "Description",
  "Reference",
  "Amount",
  "From",
  "To",
  "Date",
  "Time",
];

// extractEmailContent() collapses whitespace, so a labelled alert body can
// arrive as one line and field()'s line-start anchors never fire. Re-insert a
// line break before each known label that is not already at a line start so
// the deterministic parser keeps working without loosening account matching.
function restoreFieldLines(text) {
  const escaped = FIELD_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\n\\r])(?:${escaped})\\s*:`, "gi");
  return String(text).replace(re, "\n$&");
}

export function suffix(value) {
  const match = String(value || "").match(/(?:ending\s+|\(-)(\d{4,})\)?/i);
  return match?.[1] || null;
}

function namedAccount(value, fallbackBank) {
  if (!value) return null;
  return {
    name: String(value).replace(/\s*\((?:A\/C|Ref)?\s*(?:ending\s+)?-?\d+\).*$/i, "").trim(),
    bank: bankFromText(value, fallbackBank),
    suffix: suffix(value),
  };
}

function baseMovement({ direction, amount, currency, occurredAt, ownAccount, counterparty = null, reference = "", merchant = null, descriptor = "" }) {
  if (!amount || !currency || !occurredAt || !ownAccount?.suffix) return null;
  return {
    kind: "bank_movement",
    direction,
    amount_cents: cents(currency, amount, direction),
    currency: currency.toUpperCase(),
    occurred_at: occurredAt,
    own_account: ownAccount,
    counterparty,
    reference_number: reference,
    merchant_display_name: merchant,
    raw_merchant_descriptor: descriptor,
  };
}

export function parseBankMovement(text, { senderBank = null, receivedAt } = {}) {
  const body = restoreFieldLines(String(text || ""));
  const reference = field(body, ["Reference number", "Transaction Ref", "Reference"]);

  // Ryt Bank "Card payment completed" alert — no "Amount :" label.
  //   "RM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8)."
  const ryt = body.match(/(SGD|RM|MYR)\s*([\d,.]+)\s+was paid at\s+(.+?)\s+using\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*,?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (ryt) {
    const currency = /^RM$/i.test(ryt[1]) || /^MYR$/i.test(ryt[1]) ? "MYR" : "SGD";
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const [d, mo, y] = ryt[5].split("/").map((n) => Number(n));
    const month = monthNames[mo - 1];
    if (!month || !Number.isFinite(d) || !Number.isFinite(y)) return null;
    const occurredAt = isoDateTime(`${d} ${month} ${y}`, ryt[6], receivedAt);
    if (!occurredAt) return null;
    const merchant = ryt[3].trim();
    return {
      kind: "bank_movement", direction: "outgoing",
      amount_cents: cents(currency, ryt[2], "outgoing"), currency,
      occurred_at: occurredAt,
      own_account: { name: ryt[4].trim(), bank: senderBank, suffix: null },
      counterparty: { name: merchant, bank: bankFromText(merchant), suffix: null },
      reference_number: "", recipient_bank: null,
      merchant_display_name: merchant,
      raw_merchant_descriptor: merchant,
    };
  }

  const trust = body.match(/received\s+(SGD|MYR)\s*([\d,.]+)\s+from\s+(.+?)\s+A\/C\s+ending\s+(\d{4,})\s+on\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?)\s*SGT/i);
  if (trust) {
    return baseMovement({
      direction: "incoming", amount: trust[2], currency: trust[1],
      occurredAt: isoDateTime(trust[5], trust[6], receivedAt),
      ownAccount: { bank: senderBank || "Trust", suffix: null },
      counterparty: { name: trust[3].trim(), bank: bankFromText(trust[3]), suffix: trust[4] },
      reference,
    }) || {
      kind: "bank_movement", direction: "incoming", amount_cents: cents(trust[1], trust[2], "incoming"), currency: trust[1],
      occurred_at: isoDateTime(trust[5], trust[6], receivedAt), own_account: null,
      counterparty: { name: trust[3].trim(), bank: bankFromText(trust[3]), suffix: trust[4] }, reference_number: reference,
      recipient_bank: senderBank || "Trust", merchant_display_name: null, raw_merchant_descriptor: "",
    };
  }

  const currencyAmount = body.match(/Amount\s*:\s*(SGD|MYR)\s*([\d,.]+)/i);
  if (!currencyAmount) return null;
  const [, currency, amount] = currencyAmount;

  const deposited = field(body, ["Account that money was deposited in"]);
  if (deposited) {
    return baseMovement({
      direction: "incoming", amount, currency,
      occurredAt: isoDateTime("", field(body, ["Time of deposit"]), receivedAt),
      ownAccount: { bank: senderBank, suffix: suffix(deposited) }, reference,
    });
  }

  const from = field(body, ["From your account", "From"]);
  const to = field(body, ["To account", "To"]);
  const dateText = field(body, ["Date of Transfer", "Date of Payment", "Date and Time", "Date"]);
  const timeText = field(body, ["Time of Transfer", "Time of Payment", "Time"])
    || (dateText.match(/\d{1,2}[:.]\d{2}\s*(?:AM|PM)?/i)?.[0] || "");

  if (!from) return null;
  const ownAccount = namedAccount(from, senderBank);
  const destination = namedAccount(to, bankFromText(to));
  const payNow = /PayNow\s+transfer/i.test(body) && !to;
  const merchantMatch = body.match(/made to\s+(.+?)\s+using their\s+Unique Entity Number/i);
  const descriptor = field(body, ["Description"]);
  return baseMovement({
    direction: "outgoing", amount, currency,
    occurredAt: isoDateTime(dateText, timeText, receivedAt),
    ownAccount,
    counterparty: destination?.suffix ? destination : null,
    reference,
    merchant: payNow ? merchantMatch?.[1]?.trim() || null : null,
    descriptor,
  });
}

export function accountMatches(account, evidence) {
  if (!account?.name || account.closed || !evidence?.suffix) return false;
  const bank = bankFromText(account.name);
  if (evidence.bank && bank !== evidence.bank) return false;
  const digits = [...account.name.matchAll(/\d{4,}/g)].map((match) => match[0]);
  return digits.some((value) => value === evidence.suffix || evidence.suffix.endsWith(value) || value.endsWith(evidence.suffix));
}

function resolveAccount(evidence, accounts) {
  if (!evidence?.suffix) return null;
  const matches = accounts.filter((account) => accountMatches(account, evidence));
  return matches.length === 1 ? matches[0] : null;
}

export function identityMappingsFromFacts(facts, accounts) {
  const mappings = { suffix: new Map(), recipient: new Map() };
  for (const fact of facts || []) {
    const text = typeof fact === "string" ? fact : fact?.text || "";
    const suffixMatch = text.match(/^(?:Account|Card) ending\s+(\d{4,})\s+belongs to\s+(.+)$/i);
    if (suffixMatch) {
      // Match the full name first: real account names may themselves end in
      // "Account" (e.g. "DBS Account") and must not be truncated. A trailing
      // filler "account" word ("belongs to X account") is only used as a
      // fallback when the full form has no account match.
      const rawName = suffixMatch[2].trim();
      const candidates = [rawName];
      if (/\s+account$/i.test(rawName)) candidates.push(rawName.replace(/\s+account$/i, ""));
      const account = candidates
        .map((name) => accounts.find((a) => a.name?.toLowerCase() === name.toLowerCase() && !a.closed))
        .find(Boolean);
      if (account) mappings.suffix.set(suffixMatch[1], account);
      continue;
    }
    const recipientMatch = text.match(/^(.+?)\s+alert recipient maps to\s+(.+?)\s+account$/i);
    if (recipientMatch) {
      const account = accounts.find((a) => a.name?.toLowerCase() === recipientMatch[2].trim().toLowerCase() && !a.closed);
      if (account) mappings.recipient.set(bankFromText(recipientMatch[1]), account);
    }
  }
  return mappings;
}

function resolveMappedAccount(evidence, mappings) {
  if (!evidence?.suffix) return null;
  const unique = [
    ...new Map(
      [...mappings.suffix.entries()]
        .filter(([knownSuffix]) =>
          knownSuffix === evidence.suffix ||
          knownSuffix.endsWith(evidence.suffix) ||
          evidence.suffix.endsWith(knownSuffix),
        )
        .map(([, account]) => [account.id, account]),
    ).values(),
  ];
  // Dedup by account so two suffix aliases that resolve to the SAME account
  // (e.g. OCBC 360 as both 869001 and 9001) are not treated as ambiguous.
  return unique.length === 1 ? unique[0] : null;
}

function resolveAccountByBank(evidence, accounts) {
  if (!evidence?.bank) return null;
  const matches = accounts.filter((a) => !a.closed && bankFromText(a.name) === evidence.bank);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveMovementAccounts(movement, accounts, payees, mappings = { suffix: new Map(), recipient: new Map() }) {
  const own = resolveAccount(movement.own_account, accounts)
    || resolveMappedAccount(movement.own_account, mappings)
    || resolveAccountByBank(movement.own_account, accounts)
    || (movement.direction === "incoming" && movement.recipient_bank ? mappings.recipient.get(movement.recipient_bank) || null : null);
  const other = resolveAccount(movement.counterparty, accounts)
    || resolveMappedAccount(movement.counterparty, mappings);
  const destination = movement.direction === "outgoing" ? other : own;
  // For a one-sided incoming movement (deposit into own account, no counterparty),
  // the source is the own account that received the funds.
  const source = movement.direction === "outgoing" ? own : (other || own);
  const destinationPayee = destination
    ? payees.find((payee) => payee.transfer_acct === destination.id) || null
    : null;
  return {
    source_account: source,
    destination_account: destination,
    destination_payee: destinationPayee,
    internal: !!(source && destination && source.id !== destination.id && destinationPayee),
  };
}
