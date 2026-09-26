// Replay the shipped decision layer (src/jev.js) over the labelled production
// corpus, so the artifact that would run is measured rather than the harness
// that predicted it.
//
// Differences from tools/jev-payee-poc.mjs, both deliberate:
//  - it calls the real `choosePayee`, so the question shape, the candidate
//    filtering, the Misc exclusion and the envelope parsing are the shipped ones;
//  - the state carries only the merchant, because that is all
//    `_handle_resolve_merchant` receives. The earlier harness also passed the raw
//    bank descriptor, so its numbers are an upper bound on this input.
//
// The threshold is set to 0 here so every answer and its confidence is visible,
// and the sweep is computed over those answers instead of calling twice.
//
// Read-only. No budget, no IMAP, no production service.
//
// Usage: node tools/jev-integration-replay.mjs [--out report.json] [--limit N]
import { readFileSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";
import { choosePayee, payeeCandidates } from "../src/jev.js";

const HOME = process.env.HOME;
const CORPUS = join(HOME, ".local/state/expense-corpus");
const MEMORY_REPO = "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md";

function arg(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Same trust rules as the driver: the environment first, then ~/.env, and only a
// regular file the owner alone can read. Never printed.
function readEnvFile(name) {
    try {
        const path = join(HOME, ".env");
        const st = lstatSync(path);
        if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0) return "";
        for (const line of readFileSync(path, "utf8").split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const body = t.startsWith("export ") ? t.slice(7).trim() : t;
            const eq = body.indexOf("=");
            if (eq < 0 || body.slice(0, eq).trim() !== name) continue;
            let v = body.slice(eq + 1).trim();
            if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v[v.length - 1]) v = v.slice(1, -1);
            return v;
        }
    } catch {
        return "";
    }
    return "";
}

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const padded = (s) => ` ${words(s)} `;

function memoryHit(merchantToPayee, merchant) {
    const hay = padded(merchant);
    const hits = new Map();
    for (const [key, values] of merchantToPayee) {
        const needle = padded(key);
        if (needle.trim() && hay.includes(needle)) {
            for (const v of values) hits.set(v, (hits.get(v) || 0) + 1);
        }
    }
    return hits.size ? [...hits.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
}

async function main() {
    const limit = Number(arg("--limit", "0"));
    const out = arg("--out");
    const review = JSON.parse(readFileSync(join(CORPUS, "review.json"), "utf8"));
    const payeeReport = JSON.parse(readFileSync(join(CORPUS, "jev-poc-report-nomisc.json"), "utf8"));

    const { execFileSync } = await import("child_process");
    const memoryText = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw+json", MEMORY_REPO], { encoding: "utf8" });
    const merchantToPayee = new Map();
    for (const raw of memoryText.split("\n")) {
        const t = raw.trim();
        const m = t.match(/^-\s+(.+?)\s+(?:merchant\s+)?maps\s+to\s+(.+?)\s+payee$/i);
        if (!m) continue;
        const key = m[1].trim().replace(/\s+(?:merchant|payee|category)$/i, "").trim();
        if (!key) continue;
        if (!merchantToPayee.has(key)) merchantToPayee.set(key, new Set());
        merchantToPayee.get(key).add(m[2].trim());
    }

    // The payee universe: the real budget lists when asked for them, otherwise the
    // label-derived set the earlier arms used.
    const livePath = join(CORPUS, "live-payees.json");
    let supplied;
    if (arg("--live-payees")) {
        const live = JSON.parse(readFileSync(livePath, "utf8"));
        const names = [...new Set(Object.values(live).flat())];
        supplied = names.map((name) => ({ name }));
    } else {
        const prior = JSON.parse(readFileSync(join(CORPUS, "jev-poc-report-upperbound.json"), "utf8"));
        const corpusPayees = prior.rows.map((r) => r.truth).filter(Boolean);
        supplied = [...new Set([
            ...[...merchantToPayee.values()].flatMap((s) => [...s]),
            ...corpusPayees,
            "Misc",
        ])].map((name) => ({ name }));
    }

    const key = (process.env.COMMANDCODE_API_KEY || "").trim() || readEnvFile("COMMANDCODE_API_KEY");
    if (!key) throw new Error("COMMANDCODE_API_KEY is not available (environment or ~/.env)");

    const config = {
        jevEnabled: true,
        jevApiKey: key,
        jevThreshold: 0,             // keep every answer so the sweep is computed here
        jevMaxCandidates: Number(arg("--cap", "60")),
        jevTimeoutMs: 20000,
    };

    const labelled = review.filter((r) => !r.skip && r.payee && r.merchant);
    const cases = limit > 0 ? labelled.slice(0, limit) : labelled;
    const rows = [];

    for (const [index, item] of cases.entries()) {
        const baseline = memoryHit(merchantToPayee, item.merchant) || "Misc";
        const started = Date.now();
        // Exactly what the seam passes: the merchant, and the live payee list.
        const decision = await choosePayee({ merchant: item.merchant, payees: supplied, config });
        rows.push({
            id: item.id,
            merchant: item.merchant,
            truth: item.payee,
            baseline,
            baselineCorrect: baseline === item.payee,
            offered: decision ? decision.candidates.length : payeeCandidates(supplied, item.merchant, 60).length,
            answer: decision ? decision.payee : "",
            confidence: decision ? decision.confidence : null,
            correct: Boolean(decision) && decision.payee === item.payee,
            ms: Date.now() - started,
        });
        const r = rows[rows.length - 1];
        console.log(
            `[${String(index + 1).padStart(3)}/${cases.length}] ${r.correct ? "ok  " : r.answer ? "MISS" : "none"} ` +
            `pred=${r.answer || "-"} truth=${r.truth} conf=${r.confidence ?? "-"} base=${r.baseline}`,
        );
    }

    const answered = rows.filter((r) => r.answer);
    const misses = rows.filter((r) => !r.baselineCorrect);
    const hits = rows.filter((r) => r.baselineCorrect);
    const sweep = (subset) => [0.5, 0.8, 0.9, 0.95, 0.99].map((t) => {
        const above = subset.filter((r) => (r.confidence ?? 0) >= t);
        return {
            threshold: t,
            auto: above.length,
            precision: above.length ? above.filter((r) => r.correct).length / above.length : null,
        };
    });
    const latencies = rows.map((r) => r.ms).sort((a, b) => a - b);

    const report = {
        generatedAt: new Date().toISOString(),
        path: "src/jev.js choosePayee, merchant-only state",
        cases: rows.length,
        candidatePayees: supplied.length,
        baselineCorrect: hits.length,
        answered: answered.length,
        jevCorrect: rows.filter((r) => r.correct).length,
        memoryMisses: misses.length,
        missCorrect: misses.filter((r) => r.correct).length,
        memoryHits: hits.length,
        hitBroken: hits.filter((r) => !r.correct).length,
        missSweep: sweep(misses),
        latencyMs: { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1] },
        rows,
    };

    console.log("\n=== shipped path, merchant-only input ===");
    console.log(`baseline (memory else Misc): ${hits.length}/${rows.length}`);
    console.log(`jev answered: ${answered.length}/${rows.length}; correct overall ${report.jevCorrect}`);
    console.log(`memory misses: ${misses.length}; correct ${report.missCorrect}`);
    console.log(`memory hits broken: ${report.hitBroken}/${hits.length}`);
    console.log(`latency ms min/median/max: ${report.latencyMs.min}/${report.latencyMs.median}/${report.latencyMs.max}`);
    console.log("\nthreshold  auto  precision   (on the memory-miss path)");
    for (const s of report.missSweep) {
        console.log(`${s.threshold.toFixed(2)}      ${String(s.auto).padStart(4)}  ${s.precision === null ? "n/a" : `${(s.precision * 100).toFixed(0)}%`}`);
    }
    if (out) {
        writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(`\nreport written to ${out}`);
    }
}

main().catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
});
