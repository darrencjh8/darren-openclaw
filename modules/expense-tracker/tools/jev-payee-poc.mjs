// POC: can a typed decision model (jev / systemone) pick the payee for a real
// production email case, and does its confidence separate right from wrong?
//
// Read-only. It replays the labelled expense corpus, prints a comparison against
// both the human's payee and today's memory-or-Misc behaviour, and writes a JSON
// report. It never writes to the budget, never connects to IMAP, and never prints
// an API key.
//
// Usage:
//   node tools/jev-payee-poc.mjs [--limit N] [--out report.json] [--memory-file f]
//                                [--corpus dir] [--dry-run] [--delay ms]
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, statSync, lstatSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME;
const DEFAULTS = {
    corpus: join(HOME, ".local/state/expense-corpus"),
    memoryRepo: "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md",
    endpoint: "https://api.commandcode.ai/provider/v1/systemone",
    model: "typesafe/jev",
    limit: 0,
    delay: 0,
};
const PAYEE_QUESTION = "payee";
const CATEGORY_QUESTION = "category";

function parseArgs(argv) {
    const out = { ...DEFAULTS, memoryFile: null, out: null, dryRun: false, payeesFromCorpus: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--limit") out.limit = Number(next());
        else if (a === "--out") out.out = next();
        else if (a === "--memory-file") out.memoryFile = next();
        else if (a === "--corpus") out.corpus = next();
        else if (a === "--delay") out.delay = Number(next());
        else if (a === "--dry-run") out.dryRun = true;
        else if (a === "--payees-from-corpus") out.payeesFromCorpus = true;
        else if (a === "--help") { console.log("see the header of this file"); process.exit(0); }
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

// The key is read the way the dev-loop driver reads it: the environment first,
// then ~/.env, and only from a regular file the owner alone can read.
function readEnvFile(name) {
    const path = join(HOME, ".env");
    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0) return "";
        for (const line of readFileSync(path, "utf8").split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const body = t.startsWith("export ") ? t.slice(7).trim() : t;
            const eq = body.indexOf("=");
            if (eq < 0) continue;
            if (body.slice(0, eq).trim() !== name) continue;
            let v = body.slice(eq + 1).trim();
            if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[0] === v[v.length - 1]) v = v.slice(1, -1);
            return v;
        }
    } catch {
        return "";
    }
    return "";
}

function apiKey(name) {
    return (process.env[name] || "").trim() || readEnvFile(name);
}

function fetchMemory(file) {
    if (file) return readFileSync(file, "utf8");
    return execFileSync(
        "gh",
        ["api", "-H", "Accept: application/vnd.github.raw+json", DEFAULTS.memoryRepo],
        { encoding: "utf8" },
    );
}

// Same fact grammar the corpus cross-reference tool uses.
function parseMemory(content) {
    const merchantToPayee = new Map();
    const payees = new Set();
    const categories = new Set();
    const PAYEE_RE = /^-\s+(.+?)\s+(?:merchant\s+)?maps\s+to\s+(.+?)\s+payee$/i;
    const CATEGORY_RE = /^-\s+(.+?)\s+maps\s+to\s+(.+?)\s+category(?:\s+\([^)]*\))?$/i;
    const norm = (s) => s.trim().replace(/\s+(?:merchant|payee|category)$/i, "").trim();
    for (const raw of content.split("\n")) {
        const t = raw.trim();
        if (!t.startsWith("-")) continue;
        const payee = t.match(PAYEE_RE);
        if (payee) {
            const key = norm(payee[1]);
            if (!key) continue;
            if (!merchantToPayee.has(key)) merchantToPayee.set(key, new Set());
            merchantToPayee.get(key).add(payee[2].trim());
            payees.add(payee[2].trim());
            continue;
        }
        const category = t.match(CATEGORY_RE);
        if (category) categories.add(category[2].trim());
    }
    return { merchantToPayee, payees, categories };
}

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const padded = (s) => ` ${words(s)} `;

// factNamesMerchant, reduced to its decisive form: the memory key must appear in
// the merchant as whole words, never as a fragment of a longer word.
function memoryHit(merchantToPayee, merchant) {
    const hay = padded(merchant);
    const hits = new Map();
    for (const [key, values] of merchantToPayee) {
        const needle = padded(key);
        if (needle.trim() && hay.includes(needle)) {
            for (const v of values) hits.set(v, (hits.get(v) || 0) + 1);
        }
    }
    if (!hits.size) return null;
    return [...hits.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildQuestions(candidates, categories) {
    const payeeCriteria = {};
    for (const c of candidates) payeeCriteria[c] = `the existing payee named ${c}`;
    const categoryCriteria = {};
    for (const c of categories) categoryCriteria[c] = `the existing category named ${c}`;
    return {
        [PAYEE_QUESTION]: {
            type: "choice",
            instructions:
                "Which existing payee should this transaction be booked to? Choose the payee that names this " +
                "specific merchant. Prefer a specific merchant payee over a generic one, and choose Misc only " +
                "when no other payee could be right.",
            criteria: payeeCriteria,
        },
        [CATEGORY_QUESTION]: {
            type: "choice",
            instructions:
                "Which existing category does this merchant belong to? Choose the single best fit.",
            criteria: categoryCriteria,
        },
    };
}

async function askJev({ endpoint, model, key, state, questions, timeoutMs = 60000 }) {
    const body = JSON.stringify({ model, state, questions });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const started = Date.now();
        let response;
        try {
            response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    "User-Agent": "openclaw-expense-jev-poc/1.0",
                },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            if (attempt === 3) throw new Error(`request failed: ${error.message}`);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
        }
        const text = await response.text();
        if (response.ok) {
            return { payload: JSON.parse(text), ms: Date.now() - started };
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
        }
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    throw new Error("unreachable");
}

function readChoice(payload, name, allowed) {
    const answer = (payload.answers || {})[name] || {};
    const choice = typeof answer.choice === "string" ? answer.choice : "";
    const confidence = typeof answer.confidence === "number" ? answer.confidence : null;
    return {
        choice: allowed.has(choice) ? choice : "",
        raw: choice,
        confidence,
        probabilities: answer.probabilities || {},
    };
}

function pct(n, d) {
    return d ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const key = apiKey("COMMANDCODE_API_KEY");
    if (!key && !args.dryRun) throw new Error("COMMANDCODE_API_KEY is not available (environment or ~/.env)");

    const review = JSON.parse(readFileSync(join(args.corpus, "review.json"), "utf8"));
    const memoryText = fetchMemory(args.memoryFile);
    const { merchantToPayee, payees, categories: memoryCategories } = parseMemory(memoryText);

    const labelled = review.filter((r) => !r.skip && r.payee && r.merchant);
    const cases = args.limit > 0 ? labelled.slice(0, args.limit) : labelled;

    // The candidate set is what the system already knows: the payees named by
    // memory. Building it from the test cases' own labels would leak the answers
    // and force coverage to 100%. `--payees-from-corpus` deliberately does that
    // anyway, as an upper bound on what a complete live payee list could buy.
    const known = [...payees];
    if (args.payeesFromCorpus) known.push(...cases.map((c) => c.payee));
    const candidates = [...new Set([...known, "Misc"])].sort();
    const categories = [...new Set([...memoryCategories, "Uncategorised"])].sort();
    const allowedPayees = new Set(candidates);
    const allowedCategories = new Set(categories);

    console.log(`cases=${cases.length} labelled of ${review.length}; memory facts=${merchantToPayee.size}`);
    console.log(`candidate payees=${candidates.length}; categories=${categories.length}`);
    if (args.dryRun) {
        const questions = buildQuestions(candidates, categories);
        console.log("dry run: question shapes");
        console.log(JSON.stringify(questions[PAYEE_QUESTION], null, 2).slice(0, 400));
        return;
    }

    const rows = [];
    for (const [index, item] of cases.entries()) {
        const state = [
            `merchant: ${item.merchant}`,
            item.raw && item.raw !== item.merchant ? `bank descriptor: ${item.raw}` : null,
        ].filter(Boolean).join("\n");
        const baseline = memoryHit(merchantToPayee, item.merchant) || "Misc";
        let row = {
            id: item.id,
            merchant: item.merchant,
            truth: item.payee,
            truthCategory: item.category || null,
            baseline,
            baselineCorrect: baseline === item.payee,
            covered: allowedPayees.has(item.payee),
            answer: "",
            confidence: null,
            correct: false,
            categoryAnswer: "",
            categoryCorrect: false,
            ms: null,
            error: null,
        };
        try {
            const { payload, ms } = await askJev({
                endpoint: args.endpoint, model: args.model, key, state,
                questions: buildQuestions(candidates, categories),
            });
            const pick = readChoice(payload, PAYEE_QUESTION, allowedPayees);
            const pickCategory = readChoice(payload, CATEGORY_QUESTION, allowedCategories);
            row = {
                ...row,
                answer: pick.choice,
                confidence: pick.confidence,
                correct: pick.choice === item.payee,
                categoryAnswer: pickCategory.choice,
                categoryCorrect: Boolean(item.category) && pickCategory.choice === item.category,
                ms,
            };
        } catch (error) {
            row = { ...row, error: String(error.message || error) };
        }
        rows.push(row);
        const mark = row.error ? "ERR" : row.correct ? "ok " : "MISS";
        console.log(
            `[${String(index + 1).padStart(3)}/${cases.length}] ${mark} ` +
            `pred=${row.answer || "-"} truth=${row.truth} conf=${row.confidence ?? "-"} ` +
            `base=${row.baseline}${row.error ? ` error=${row.error}` : ""}`,
        );
        if (args.delay) await new Promise((r) => setTimeout(r, args.delay));
    }

    const answered = rows.filter((r) => !r.error && r.answer);
    const covered = rows.filter((r) => r.covered);
    const baselineCorrect = rows.filter((r) => r.baselineCorrect).length;
    const jevCorrect = answered.filter((r) => r.correct).length;
    const sweepFor = (subset) => [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99].map((t) => {
        const above = subset.filter((r) => (r.confidence ?? 0) >= t);
        return {
            threshold: t,
            auto: above.length,
            coverage: answered.length ? above.length / rows.length : 0,
            precision: above.length ? above.filter((r) => r.correct).length / above.length : null,
        };
    });
    const sweep = sweepFor(answered);
    const hits = rows.filter((r) => r.baselineCorrect);
    const misses = rows.filter((r) => !r.baselineCorrect);
    const subsetOf = (subset) => ({
        cases: subset.length,
        jevCorrect: subset.filter((r) => r.correct).length,
        covered: subset.filter((r) => r.covered).length,
    });
    const latencies = answered.map((r) => r.ms).filter((n) => typeof n === "number").sort((a, b) => a - b);

    const report = {
        generatedAt: new Date().toISOString(),
        arm: args.payeesFromCorpus ? "corpus-candidates-upper-bound" : "memory-candidates",
        cases: rows.length,
        candidatePayees: candidates.length,
        memoryFacts: merchantToPayee.size,
        memoryHits: subsetOf(hits),
        memoryMisses: subsetOf(misses),
        missSweep: sweepFor(misses.filter((r) => !r.error && r.answer)),
        baselineCorrect,
        baselineAccuracy: rows.length ? baselineCorrect / rows.length : null,
        covered: covered.length,
        coverage: rows.length ? covered.length / rows.length : null,
        answered: answered.length,
        jevCorrect,
        jevAccuracy: answered.length ? jevCorrect / answered.length : null,
        jevAccuracyCovered: covered.length
            ? covered.filter((r) => r.correct).length / covered.length : null,
        categoryAccuracy: answered.length
            ? answered.filter((r) => r.categoryCorrect).length / answered.length : null,
        latencyMs: latencies.length
            ? { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1] }
            : null,
        sweep,
        confidentWrong: answered.filter((r) => !r.correct && (r.confidence ?? 0) >= 0.8)
            .map((r) => ({ id: r.id, merchant: r.merchant, pred: r.answer, truth: r.truth, confidence: r.confidence })),
        errors: rows.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
        rows,
    };

    console.log("\n=== result ===");
    console.log(`baseline (memory -> payee, else Misc): ${baselineCorrect}/${rows.length} = ${pct(baselineCorrect, rows.length)}`);
    console.log(`shortlist coverage (truth is a candidate): ${covered.length}/${rows.length} = ${pct(covered.length, rows.length)}`);
    console.log(`jev answered: ${answered.length}/${rows.length}; correct ${jevCorrect} = ${pct(jevCorrect, answered.length)}`);
    console.log(`jev correct among covered: ${pct(covered.filter((r) => r.correct).length, covered.length)}`);
    console.log(`category correct: ${pct(answered.filter((r) => r.categoryCorrect).length, answered.length)}`);
    if (report.latencyMs) console.log(`latency ms min/median/max: ${report.latencyMs.min}/${report.latencyMs.median}/${report.latencyMs.max}`);
    console.log("\nthreshold  auto  precision");
    for (const s of sweep) {
        const precision = s.precision === null ? "n/a" : `${(s.precision * 100).toFixed(1)}%`;
        console.log(`${s.threshold.toFixed(2)}      ${String(s.auto).padStart(4)}  ${precision}`);
    }
    console.log(`\nby subset (arm: ${report.arm})`);
    console.log(`  memory hits   : ${hits.length} cases, jev correct ${report.memoryHits.jevCorrect} (today all ${hits.length} correct)`);
    console.log(`  memory misses : ${misses.length} cases, jev correct ${report.memoryMisses.jevCorrect}, truth offered ${report.memoryMisses.covered}`);
    console.log("  miss-subset threshold sweep (the seam that matters):");
    for (const s of report.missSweep) {
        const precision = s.precision === null ? "n/a" : `${(s.precision * 100).toFixed(0)}%`;
        console.log(`    >= ${s.threshold.toFixed(2)}  auto ${String(s.auto).padStart(3)}/${misses.length}  precision ${precision}`);
    }
    if (report.confidentWrong.length) {
        console.log("\nconfident but wrong (>=0.80):");
        for (const w of report.confidentWrong) console.log(`  ${w.merchant} -> ${w.pred} (truth ${w.truth}, conf ${w.confidence})`);
    }
    if (report.errors.length) console.log(`\nerrors: ${report.errors.length}`);

    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`\nreport written to ${args.out}`);
    }
}

main().catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
});
