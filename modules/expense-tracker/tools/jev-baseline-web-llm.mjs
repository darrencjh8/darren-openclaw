// Measure the EXISTING payee-resolution fallback (Brave web search + LLM pick)
// on the labelled expense corpus, so a candidate replacement can be compared to
// it. Read-only: no Actual Budget, no IMAP, no writes to the repo.
//
// Reproduces `_handle_search_web` + `_classify_merchant` from src/tools.js
// (worktree branch poc/jev-payee-decision). It does NOT run
// `_handle_resolve_merchant`: that function returns Misc at the web step (see
// issue #587), so the fallback is exercised counterfactually over every case,
// and the report labels which cases production would actually route to it.
//
// Usage:
//   node tools/jev-baseline-web-llm.mjs [--limit N] [--out report.json]
//                                       [--corpus dir] [--delay ms] [--dry-run]
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME;
const DEFAULTS = {
    corpus: join(HOME, ".local/state/expense-corpus"),
    memoryRepo: "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md",
    moduleEnv: "/home/darren/darren-openclaw/modules/expense-tracker/.env",
    report: "jev-poc-report-upperbound.json",
    review: "review.json",
    out: join(HOME, ".local/state/expense-corpus/jev-baseline-web-llm.json"),
    limit: 0,
    delay: 0,
};

function parseArgs(argv) {
    const out = { ...DEFAULTS, dryRun: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--limit") out.limit = Number(next());
        else if (a === "--out") out.out = next();
        else if (a === "--corpus") out.corpus = next();
        else if (a === "--report") out.report = next();
        else if (a === "--delay") out.delay = Number(next());
        else if (a === "--dry-run") out.dryRun = true;
        else if (a === "--help") { console.log("see the header of this file"); process.exit(0); }
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

// ── helpers copied verbatim from tools/jev-payee-poc.mjs ────────────────

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

// ── end copied helpers ──────────────────────────────────────────────────

// The module's own .env, the only place its secrets live. Kept separate from
// readEnvFile above (which is ~/.env and mode-gated); never logged.
function moduleKey(name) {
    try {
        for (const line of readFileSync(DEFAULTS.moduleEnv, "utf8").split("\n")) {
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

// src/tools.js `_handle_search_web`, minus the config indirection.
async function searchWeb(merchant, braveKey) {
    if (!braveKey) return { results: [], error: "no brave key" };
    try {
        // Sanitize: trim, strip special characters, truncate to 100 chars
        const sanitized = (merchant || "")
            .trim()
            .replace(/[^\w\s-]/g, "")
            .slice(0, 100);
        const q = encodeURIComponent(sanitized);
        const r = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${q}&count=5&search_lang=en`,
            {
                headers: {
                    "X-Subscription-Token": braveKey,
                    Accept: "application/json",
                },
                signal: AbortSignal.timeout(30000),
            },
        );
        if (!r.ok) return { results: [], error: `HTTP ${r.status}` };
        const data = await r.json();
        const results = (data.web?.results || []).slice(0, 5).map((item) => ({
            title: item.title || "",
            url: item.url || "",
            description: item.description || "",
        }));
        return { results, error: null };
    } catch (e) {
        return { results: [], error: String(e.message || e) };
    }
}

// src/tools.js `_classify_merchant`, prompt and parse included.
function buildPrompt(merchant, searchResults, payeeNames) {
    const snippets = (searchResults || [])
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.description}\n   ${r.url}`)
        .join("\n\n");

    return [
        `Given the merchant name "${merchant}" and the following web search results, determine the most appropriate payee from the list below.`,
        "",
        "Web Search Results:",
        snippets || "No results available.",
        "",
        "Available Payees:",
        payeeNames.join("\n"),
        "",
        'Respond with a JSON object: { "payee": "Chosen Payee Name" }',
    ].join("\n");
}

function parsePayee(content, payeeNames) {
    try {
        const parsed = JSON.parse(content);
        const payee = parsed.payee || null;
        if (payee && !payeeNames.includes(payee)) return { payee: null, outOfList: payee };
        return { payee, outOfList: null };
    } catch {
        // Try to extract JSON from the response
        const jsonMatch = String(content).match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const payee = JSON.parse(jsonMatch[0]).payee || null;
                if (payee && !payeeNames.includes(payee)) return { payee: null, outOfList: payee };
                return { payee, outOfList: null };
            } catch {}
        }
        return { payee: null, outOfList: null };
    }
}

// The incumbent route. codex-router first when it answers, otherwise DeepSeek
// directly with the module's key; both keep the module's own retry budget.
async function detectRoute() {
    try {
        const r = await fetch("http://localhost:4100/v1/models", {
            signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
            return {
                kind: "codex-router",
                url: "http://localhost:4100/v1/chat/completions",
                model: "deepseek-flash",
                temperature: 0,
                apiKey: "",
            };
        }
    } catch {}
    return {
        kind: "deepseek-direct",
        url: "https://api.deepseek.com/v1/chat/completions",
        model: "deepseek-chat",
        temperature: 0,
        apiKey: moduleKey("DEEPSEEK_API_KEY"),
    };
}

async function classify(route, prompt, timeoutMs = 60000) {
    const retryDelays = [1000, 2000, 4000];
    const body = JSON.stringify({
        model: route.model,
        temperature: route.temperature,
        messages: [{ role: "user", content: prompt }],
    });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = Date.now();
        try {
            const r = await fetch(route.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
                },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await r.text();
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
            const data = JSON.parse(text);
            const content = (data.choices || [{}])[0].message?.content || "";
            return { content, ms: Date.now() - started, attempts: attempt + 1 };
        } catch (e) {
            lastError = e;
            if (attempt < 2) await new Promise((res) => setTimeout(res, retryDelays[attempt]));
        }
    }
    throw lastError;
}

function median(sorted) {
    return sorted[Math.floor(sorted.length / 2)];
}

function pct(n, d) {
    return d ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const review = JSON.parse(readFileSync(join(args.corpus, args.review), "utf8"));
    const prior = JSON.parse(readFileSync(join(args.corpus, args.report), "utf8"));
    const memoryText = fetchMemory(null);
    const { merchantToPayee, payees } = parseMemory(memoryText);

    // The 51 labelled cases and their memory-hit/miss split come from the prior
    // report, so this run measures exactly the same case set.
    const truthById = new Map(review.map((r) => [r.id, r]));
    const cases = prior.rows.map((row) => {
        const src = truthById.get(row.id);
        if (!src) throw new Error(`case ${row.id} not in review corpus`);
        return {
            id: row.id,
            merchant: row.merchant,
            truth: row.truth,
            truthCategory: src.category || null,
            split: row.baselineCorrect ? "memory-hit" : "memory-miss",
            baseline: row.baseline,
            memoryHitReason: memoryHit(merchantToPayee, row.merchant),
        };
    });

    // Candidate list must equal the prior report's, or the comparison is void:
    // memory payees + the corpus payees (the upper-bound arm's "known" set).
    const candidates = [...new Set([...payees, ...cases.map((c) => c.truth), "Misc"])].sort();
    if (candidates.length !== prior.candidatePayees) {
        throw new Error(
            `candidate payees=${candidates.length} but report says ${prior.candidatePayees}`,
        );
    }

    const selected = args.limit > 0 ? cases.slice(0, args.limit) : cases;
    console.log(
        `cases=${selected.length}/${cases.length} (memory misses=${cases.filter((c) => c.split === "memory-miss").length}, ` +
        `hits=${cases.filter((c) => c.split === "memory-hit").length}); candidates=${candidates.length}`,
    );

    if (args.dryRun) {
        console.log("\n--- prompt for case 1 ---\n");
        console.log(buildPrompt(selected[0].merchant, [], candidates));
        return;
    }

    const braveKey = apiKey("BRAVE_SEARCH_API_KEY") || moduleKey("BRAVE_SEARCH_API_KEY");
    if (!braveKey) throw new Error("BRAVE_SEARCH_API_KEY is not available");
    const route = await detectRoute();
    if (route.kind === "deepseek-direct" && !route.apiKey) {
        throw new Error("DEEPSEEK_API_KEY is not available in the module .env");
    }
    console.log(`route=${route.kind} model=${route.model} temperature=${route.temperature}`);

    const rows = [];
    const run = async () => {
        for (const [index, item] of selected.entries()) {
            const started = Date.now();
            const search = await searchWeb(item.merchant, braveKey);
            const prompt = buildPrompt(item.merchant, search.results, candidates);
            let row = {
                ...item,
                searchError: search.error,
                searchEmpty: !search.error && search.results.length === 0,
                snippets: search.results,
                answer: null,
                outOfList: null,
                nullReason: null,
                correct: false,
                llmError: null,
                attempts: null,
                ms: null,
                totalMs: null,
            };
            try {
                const reply = await classify(route, prompt);
                if (!reply.content) {
                    row = { ...row, nullReason: "empty content", attempts: reply.attempts, ms: reply.ms };
                } else {
                    const parsed = parsePayee(reply.content, candidates);
                    if (parsed.outOfList) {
                        row = { ...row, outOfList: parsed.outOfList, nullReason: "payee not in candidate list", attempts: reply.attempts, ms: reply.ms };
                    } else if (!parsed.payee) {
                        row = { ...row, nullReason: "unparseable", attempts: reply.attempts, ms: reply.ms };
                    } else {
                        row = {
                            ...row,
                            answer: parsed.payee,
                            correct: parsed.payee === item.truth,
                            attempts: reply.attempts,
                            ms: reply.ms,
                        };
                    }
                }
            } catch (e) {
                row = { ...row, llmError: String(e.message || e), nullReason: "llm error" };
            }
            row = { ...row, totalMs: Date.now() - started };
            rows.push(row);
            const mark = row.llmError ? "ERR " : row.answer === null ? "NULL" : row.correct ? "ok  " : "MISS";
            console.log(
                `[${String(index + 1).padStart(3)}/${selected.length}] ${mark} ` +
                `pred=${row.answer ?? "-"} truth=${row.truth} ` +
                `split=${row.split} brave=${search.error ? `ERR(${search.error})` : search.results.length} ` +
                `ms=${row.ms ?? "-"}`,
            );
            if (args.delay) await new Promise((r) => setTimeout(r, args.delay));
        }
    };

    return run().then(() => {
        const summarize = (label, set) => {
            const answered = set.filter((r) => r.answer !== null);
            const latencies = set.map((r) => r.ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
            return {
                label,
                cases: set.length,
                correct: set.filter((r) => r.correct).length,
                accuracy: set.length ? set.filter((r) => r.correct).length / set.length : null,
                accuracyAnswered: answered.length ? set.filter((r) => r.correct).length / answered.length : null,
                answered: answered.length,
                null: set.filter((r) => r.answer === null).length,
                misc: set.filter((r) => r.answer === "Misc").length,
                wrong: set.filter((r) => r.answer !== null && !r.correct).length,
                braveFailed: set.filter((r) => r.searchError).length,
                braveEmpty: set.filter((r) => r.searchEmpty).length,
                llmFailed: set.filter((r) => r.llmError).length,
                latencyMs: latencies.length
                    ? { min: latencies[0], median: median(latencies), max: latencies[latencies.length - 1] }
                    : null,
            };
        };
        const report = {
            generatedAt: new Date().toISOString(),
            route,
            arm: "incumbent-web-search-llm (counterfactual over all labelled cases)",
            note: "when every row carries an llmError, the LLM route was unusable and no fallback accuracy was measured",
            source: {
                report: join(args.corpus, args.report),
                review: join(args.corpus, args.review),
                fidelity: "no live /payees: candidate list rebuilt from memory payees + corpus payees + Misc",
            },
            cases: rows.length,
            candidatePayees: candidates.length,
            memoryFacts: merchantToPayee.size,
            candidatePayeeNames: candidates,
            splitSource: "jev-poc-report-upperbound.json rows[].baselineCorrect",
            credentialFailure:
                rows.length > 0 && rows.every((r) => r.llmError)
                    ? String(rows[0].llmError)
                        .replace(/sk-[A-Za-z0-9]+/g, "[redacted]")
                        .replace(/api key: \S+/gi, "api key: [redacted]")
                    : null,
            subsets: {
                memoryHit: summarize("memory hits", rows.filter((r) => r.split === "memory-hit")),
                memoryMiss: summarize("memory misses", rows.filter((r) => r.split === "memory-miss")),
                all: summarize("all labelled", rows),
            },
            rows,
        };

        writeFileSync(args.out, JSON.stringify(report, null, 2));

        console.log("\n=== incumbent fallback (Brave + LLM) ===");
        console.log(`route: ${route.kind} (${route.model}, temperature ${route.temperature})`);
        console.log("subset         cases  correct  acc     answered  null  Misc  wrong  braveErr  braveEmpty  llmErr  ms min/med/max");
        for (const s of [report.subsets.memoryHit, report.subsets.memoryMiss, report.subsets.all]) {
            const lat = s.latencyMs ? `${s.latencyMs.min}/${s.latencyMs.median}/${s.latencyMs.max}` : "-";
            console.log(
                `${s.label.padEnd(14)} ${String(s.cases).padStart(5)}  ${String(s.correct).padStart(7)}  ` +
                `${pct(s.correct, s.cases).padStart(6)}  ${String(s.answered).padStart(8)}  ` +
                `${String(s.null).padStart(4)}  ${String(s.misc).padStart(4)}  ${String(s.wrong).padStart(5)}  ` +
                `${String(s.braveFailed).padStart(8)}  ${String(s.braveEmpty).padStart(10)}  ` +
                `${String(s.llmFailed).padStart(6)}  ${lat}`,
            );
        }
        const nullReasons = {};
        for (const r of rows.filter((x) => x.answer === null)) {
            const key = r.nullReason || "unknown";
            nullReasons[key] = (nullReasons[key] || 0) + 1;
        }
        console.log(`null reasons: ${JSON.stringify(nullReasons)}`);
        if (report.credentialFailure) {
            console.log(`BLOCKER: every case failed the LLM route, no accuracy measured: ${report.credentialFailure}`);
        }
        const outOfList = rows.filter((r) => r.outOfList);
        if (outOfList.length) {
            console.log(`payees outside the candidate list (became null): ${outOfList.length}`);
            for (const r of outOfList) console.log(`  ${r.merchant} -> ${r.outOfList} (truth ${r.truth})`);
        }
        const mismatch = rows.filter((r) => (r.memoryHitReason || "Misc") !== r.baseline && r.memoryHitReason !== null);
        console.log(`memoryHit probe disagreeing with report baseline: ${mismatch.length}`);
        console.log(`\nreport written to ${args.out}`);
    });
}

Promise.resolve()
    .then(main)
    .catch((error) => {
        console.error(`failed: ${error.message}`);
        process.exit(1);
    });
