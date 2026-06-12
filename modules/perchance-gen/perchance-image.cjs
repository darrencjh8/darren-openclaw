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

async function setupLocalStorage(page, userKey) {
    await page.evaluate(function (uk) {
        var now = Date.now();
        localStorage.setItem("adAccessCode", "");
        localStorage.setItem(
            "userKey-0",
            "e9bed1654c08f0b726f975ea94b5c27ec9580fda1b7c67714125f90fe1c1e5b2",
        );
        localStorage.setItem("userKey-1", uk);
        localStorage.setItem("subChannelName", "public");
        localStorage.setItem("consecutiveFails", "0");
        localStorage.setItem("lastThreadUsed", "0");
        localStorage.setItem("threadLastActiveTime-0", String(now));
        localStorage.setItem("threadLastActiveTime-1", String(now - 10000));
        localStorage.setItem("recentlyVerified-0", "");
        localStorage.setItem("recentlyVerified-1", "");
        localStorage.setItem(
            "lastCheckUserVerificationStatusStartTime-userKey-0",
            String(now),
        );
        localStorage.setItem(
            "lastCheckUserVerificationStatusStartTime-userKey-1",
            String(now),
        );
        localStorage.setItem("okayToShowNsfwUntil", "2096094064629");
        localStorage.setItem("anotherEmbedIsVerifying", "");
        localStorage.setItem(
            "anotherEmbedIsVerifying_lastActiveTime",
            String(now - 5000),
        );
    }, userKey);
}

async function getBrowser() {
    var browser = await chromium.connectOverCDP(HOST_CDP);
    var contexts = browser.contexts();
    return {
        browser: browser,
        context: contexts[0] || contexts[Object.keys(contexts)[0]],
    };
}

async function getCloudflareCookie(context) {
    var page = await context.newPage();
    await page.goto("https://perchance.org/ai-character-generator", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise(function (r) {
        setTimeout(r, 10000);
    });
    var cookies = await context.cookies();
    var cf = cookies.find(function (c) {
        return c.name === "cf_clearance";
    });
    await page.close();
    if (!cf) throw new Error("Cloudflare clearance not obtained");
}

async function verifyAndGetKey(page) {
    for (var t = 1; t >= 0; t--) {
        try {
            var url =
                "https://image-generation.perchance.org/api/verifyUser?thread=" +
                t +
                "&__cacheBust=" +
                Math.random();
            var r = await page.evaluate(async function (u) {
                var resp = await fetch(u, { credentials: "include" });
                return { status: resp.status, text: await resp.text() };
            }, url);
            if (r.status === 200) {
                var body = JSON.parse(r.text);
                if (body.userKey) return body.userKey;
            }
        } catch (e) {}
    }
    return (
        process.env.PERCHANCE_USER_KEY ||
        "f511c9f2ff76f00e68abe2d12da73d8aa003d4bd77ebbd71120316679757af30"
    );
}

async function doGenerate(page, userKey) {
    var genUrl =
        "https://image-generation.perchance.org/api/generate?userKey=" +
        userKey +
        "&requestId=" +
        Math.random().toFixed(20) +
        "&adAccessCode=&__cacheBust=" +
        Math.random();
    var r = await page.evaluate(
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
        if (["success", "generated"].indexOf(JSON.parse(poll.text).status) >= 0)
            break;
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
        await new Promise(function (r) {
            setTimeout(r, 2000);
        });

        var userKey = loadCache() ? loadCache().userKey : null;
        if (!userKey) {
            userKey = await verifyAndGetKey(page);
            saveCache(userKey);
        }
        await setupLocalStorage(page, userKey);
        await doGenerate(page, userKey);
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
            await new Promise(function (r) {
                setTimeout(r, 2000);
            });
            var uk2 = await verifyAndGetKey(page2);
            saveCache(uk2);
            await setupLocalStorage(page2, uk2);
            await doGenerate(page2, uk2);
            console.log(JSON.stringify({ path: outputPath, freshKey: true }));
            await gb2.browser.close();
        } catch (e2) {
            console.error(e.message);
            process.exit(1);
        }
    }
})();
