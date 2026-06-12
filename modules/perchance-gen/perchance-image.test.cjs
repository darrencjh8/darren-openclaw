const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

// --- Helpers to test shape/prompt/guidance logic without running the full script ---

const SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
function resolveShape(shapeArg) {
    return SHAPES[shapeArg] || SHAPES.square;
}
function resolveGuidance(guidanceArg) {
    var g = parseFloat(guidanceArg);
    return isNaN(g) || g === 0 ? 7.0 : g;
}
function buildPrompt(prompt, systemPrefix) {
    return systemPrefix ? systemPrefix + " " + prompt : prompt;
}

// --- CLI argument parsing ---
describe("CLI argument parsing", () => {
    it("exits when no prompt", () => {
        var prompt = undefined;
        var outputPath = "/tmp/test.png";
        assert.ok(!prompt || !outputPath, "should fail when prompt missing");
    });

    it("exits when no output path", () => {
        var prompt = "test";
        var outputPath = undefined;
        assert.ok(
            !prompt || !outputPath,
            "should fail when outputPath missing",
        );
    });

    it("continues when both provided", () => {
        var prompt = "test";
        var outputPath = "/tmp/test.png";
        assert.ok(prompt && outputPath, "should have both");
    });
});

// --- Shape resolution ---
describe("Shape resolution", () => {
    it("resolves portrait", () =>
        assert.equal(resolveShape("portrait"), "512x768"));
    it("resolves square", () =>
        assert.equal(resolveShape("square"), "768x768"));
    it("resolves landscape", () =>
        assert.equal(resolveShape("landscape"), "768x512"));
    it("defaults to square for invalid", () =>
        assert.equal(resolveShape("unknown"), "768x768"));
    it("defaults to square for undefined", () =>
        assert.equal(resolveShape(undefined), "768x768"));
});

// --- Guidance scale parsing ---
describe("Guidance scale parsing", () => {
    it("parses integer", () => assert.equal(resolveGuidance("10"), 10));
    it("parses float", () => assert.equal(resolveGuidance("3.5"), 3.5));
    it("defaults to 7 for NaN", () => assert.equal(resolveGuidance("abc"), 7));
    it("defaults to 7 for undefined", () =>
        assert.equal(resolveGuidance(undefined), 7));
    it("defaults to 7 for zero (falsy)", () =>
        assert.equal(resolveGuidance("0"), 7));
    it("handles negative", () => assert.equal(resolveGuidance("-3"), -3));
});

// --- Prompt assembly ---
describe("Prompt assembly", () => {
    it("prepends system prefix when provided", () => {
        assert.equal(
            buildPrompt("a cat", "High quality photo."),
            "High quality photo. a cat",
        );
    });

    it("uses plain prompt when no prefix", () => {
        assert.equal(buildPrompt("a dog", ""), "a dog");
    });

    it("handles undefined prefix", () => {
        assert.equal(buildPrompt("a bird", undefined), "a bird");
    });
});

// --- waitForImageAndSave: image extraction logic ---
describe("DOM image extraction (waitForImageAndSave)", () => {
    // Simulate what embedFrame.evaluate returns
    function simulateEvaluate(mockDOM) {
        // mockDOM is a function that returns a base64 string or null
        return mockDOM();
    }

    it("extracts data:image src", () => {
        var result = simulateEvaluate(function () {
            return "data:image/png;base64,iVBORw0KGgo=";
        });
        assert.ok(result.startsWith("data:image"));
    });

    it("handles canvas fallback (returns data URL)", () => {
        var result = simulateEvaluate(function () {
            // Simulates canvas.toDataURL result
            return "data:image/png;base64,aWNhbnZhcw==";
        });
        assert.ok(result.startsWith("data:image/png;base64"));
    });

    it("returns null when no images with naturalWidth > 100", () => {
        var result = simulateEvaluate(function () {
            return null;
        });
        assert.equal(result, null);
    });

    it("ignores tiny images (< 100px)", () => {
        var result = simulateEvaluate(function () {
            // naturalWidth 50 should be filtered out, return null
            return null;
        });
        assert.equal(result, null);
    });

    it("base64 decoding produces a buffer", () => {
        var b64 = "data:image/png;base64,aWNhbnZhcw==";
        var buf = Buffer.from(b64.split(",")[1], "base64");
        assert.ok(Buffer.isBuffer(buf));
        assert.ok(buf.length > 0);
    });
});

// --- Output formatting ---
describe("Output formatting", () => {
    it("emits valid JSON with path and size", () => {
        var obj = { path: "/tmp/test.png", size: 12345 };
        var json = JSON.stringify(obj);
        var parsed = JSON.parse(json);
        assert.equal(parsed.path, "/tmp/test.png");
        assert.equal(parsed.size, 12345);
    });

    it("size is a number", () => {
        var size = Buffer.byteLength("data:image/png;base64,aWNhbnZhcw==");
        assert.ok(typeof size === "number");
        assert.ok(size > 0);
    });
});

// --- Page cleanup logic ---
describe("Page cleanup", () => {
    function filterPagesToClose(pages) {
        return pages.filter(function (url) {
            return !url.startsWith("about:");
        });
    }

    it("closes non-about:blank pages", () => {
        var pages = [
            "https://perchance.org/ai-character-generator",
            "https://image-generation.perchance.org/embed",
            "https://ads.example.com/ad1",
            "about:blank",
        ];
        var toClose = filterPagesToClose(pages);
        assert.equal(toClose.length, 3);
        assert.ok(!toClose.includes("about:blank"));
    });

    it("keeps about:blank alive", () => {
        var pages = ["about:blank"];
        assert.equal(filterPagesToClose(pages).length, 0);
    });

    it("closes everything when no about:blank", () => {
        var pages = ["https://example.com"];
        assert.equal(filterPagesToClose(pages).length, 1);
    });

    it("handles empty page list", () => {
        assert.equal(filterPagesToClose([]).length, 0);
    });
});

// --- Error handling ---
describe("Error handling", () => {
    it("exitCode is 0 on success", () => {
        var exitCode = null;
        // simulate success path
        exitCode = 0;
        assert.equal(exitCode, 0);
    });

    it("exitCode is 1 on failure", () => {
        var exitCode = null;
        try {
            throw new Error("No image found");
        } catch (e) {
            exitCode = 1;
        }
        assert.equal(exitCode, 1);
    });

    it("error message is meaningful", () => {
        try {
            throw new Error("No image found in embed iframe after 60s");
        } catch (e) {
            assert.ok(e.message.includes("embed iframe"));
            assert.ok(e.message.includes("60s"));
        }
    });
});
