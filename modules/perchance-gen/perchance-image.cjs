const { chromium } = require("playwright");
const { execSync } = require("child_process");
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

try {
    execSync("pgrep Xvfb", { stdio: "ignore" });
} catch {
    execSync("Xvfb :99 -screen 0 1920x1080x24 &", { stdio: "ignore" });
}

const BASE = "https://image-generation.perchance.org";
const GEN_URL = "https://perchance.org/ai-character-generator";
const CHROME =
    "/home/node/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const CACHE_FILE = "/tmp/perchance-cache.json";
const CACHE_TTL = 25 * 60 * 1000;

const SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
const resolution = SHAPES[shapeArg] || SHAPES.square;
const guidanceScale = parseFloat(guidanceArg) || 7.0;
const systemPrefix = systemPrefixArg || "";
const negativePrompt = negativePromptArg || "";
const fullPrompt = systemPrefix ? `${systemPrefix} ${prompt}` : prompt;

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

const HOST_CDP = "http://172.17.0.1:9223";

async function tryConnectHostCDP() {
    try {
        const browser = await chromium.connectOverCDP(HOST_CDP);
        const context =
            browser.contexts()[0] ||
            browser.contexts()[Object.keys(browser.contexts())[0]];
        // Close stale pages to prevent tab accumulation (keep at least one)
        const pages = context.pages();
        if (pages.length > 1) {
            for (let i = 0; i < pages.length - 1; i++) {
                try { await pages[i].close(); } catch {}
            }
        }
        const page = pages.length ? pages[pages.length - 1] : await context.newPage();
        await page.goto("about:blank", { waitUntil: "networkidle", timeout: 5000 });
        return { browser, page };
    } catch {
        return null;
    }
}

async function getBrowserAndPage() {
    // Try host Chrome first (VNC-visible, has proper system deps)
    const host = await tryConnectHostCDP();
    if (host) return host;

    // Fallback: launch own Chrome
    const browser = await chromium.launch({
        headless: false,
        executablePath: CHROME,
        args: ["--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    return { browser, page };
}

async function getFreshUserKey() {
    const { browser, page } = await getBrowserAndPage();

    // Navigate to generator page and trigger the embed iframe by typing + clicking generate
    await page.goto(GEN_URL, { waitUntil: "networkidle", timeout: 60000 });
    // Wait for Perchance iframe to render (JS-injected after load)

    // Find the generator iframe (the one with the prompt textarea)
    let genFrame = null;
    for (const f of page.frames()) {
        if (
            f.url().includes(".perchance.org/ai-character-generator") &&
            !f.url().startsWith("https://perchance.org/ai-character-generator")
        ) {
            genFrame = f;
            break;
        }
    }
    if (!genFrame) throw new Error("Generator iframe not found");

    // Type prompt and click generate to trigger the embed iframe loading
    const textarea = genFrame.locator("textarea[data-name=description]");
    await textarea.fill("a cat");
    await new Promise((r) => setTimeout(r, 500));
    const genBtn = genFrame.locator("#generateButtonEl");
    await genBtn.click();

    // Now wait for the embed iframe to appear (loaded after clicking generate)
    let embedFrame = null;
    for (let i = 0; i < 15 && !embedFrame; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        for (const f of page.frames()) {
            if (f.url().includes("image-generation.perchance.org/embed")) {
                embedFrame = f;
                break;
            }
        }
    }

    // Call verifyUser from the embed iframe context
    let userKey = null;
    if (embedFrame) {
        const v = await embedFrame.evaluate(async () => {
            const resp = await fetch(
                `/api/verifyUser?thread=1&__cacheBust=${Math.random()}`,
                { credentials: "include" },
            );
            const text = await resp.text();
            return { status: resp.status, text };
        });
        if (v.status === 200) {
            const body = JSON.parse(v.text);
            if (body.userKey) userKey = body.userKey;
        }
    }

    // If embed frame not found or verifyUser failed, try via generator page fetch (cross-origin may work with CORS)
    if (!userKey) {
        try {
            const v = await page.evaluate(async () => {
                const resp = await fetch(
                    `https://image-generation.perchance.org/api/verifyUser?thread=1&__cacheBust=${Math.random()}`,
                    { credentials: "include" },
                );
                const text = await resp.text();
                return { status: resp.status, text };
            });
            if (v.status === 200) {
                const body = JSON.parse(v.text);
                if (body.userKey) userKey = body.userKey;
            }
        } catch {}
    }

    // Fallback to hardcoded keys
    if (!userKey) {
        userKey =
            "f511c9f2ff76f00e68abe2d12da73d8aa003d4bd77ebbd71120316679757af30";
    }

    saveCache(userKey);
    return { browser, page, userKey };
}

async function generateAndDownload(page, userKey) {
    // Find the embed iframe — all API calls must come from image-generation.perchance.org origin
    let ef = null;
    for (const f of page.frames()) {
        if (f.url().includes("image-generation.perchance.org/embed")) {
            ef = f;
            break;
        }
    }
    if (!ef) throw new Error("No embed iframe for API calls");
    const target = ef;

    const genUrl = `/api/generate?userKey=${userKey}&requestId=${Math.random().toFixed(20)}&adAccessCode=&__cacheBust=${Math.random()}`;
    const genResult = await target.evaluate(
        async ({
            url,
            fullPrompt,
            negativePrompt,
            resolution,
            guidanceScale,
        }) => {
            const resp = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: JSON.stringify({
                    prompt: fullPrompt,
                    negativePrompt,
                    seed: -1,
                    resolution,
                    guidanceScale,
                }),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        },
        { url: genUrl, fullPrompt, negativePrompt, resolution, guidanceScale },
    );

    if (genResult.status !== 200)
        throw new Error(`Generate: HTTP ${genResult.status}`);
    let response = JSON.parse(genResult.text);
    if (response.status === "waiting_for_prev_request_to_finish") {
        for (let retry = 0; retry < 5; retry++) {
            await new Promise((r) => setTimeout(r, 20000));
            const retryUrl = `/api/generate?userKey=${userKey}&requestId=${Math.random().toFixed(20)}&adAccessCode=&__cacheBust=${Math.random()}`;
            const retryResult = await target.evaluate(
                async ({
                    url,
                    fullPrompt,
                    negativePrompt,
                    resolution,
                    guidanceScale,
                }) => {
                    const resp = await fetch(url, {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "text/plain;charset=UTF-8" },
                        body: JSON.stringify({
                            prompt: fullPrompt,
                            negativePrompt,
                            seed: -1,
                            resolution,
                            guidanceScale,
                        }),
                    });
                    const text = await resp.text();
                    return { status: resp.status, text };
                },
                {
                    url: retryUrl,
                    fullPrompt,
                    negativePrompt,
                    resolution,
                    guidanceScale,
                },
            );
            response = JSON.parse(retryResult.text);
            if (response.status !== "waiting_for_prev_request_to_finish") break;
        }
    }
    if (response.status !== "success")
        throw new Error(`Generate: ${response.status}`);
    if (!response.imageId || !response.imageDownloadUrl)
        throw new Error("No imageDownloadUrl");

    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await target.evaluate(
            async ({ uk }) => {
                const resp = await fetch(
                    `/api/awaitExistingGenerationRequest?userKey=${uk}&__cacheBust=${Math.random()}`,
                    { credentials: "include" },
                );
                const text = await resp.text();
                return { status: resp.status, text };
            },
            { uk: userKey },
        );
        if (poll.status !== 200) throw new Error(`Await: HTTP ${poll.status}`);
        if (
            JSON.parse(poll.text).status === "success" ||
            JSON.parse(poll.text).status === "generated"
        )
            break;
    }

    const downloadPath = response.imageDownloadUrl;
    let buffer = null;
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const dl = await target.evaluate(async (dp) => {
            const resp = await fetch(dp, { credentials: "include" });
            if (resp.status !== 200) return { ok: false };
            const blob = await resp.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () =>
                    resolve({ ok: true, b64: reader.result });
                reader.readAsDataURL(blob);
            });
        }, downloadPath);
        if (dl.ok) {
            buffer = Buffer.from(dl.b64.split(",")[1], "base64");
            break;
        }
    }
    if (!buffer) throw new Error("Download failed");
    writeFileSync(outputPath, buffer);
    return buffer.length;
}

(async () => {
    try {
        // Cached path
        const cache = loadCache();
        if (
            cache &&
            cache.userKey &&
            Date.now() - cache.updatedAt < CACHE_TTL
        ) {
            try {
                const { browser, page } = await getBrowserAndPage();
                await page.goto(GEN_URL, {
                    waitUntil: "networkidle",
                    timeout: 60000,
                });
                // Wait for Perchance iframe to render
                // Trigger embed iframe
                let genFrame = null;
                for (const f of page.frames()) {
                    if (
                        f
                            .url()
                            .includes(
                                ".perchance.org/ai-character-generator",
                            ) &&
                        !f
                            .url()
                            .startsWith(
                                "https://perchance.org/ai-character-generator",
                            )
                    ) {
                        genFrame = f;
                        break;
                    }
                }
                if (genFrame) {
                    await genFrame
                        .locator("textarea[data-name=description]")
                        .fill("a cat");
                    await genFrame.locator("#generateButtonEl").click();
                    for (let i = 0; i < 15; i++) {
                        await new Promise((r) => setTimeout(r, 2000));
                        if (
                            page
                                .frames()
                                .some((f) =>
                                    f
                                        .url()
                                        .includes(
                                            "image-generation.perchance.org/embed",
                                        ),
                                )
                        )
                            break;
                    }
                }
                const size = await generateAndDownload(page, cache.userKey);
                console.log(
                    JSON.stringify({ path: outputPath, size, cached: true }),
                );
                saveCache(cache.userKey);
                await browser.close();
                return;
            } catch (e) {}
        }

        // Full flow
        const { browser, page, userKey } = await getFreshUserKey();
        const size = await generateAndDownload(page, userKey);
        console.log(JSON.stringify({ path: outputPath, size, fresh: true }));
        await browser.close();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
})();
