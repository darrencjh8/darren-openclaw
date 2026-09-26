// Measure the account seam on real alert emails, read-only.
//
// Two measurements, because round 5 established they are different questions:
//
//  1. Movement coverage. Does `parseBankMovement` recognise the alert at all?
//     Measured at 0/69: the corpus is dominated by the UOB card shape
//     ("A transaction of SGD 8.50 was made with your UOB Card ending 1234 ..."),
//     which the parser does not cover. So `resolveMovementAccounts` never runs
//     for these emails.
//
//  2. Name matching, which IS the seam. For each alert, which known accounts does
//     it actually name, and when it names only part of one, does
//     `matchAccountByName` place it or refuse? That refusal is the "not in the
//     rule" case a decision layer would be asked to cover.
//
// No budget, no IMAP, no production service. The account list is rebuilt from the
// memory's own account facts, because the live `/accounts` list needs the budget;
// only name matching is exercised, so the stand-in affects identity, not rules.
//
// The corpus records the human's payee per email but NOT the account each
// transaction was booked to, so this reports RATES, never accuracy.
//
// Usage: node tools/jev-account-poc.mjs [--out report.json] [--limit N]
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractEmailContent } from "../src/extractors.js";
import { parseBankMovement, identityMappingsFromFacts } from "../src/bank-movement.js";
import { accountAliases, accountTokens, matchAccountByName, stopwords } from "../src/suffix-facts.js";

const HOME = process.env.HOME;
const CORPUS = join(HOME, ".local/state/expense-corpus");
const MEMORY_REPO = "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md";
const ACCOUNT_FACT = /^-\s+(.+?)\s+is an?\s+(.+?)\s+account$/i;

function arg(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function tally(values) {
    const out = {};
    for (const v of values) out[v] = (out[v] || 0) + 1;
    return out;
}

async function main() {
    const limit = Number(arg("--limit", "0"));
    const out = arg("--out");
    const memoryText = execFileSync(
        "gh", ["api", "-H", "Accept: application/vnd.github.raw+json", MEMORY_REPO], { encoding: "utf8" },
    );

    const accountNames = [];
    for (const raw of memoryText.split("\n")) {
        const m = raw.trim().match(ACCOUNT_FACT);
        if (m && !accountNames.includes(m[1].trim())) accountNames.push(m[1].trim());
    }
    const facts = memoryText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-"));
    const accounts = accountNames.map((name) => ({ id: name, name }));
    const aliases = accountAliases(facts, accounts);
    const mappings = identityMappingsFromFacts(facts, accounts);

    // Distinctive words per account: "UOB Ladies Card" -> {uob, ladies}. A word
    // every account shares ("card", "account") carries no identity.
    const STOP = new Set(stopwords().map((w) => w.toLowerCase()));
    const distinctive = accounts.map((account) => ({
        name: account.name,
        tokens: [...new Set(accountTokens(account.name))].filter((t) => !STOP.has(t)),
    }));

    const review = JSON.parse(readFileSync(join(CORPUS, "review.json"), "utf8"));
    const files = readdirSync(join(CORPUS, "raw")).filter((f) => f.endsWith(".eml")).sort();
    const wanted = new Set(review.map((r) => r.id));
    const cases = files.filter((f) => wanted.has(f)).slice(0, limit > 0 ? limit : undefined);

    console.log(`accounts from memory: ${accounts.length}`);
    console.log(`suffix mappings: ${mappings.suffix.size}, recipient: ${mappings.recipient.size}, aliases: ${aliases.size}\n`);

    const rows = [];
    for (const file of cases) {
        const item = review.find((r) => r.id === file) || {};
        let text = "";
        try {
            text = await extractEmailContent(Buffer.from(readFileSync(join(CORPUS, "raw", file), "utf8")));
        } catch {
            text = "";
        }
        const seen = new Set(accountTokens(text));
        const movement = text ? parseBankMovement(text) : null;

        // Every account whose distinctive words all appear in the alert.
        const named = distinctive.filter((a) => a.tokens.length && a.tokens.every((t) => seen.has(t))).map((a) => a.name);
        // The words that did appear, for the partial-name probe.
        const partial = [...new Set(distinctive.flatMap((a) => a.tokens).filter((t) => seen.has(t)))];

        let outcome;
        let reason = null;
        let placed = null;
        if (named.length === 1) {
            outcome = "names-one-account";
            const match = matchAccountByName(named[0], accounts, aliases);
            placed = match.matched ? match.name : null;
            reason = match.matched ? null : match.reason || "refused";
            if (!match.matched) outcome = "names-one-account-but-refused";
        } else if (named.length > 1) {
            outcome = "names-several-accounts";
        } else {
            outcome = "names-no-account";
        }

        // When the alert names no account outright, does the partial name it does
        // give resolve, or does the resolver refuse it?
        let partialResult = null;
        if (outcome === "names-no-account" && partial.length) {
            const match = matchAccountByName(partial.join(" "), accounts, aliases);
            partialResult = match.matched ? `matched:${match.name || "?"}` : `refused:${match.reason || "?"}`;
        }

        rows.push({
            id: file,
            merchant: item.merchant || null,
            movement: Boolean(movement),
            named,
            partial,
            outcome,
            placed,
            reason,
            partialResult,
        });
    }

    const outcomes = tally(rows.map((r) => r.outcome));
    const partials = tally(rows.filter((r) => r.partialResult).map((r) => r.partialResult.replace(/:.+$/, "")));
    const resolveOrRefuse = tally(rows.filter((r) => r.partialResult).map((r) => r.partialResult));
    const report = {
        generatedAt: new Date().toISOString(),
        accounts: accountNames,
        emails: rows.length,
        movementsParsed: rows.filter((r) => r.movement).length,
        outcomes,
        partialNameOutcomes: partials,
        partialNameDetail: resolveOrRefuse,
        rows,
    };

    console.log("=== movement coverage ===");
    console.log(`parsed as a bank movement: ${report.movementsParsed}/${rows.length}`);
    console.log("\n=== does the alert name a known account? ===");
    for (const [k, v] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    console.log("\n=== when it names no account, what does the partial name it gives do? ===");
    for (const [k, v] of Object.entries(partials).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    console.log("\n  the distinct partial answers (top 10):");
    for (const [k, v] of Object.entries(resolveOrRefuse).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${String(v).padStart(3)}  ${k}`);
    if (out) {
        writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(`\nreport written to ${out}`);
    }
}

main().catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
});
