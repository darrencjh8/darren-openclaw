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

const HOST_CDP = process.env.CDP_URL || "http://172.17.0.1:9223";
const CACHE_FILE = "/tmp/perchance-cache.json";

const SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
const resolution = SHAPES[shapeArg] || SHAPES.square;
const guidanceScale = parseFloat(guidanceArg) || 7.0;
const fullPrompt = systemPrefixArg ? systemPrefixArg + " " + prompt : prompt;
const negativePrompt = negativePromptArg || "";

function loadCache() {
    try {
        if (existsSync(CACHE_FILE))
            return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    } catch {}
    return null;
}
function saveCache(userKey) {
    try {
        writeFileSync(
            CACHE_FILE,
            JSON.stringify({ userKey, updatedAt: Date.now() }, null, 2),
        );
    } catch {}
}

async function getBrowser() {
    const browser = await chromium.connectOverCDP(HOST_CDP);
    const contexts = browser.contexts();
    return {
        browser,
        context: contexts[0] || contexts[Object.keys(contexts)[0]],
    };
}

async function getCloudflareCookie(context) {
    const page = await context.newPage();
    await page.goto("https://perchance.org/ai-character-generator", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 10000));
    const cookies = await context.cookies();
    const cf = cookies.find((c) => c.name === "cf_clearance");
    await page.close();
    if (!cf) throw new Error("Cloudflare clearance not obtained");
}

async function verifyAndGetKey(page) {
    for (const thread of [1, 0]) {
        try {
            const url =
                "https://image-generation.perchance.org/api/verifyUser?thread=" +
                thread +
                "&__cacheBust=" +
                Math.random();
            const r = await page.evaluate(async (u) => {
                const resp = await fetch(u, { credentials: "include" });
                const text = await resp.text();
                return { status: resp.status, text: text };
            }, url);
            if (r.status === 200) {
                const body = JSON.parse(r.text);
                if (body.userKey) return body.userKey;
            }
        } catch {}
    }
    return (
        process.env.PERCHANCE_USER_KEY ||
        "f511c9f2ff76f00e68abe2d12da73d8aa003d4bd77ebbd71120316679757af30"
    );
}

async function generateAndDownload(page, userKey) {
    var genUrl =
        "https://image-generation.perchance.org/api/generate?userKey=" +
        userKey +
        "&requestId=" +
        Math.random().toFixed(20) +
        "&adAccessCode=&__cacheBust=" +
        Math.random();
    var r = await page.evaluate(
        async (p) => {
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

    if (r.status !== 200) throw new Error("Generate HTTP " + r.status);
    var resp = JSON.parse(r.text);

    if (resp.status === "waiting_for_prev_request_to_finish") {
        for (var i = 0; i < 5; i++) {
            await new Promise(function (r) {
                setTimeout(r, 20000);
            });
            var retryUrl =
                "https://image-generation.perchance.org/api/generate?userKey=" +
                userKey +
                "&requestId=" +
                Math.random().toFixed(20) +
                "&adAccessCode=&__cacheBust=" +
                Math.random();
            var rr = await page.evaluate(
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
            resp = JSON.parse(rr.text);
            if (resp.status !== "waiting_for_prev_request_to_finish") break;
        }
    }
    if (resp.status !== "success") throw new Error("Generate: " + resp.status);
    if (!resp.imageDownloadUrl) throw new Error("No imageDownloadUrl");

    for (var i = 0; i < 30; i++) {
        await new Promise(function (r) {
            setTimeout(r, 2000);
        });
        var pollUrl =
            "https://image-generation.perchance.org/api/awaitExistingGenerationRequest?userKey=" +
            userKey +
            "&__cacheBust=" +
            Math.random();
        var poll = await page.evaluate(async function (u) {
            var resp = await fetch(u, { credentials: "include" });
            return { status: resp.status, text: await resp.text() };
        }, pollUrl);
        if (poll.status !== 200) throw new Error("Await HTTP " + poll.status);
        var pr = JSON.parse(poll.text);
        if (pr.status === "success" || pr.status === "generated") break;
    }

    var dl = await page.evaluate(async function (url) {
        var resp = await fetch(url, { credentials: "include" });
        if (resp.status !== 200) return null;
        var blob = await resp.blob();
        return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onloadend = function () {
                resolve(reader.result);
            };
            reader.readAsDataURL(blob);
        });
    }, resp.imageDownloadUrl);
    if (!dl) throw new Error("Download failed");
    writeFileSync(outputPath, Buffer.from(dl.split(",")[1], "base64"));
    return true;
}

(async function () {
    try {
        var gb = await getBrowser();
        await getCloudflareCookie(gb.context);
        var page = await gb.context.newPage();
        await page.goto("https://image-generation.perchance.org/embed", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        var userKey = loadCache() ? loadCache().userKey : null;
        if (!userKey) {
            userKey = await verifyAndGetKey(page);
            saveCache(userKey);
        }

        await generateAndDownload(page, userKey);
        console.log(
            JSON.stringify({ path: outputPath, cached: !!loadCache() }),
        );
        await gb.browser.close();
    } catch (e) {
        try {
            var gb2 = await getBrowser();
            await getCloudflareCookie(gb2.context);
            var page2 = await gb2.context.newPage();
            await page2.goto("https://image-generation.perchance.org/embed", {
                waitUntil: "domcontentloaded",
                timeout: 30000,
            });
            var uk2 = await verifyAndGetKey(page2);
            saveCache(uk2);
            await generateAndDownload(page2, uk2);
            console.log(JSON.stringify({ path: outputPath, freshKey: true }));
            await gb2.browser.close();
        } catch (e2) {
            console.error(e.message);
            process.exit(1);
        }
    }
})();
