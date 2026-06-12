const { chromium } = require("playwright");
const { writeFileSync, readFileSync, existsSync } = require("fs");

const [
    ,
    ,
    prompt,
    outputPath,
    shapeArg,
    systemPrefixArg,
    negativePromptArg,
    guidanceArg,
] = process.argv;
if (!prompt || !outputPath) {
    console.error(
        "Usage: node perchance-image.cjs <prompt> <output-path> [shape] [system-prefix] [negative-prompt] [guidance]",
    );
    process.exit(1);
}

var HOST_CDP = process.env.CDP_URL || "http://172.17.0.1:9223";
var CACHE_FILE = "/tmp/perchance-cache.json";
var CACHE_TTL = 25 * 60 * 1000;
var SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
var resolution = SHAPES[shapeArg] || SHAPES.square;
var guidanceScale = parseFloat(guidanceArg) || 7.0;
var fullPrompt = systemPrefixArg ? systemPrefixArg + " " + prompt : prompt;
var negativePrompt = negativePromptArg || "";

function loadCache() {
    try {
        if (existsSync(CACHE_FILE))
            return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    } catch (e) {}
    return null;
}
function saveCache(userKey) {
    try {
        writeFileSync(
            CACHE_FILE,
            JSON.stringify(
                { userKey: userKey, updatedAt: Date.now() },
                null,
                2,
            ),
        );
    } catch (e) {}
}

/** Connect to host Chrome via CDP and clean up stale pages */
async function connectBrowser() {
    var browser = await chromium.connectOverCDP(HOST_CDP);
    var context =
        browser.contexts()[0] ||
        browser.contexts()[Object.keys(browser.contexts())[0]];
    // Close stale pages to prevent tab accumulation
    var pages = context.pages();
    for (var p of pages) {
        try {
            await p.close();
        } catch (e) {}
    }
    var page = await context.newPage();
    return { browser: browser, page: page };
}

/** Navigate to generator page, trigger embed iframe, return the embed frame */
async function getEmbedFrame(page) {
    // Navigate to the generator page (stays here — do NOT navigate to /embed)
    await page.goto("https://perchance.org/ai-character-generator", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise(function (r) {
        setTimeout(r, 3000);
    });

    // Find the generator iframe (a sub-frame of the main page)
    var genFrame = null;
    for (var f of page.frames()) {
        if (
            f.url().includes(".perchance.org/ai-character-generator") &&
            !f.url().startsWith("https://perchance.org/ai-character-generator")
        ) {
            genFrame = f;
            break;
        }
    }
    if (!genFrame) throw new Error("Generator iframe not found");

    // Type a placeholder prompt and click Generate to trigger the embed iframe
    await genFrame.locator("textarea[data-name=description]").fill("a cat");
    await new Promise(function (r) {
        setTimeout(r, 500);
    });
    await genFrame.locator("#generateButtonEl").click();

    // Wait for the embed iframe to appear (loaded after clicking generate)
    var embedFrame = null;
    for (var i = 0; i < 15 && !embedFrame; i++) {
        await new Promise(function (r) {
            setTimeout(r, 2000);
        });
        for (var f of page.frames()) {
            if (f.url().includes("image-generation.perchance.org/embed")) {
                embedFrame = f;
                break;
            }
        }
    }
    if (!embedFrame) throw new Error("Embed iframe not found after 30s");
    return embedFrame;
}

/** Get userKey from embed iframe via verifyUser API */
async function getOrFetchUserKey(embedFrame) {
    // Check cache first
    var cache = loadCache();
    if (cache && cache.userKey && Date.now() - cache.updatedAt < CACHE_TTL) {
        return cache.userKey;
    }

    // Call verifyUser from embed iframe context
    var userKey = null;
    try {
        var v = await embedFrame.evaluate(async function () {
            var resp = await fetch(
                "/api/verifyUser?thread=1&__cacheBust=" + Math.random(),
                { credentials: "include" },
            );
            var text = await resp.text();
            return { status: resp.status, text: text };
        });
        if (v.status === 200) {
            var body = JSON.parse(v.text);
            if (body.userKey) userKey = body.userKey;
        }
    } catch (e) {}

    // Fallback
    if (!userKey) {
        userKey =
            process.env.PERCHANCE_USER_KEY ||
            "f511c9f2ff76f00e68abe2d12da73d8aa003d4bd77ebbd71120316679757af30";
    }

    saveCache(userKey);
    return userKey;
}

/** Generate image via embed iframe API calls */
async function generateAndDownload(embedFrame, userKey) {
    // --- POST /api/generate ---
    var genUrl =
        "/api/generate?userKey=" +
        userKey +
        "&requestId=" +
        Math.random().toFixed(20) +
        "&adAccessCode=&__cacheBust=" +
        Math.random();
    var genResult = await embedFrame.evaluate(
        async function (p) {
            var resp = await fetch(p.url, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: JSON.stringify({
                    prompt: p.prompt,
                    negativePrompt: p.neg,
                    seed: -1,
                    resolution: p.res,
                    guidanceScale: p.gs,
                }),
            });
            return { status: resp.status, text: await resp.text() };
        },
        {
            url: genUrl,
            prompt: fullPrompt,
            neg: negativePrompt,
            res: resolution,
            gs: guidanceScale,
        },
    );

    if (genResult.status !== 200)
        throw new Error("Generate HTTP " + genResult.status);
    var resp = JSON.parse(genResult.text);

    if (resp.status === "waiting_for_prev_request_to_finish") {
        for (var i = 0; i < 5; i++) {
            await new Promise(function (r) {
                setTimeout(r, 20000);
            });
            var retryUrl =
                "/api/generate?userKey=" +
                userKey +
                "&requestId=" +
                Math.random().toFixed(20) +
                "&adAccessCode=&__cacheBust=" +
                Math.random();
            var retryResult = await embedFrame.evaluate(
                async function (p) {
                    var resp = await fetch(p.url, {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "text/plain;charset=UTF-8" },
                        body: JSON.stringify({
                            prompt: p.prompt,
                            negativePrompt: p.neg,
                            seed: -1,
                            resolution: p.res,
                            guidanceScale: p.gs,
                        }),
                    });
                    return { status: resp.status, text: await resp.text() };
                },
                {
                    url: retryUrl,
                    prompt: fullPrompt,
                    neg: negativePrompt,
                    res: resolution,
                    gs: guidanceScale,
                },
            );
            resp = JSON.parse(retryResult.text);
            if (resp.status !== "waiting_for_prev_request_to_finish") break;
        }
    }
    if (resp.status !== "success") throw new Error("Generate: " + resp.status);
    if (!resp.imageDownloadUrl) throw new Error("No imageDownloadUrl");

    // --- Await generation completion ---
    for (var i = 0; i < 30; i++) {
        await new Promise(function (r) {
            setTimeout(r, 2000);
        });
        var pollUrl =
            "/api/awaitExistingGenerationRequest?userKey=" +
            userKey +
            "&__cacheBust=" +
            Math.random();
        var poll = await embedFrame.evaluate(async function (u) {
            var resp = await fetch(u, { credentials: "include" });
            return { status: resp.status, text: await resp.text() };
        }, pollUrl);
        if (poll.status !== 200) throw new Error("Await HTTP " + poll.status);
        if (["success", "generated"].indexOf(JSON.parse(poll.text).status) >= 0)
            break;
    }

    // --- Download image ---
    var buffer = null;
    for (var i = 0; i < 10; i++) {
        await new Promise(function (r) {
            setTimeout(r, 2000);
        });
        var dl = await embedFrame.evaluate(async function (url) {
            var resp = await fetch(url, { credentials: "include" });
            if (resp.status !== 200) return { ok: false };
            var blob = await resp.blob();
            return new Promise(function (resolve) {
                var reader = new FileReader();
                reader.onloadend = function () {
                    resolve({ ok: true, b64: reader.result });
                };
                reader.readAsDataURL(blob);
            });
        }, resp.imageDownloadUrl);
        if (dl.ok) {
            buffer = Buffer.from(dl.b64.split(",")[1], "base64");
            break;
        }
    }
    if (!buffer) throw new Error("Download failed");
    writeFileSync(outputPath, buffer);
    return buffer.length;
}

(async function () {
    var page;
    try {
        var gb = await connectBrowser();
        page = gb.page;
        var embedFrame = await getEmbedFrame(page);
        var userKey = await getOrFetchUserKey(embedFrame);
        var size = await generateAndDownload(embedFrame, userKey);
        console.log(JSON.stringify({ path: outputPath, size: size }));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    } finally {
        // Always close page so browser tabs don't accumulate
        if (page) {
            try {
                await page.close();
            } catch (e) {}
        }
    }
})();
