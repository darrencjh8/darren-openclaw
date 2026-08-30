/**
 * Merchant -> payee -> category resolution test against the live memory.
 *
 * Fetches `friday-memory` at test time (via `gh api`, like live-memory.test.js)
 * and verifies each committed fixture merchant resolves to its approved payee
 * and category. This is the "always up-to-date" accuracy gate: when the memory
 * changes, the test re-verifies against the latest mappings.
 *
 * Fixtures contain only public business merchant names; person names (PII) are
 * intentionally excluded and covered by the generic transfer rule elsewhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
    fetchLiveMemory,
    redactMemory,
    parseMemory,
} from "../src/fetch-memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "merchant-mappings.json"), "utf8"),
);

let parsed = null;
let fetchError = null;
try {
    parsed = parseMemory(redactMemory(fetchLiveMemory()));
} catch (e) {
    fetchError = e;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function resolve(merchant) {
    const d = norm(merchant);
    // exact normalized match first
    for (const [m, payees] of parsed.merchantToPayee) {
        if (norm(m) === d) return [...payees].join("|");
    }
    // substring match (longest key wins)
    let best = null;
    let bestLen = 0;
    for (const [m, payees] of parsed.merchantToPayee) {
        const nm = norm(m);
        if (nm.length < 3) continue;
        if (d.includes(nm) || nm.includes(d)) {
            if (nm.length > bestLen) {
                bestLen = nm.length;
                best = [...payees].join("|");
            }
        }
    }
    return best;
}

function categoryOf(payee) {
    const cats = parsed.entityToCategory.get(payee);
    return cats ? [...cats].join("|") : "";
}

const run = fetchError ? describe.skip : describe;

run("merchant -> payee -> category resolution (live memory)", () => {
    it("resolves every fixture merchant to its approved payee", () => {
        const failures = [];
        for (const f of fixtures) {
            const resolved = resolve(f.merchant);
            if (resolved !== f.payee) {
                failures.push(`${f.merchant}: expected ${f.payee}, got ${resolved}`);
            }
        }
        expect(failures).toEqual([]);
    });

    it("resolves every fixture merchant to its approved category", () => {
        const failures = [];
        for (const f of fixtures) {
            if (f.category === null) continue; // Misc / no category
            const cats = categoryOf(f.payee);
            if (!cats.includes(f.category)) {
                failures.push(
                    `${f.merchant} (${f.payee}): expected ${f.category}, got ${cats}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });
});
