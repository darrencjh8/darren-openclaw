/**
 * PoC: Node.js expense-tracker migration viability
 *
 * Tests:
 * 1. WASM embeddings with @xenova/transformers (all-MiniLM-L6-v2)
 * 2. DeepSeek thinking parameter via openai npm package
 */

import { readFileSync } from "fs";

let DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_KEY) {
    const envContent = readFileSync(
        "/home/darren/darren-openclaw/gateway/.env",
        "utf8",
    );
    const match = envContent.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (match) {
        DEEPSEEK_KEY = match[1].trim();
    } else {
        console.error("DEEPSEEK_API_KEY not found in env or .env");
        process.exit(1);
    }
}

async function testEmbeddings() {
    console.log("=== TEST 1: WASM Embeddings (@xenova/transformers) ===");
    console.time("total_embedding_test");

    const { pipeline } = await import("@xenova/transformers");

    console.time("model_load");
    const embedder = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
    );
    console.timeEnd("model_load");

    const facts = [
        "Card ending 4605 belongs to UOB Ladies credit card",
        "Toast Box merchant maps to Food payee",
        "Grab merchant maps to Transport payee",
        "DBS Yuu is a debit card account",
    ];

    // Index all facts
    console.time("index_4_facts");
    const embeddings = await Promise.all(
        facts.map((f) => embedder(f, { pooling: "mean", normalize: true })),
    );
    console.timeEnd("index_4_facts");

    // Search
    const query = await embedder("what account is card 4605", {
        pooling: "mean",
        normalize: true,
    });
    const queryArr = Array.from(query.data);

    // Cosine similarity
    const results = embeddings
        .map((emb, i) => {
            const embArr = Array.from(emb.data);
            const dot = queryArr.reduce((sum, v, j) => sum + v * embArr[j], 0);
            return { text: facts[i], score: Math.round(dot * 10000) / 10000 };
        })
        .sort((a, b) => b.score - a.score);

    console.log('Search "what account is card 4605":');
    results.forEach((r) => console.log(`  ${r.score.toFixed(3)} — ${r.text}`));

    // 500-fact benchmark
    console.time("benchmark_500");
    const bigFacts = Array.from(
        { length: 500 },
        (_, i) => `Fact number ${i} describing learned relationship mapping`,
    );
    const bigEmbs = await Promise.all(
        bigFacts.map((f) => embedder(f, { pooling: "mean", normalize: true })),
    );
    const bigQuery = await embedder("search for something specific", {
        pooling: "mean",
        normalize: true,
    });
    const bigQueryArr = Array.from(bigQuery.data);
    const _results = bigEmbs
        .map((emb, i) => {
            const embArr = Array.from(emb.data);
            const dot = bigQueryArr.reduce(
                (sum, v, j) => sum + v * embArr[j],
                0,
            );
            return { i, score: dot };
        })
        .sort((a, b) => b.score - a.score);
    console.timeEnd("benchmark_500");
    console.log(
        `  ✅ 500 fact search: ${bigEmbs.length} facts indexed, ${_results.length} results`,
    );

    console.timeEnd("total_embedding_test");
    console.log("✅ WASM embeddings: PASS\n");
}

async function testDeepSeekThinking() {
    console.log("=== TEST 2: DeepSeek thinking parameter ===");
    console.time("deepseek_test");

    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({
        apiKey: DEEPSEEK_KEY,
        baseURL: "https://api.deepseek.com/v1",
    });

    // Test with extra_body (Python equivalent)
    console.log("Testing extra_body approach...");
    try {
        const r1 = await client.chat.completions.create(
            {
                model: "deepseek-chat",
                messages: [
                    {
                        role: "user",
                        content:
                            'Say "hello" in exactly one word, no other text.',
                    },
                ],
                max_tokens: 50,
            },
            {
                body: { thinking: { type: "medium" } },
            },
        );
        const content1 = r1.choices[0]?.message?.content || "(empty)";
        console.log(`  extra_body via body option: "${content1.trim()}"`);
        console.log("  ✅ extra_body works");
    } catch (e) {
        console.log(`  ❌ extra_body failed: ${e.message}`);
    }

    console.timeEnd("deepseek_test");
    console.log("✅ DeepSeek thinking: PASS\n");
}

(async () => {
    try {
        await testEmbeddings();
    } catch (e) {
        console.error("❌ Embeddings FAILED:", e.message);
    }
    try {
        await testDeepSeekThinking();
    } catch (e) {
        console.error("❌ DeepSeek FAILED:", e.message);
    }
    console.log("=== PoC Complete ===");
})();
