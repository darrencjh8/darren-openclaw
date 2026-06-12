const { chromium } = require("playwright");
const { writeFileSync } = require("fs");

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
var SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
var shape = SHAPES[shapeArg] || SHAPES.square;
var fullPrompt = systemPrefixArg ? systemPrefixArg + " " + prompt : prompt;
var negativePromptStr = negativePromptArg || "";
var guidance = parseFloat(guidanceArg) || 7.0;

/** Wait for an <img> inside the embed iframe, grab it, save as PNG */
async function waitForImageAndSave(embedFrame) {
    for (var i = 0; i < 60; i++) {
        await new Promise(function (r) {
            setTimeout(r, 1000);
        });
        try {
            var b64 = await embedFrame.evaluate(async function () {
                var imgs = document.querySelectorAll("img");
                for (var img of imgs) {
                    if (img.naturalWidth > 100) {
                        // Try data: URI first, then draw to canvas
                        if (img.src && img.src.startsWith("data:image")) {
                            return img.src;
                        }
                        // Draw cross-origin image to canvas for extraction
                        try {
                            var c = document.createElement("canvas");
                            c.width = img.naturalWidth;
                            c.height = img.naturalHeight;
                            var ctx = c.getContext("2d");
                            ctx.drawImage(img, 0, 0);
                            return c.toDataURL("image/png");
                        } catch (e) {}
                    }
                }
                return null;
            });
            if (b64) {
                writeFileSync(
                    outputPath,
                    Buffer.from(b64.split(",")[1], "base64"),
                );
                return Buffer.byteLength(b64);
            }
        } catch (e) {}
    }
    throw new Error("No image found in embed iframe after 60s");
}

(async function () {
    var page;
    var browser;
    var exitCode = 1;
    try {
        browser = await chromium.connectOverCDP(HOST_CDP);
        var context =
            browser.contexts()[0] ||
            browser.contexts()[Object.keys(browser.contexts())[0]];
        page = await context.newPage();

        // Navigate to the generator page
        await page.goto("https://perchance.org/ai-character-generator", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
        await new Promise(function (r) {
            setTimeout(r, 3000);
        });

        // Find the generator iframe
        var genFrame = null;
        for (var f of page.frames()) {
            if (
                f.url().includes(".perchance.org/ai-character-generator") &&
                !f
                    .url()
                    .startsWith("https://perchance.org/ai-character-generator")
            ) {
                genFrame = f;
                break;
            }
        }
        if (!genFrame) throw new Error("Generator iframe not found");

        // Set resolution/shape: resize the textarea then select shape
        var shapeBtn = genFrame.locator("button[data-name=" + shapeArg + "]");
        if ((await shapeBtn.count()) > 0) await shapeBtn.click();

        // Type the real prompt
        await genFrame
            .locator("textarea[data-name=description]")
            .fill(fullPrompt);
        await new Promise(function (r) {
            setTimeout(r, 500);
        });

        // Click Generate
        await genFrame.locator("#generateButtonEl").click();

        // Wait for the embed iframe to appear
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

        // Wait for image and save
        var size = await waitForImageAndSave(embedFrame);
        console.log(JSON.stringify({ path: outputPath, size: size }));
        exitCode = 0;
    } catch (e) {
        console.error(e.message);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {}
        }
    }
    process.exit(exitCode);
})();
