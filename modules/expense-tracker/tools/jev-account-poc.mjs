// Measure how often the EXISTING account resolution settles a real bank-alert
// email, and how often it refuses - the "not in the rule" rate that a decision
// layer would be asked to cover.
//
// Read-only. It reads the labelled corpus of production emails, the live memory
// rules via `gh api`, and calls the shipped resolvers. It touches no budget, no
// mailbox and no production service.
//
// What it can and cannot say: the corpus records the human's payee for each
// email, but NOT which account the transaction was booked to, so this reports
// resolution and refusal RATES, never accuracy.
//
// The account list is rebuilt from the memory's own account facts, because the
// live `/accounts` list needs the budget. Only name matching is exercised, so the
// stand-in affects identity, not the matching rules.
//
// Usage: node tools/jev-account-poc.mjs [--out report.json] [--limit N]
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractEmailContent } from "../src/extractors.js";
import {
    parseBankMovement,
    identityMappingsFromFacts,
    resolveMovementAccounts,
} from "../src/bank-movement.js";
import { accountAliases, matchAccountByName } from "../src/suffix-facts.js";

const HOME = process.env.HOME;
const CORPUS = join(HOME, ".local/state/expense-corpus");
const MEMORY_REPO = "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md";
const ACCOUNT_FACT = /^-\s+(.+?)\s+is an?\s+(.+?)\s+account$/i;

function arg(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
    const limit = Number(arg("--limit", "0"));
    const out = arg("--out");
    const memoryText = execFileSync(
        "gh", ["api", "-H", "Accept: application/vnd.github.raw+json", MEMORY_REPO], { encoding: "utf8" },
    );

    // Account names and the fact lines the resolvers consume.
    const accountNames = [];
    for (const raw of memoryText.split("\n")) {
        const m = raw.trim().match(ACCOUNT_FACT);
        if (m && !accountNames.includes(m[1].trim())) accountNames.push(m[1].trim());
    }
    const facts = memoryText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-"));
    const accounts = accountNames.map((name) => ({ id: name, name }));
    const aliases = accountAliases(facts, accounts);
    const mappings = identityMappingsFromFacts(facts, accounts);

    const review = JSON.parse(readFileSync(join(CORPUS, "review.json"), "utf8"));
    const files = readdirSync(join(CORPUS, "raw")).filter((f) => f.endsWith(".eml")).sort();
    const wanted = new Set(review.map((r) => r.id));
    const cases = files.filter((f) => wanted.has(f)).slice(0, limit > 0 ? limit : undefined);

    console.log(`accounts from memory: ${accounts.length} -> ${accountNames.join(", ")}`);
    console.log(`suffix mappings: ${mappings.suffix.size}, recipient mappings: ${mappings.recipient.size}, aliases: ${aliases.size}`);
    console.log(`emails: ${cases.length}\n`);

    const rows = [];
    for (const file of cases) {
        const item = review.find((r) => r.id === file) || {};
        let text = "";
        try {
            text = await extractEmailContent(Buffer.from(readFileSync(join(CORPUS, "raw", file), "utf8")));
        } catch {
            text = "";
        }
        const movement = text ? parseBankMovement(text) : null;
        if (!movement) {
            rows.push({ id: file, merchant: item.merchant || null, outcome: "no-movement", reason: text ? "not a bank movement" : "no text" });
            continue;
        }
        const resolved = resolveMovementAccounts(movement, accounts, [], mappings);
        const source = resolved.source_account;
        const destination = resolved.destination_account;
        const landed = movement.direction === "incoming" ? destination || source : source || destination;
        const written = (movement.own_account && movement.own_account.name) || "";
        const byName = matchAccountByName(written, accounts, aliases);
        rows.push({
            id: file,
            merchant: item.merchant || movement.counterparty?.name || null,
            direction: movement.direction,
            written_account: written,
            own_bank: movement.own_account?.bank || null,
            suffix: movement.own_account?.suffix || null,
            outcome: landed ? "resolved" : "unresolved",
            resolved_account: landed ? landed.name : null,
            reason: landed ? null : byName.reason || "no account matched",
        });
    }

    const movements = rows.filter((r) => r.outcome !== "no-movement");
    const resolved = movements.filter((r) => r.outcome === "resolved");
    const unresolved = movements.filter((r) => r.outcome === "unresolved");
    const reasons = {};
    for (const r of unresolved) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    const written = {};
    for (const r of movements) written[r.written_account || "(none)"] = (written[r.written_account || "(none)"] || 0) + 1;

    const report = {
        generatedAt: new Date().toISOString(),
        accounts: accountNames,
        suffixMappings: mappings.suffix.size,
        recipientMappings: mappings.recipient.size,
        aliases: aliases.size,
        emails: rows.length,
        movements: movements.length,
        noMovement: rows.length - movements.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        unresolvedReasons: reasons,
        writtenAccounts: written,
        rows,
    };

    console.log(`=== result ===`);
    console.log(`emails read            : ${rows.length}`);
    console.log(`parsed as a bank movement: ${movements.length} (${rows.length - movements.length} were not)`);
    console.log(`account resolved       : ${resolved.length}/${movements.length}`);
    console.log(`account unresolved     : ${unresolved.length}/${movements.length}  <- the "not in the rule" rate`);
    console.log("\nunresolved reasons:");
    for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${reason}`);
    console.log("\nthe account written in the alert, as the resolver saw it:");
    for (const [name, n] of Object.entries(written).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n.toString().padStart(3)}  ${name}`);
    if (out) {
        writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(`\nreport written to ${out}`);
    }
}

main().catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
});
