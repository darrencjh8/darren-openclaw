import express from "express";
import { execFile } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const SCRIPTS_DIR = "/app/scripts";
const OUTPUT_DIR = "/tmp/images";

const app = express();
app.use(express.json());

mkdirSync(OUTPUT_DIR, { recursive: true });

app.get("/health", (_req, res) => res.json({ status: "ok" }));

/** POST /generate — Tier 1 Perchance → Tier 2 Pollinations */
app.post("/generate", async (req, res) => {
    const {
        prompt,
        shape = "square",
        systemPrefix = "",
        negativePrompt = "",
        guidance = "7",
    } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const outputFile = join(OUTPUT_DIR, `img-${Date.now()}.png`);

    // Tier 1: Perchance
    try {
        await run(
            "bash",
            [
                join(SCRIPTS_DIR, "gen-perchance.sh"),
                prompt,
                outputFile,
                shape,
                systemPrefix,
                negativePrompt,
                String(guidance),
            ],
            120000,
        );
        if (existsSync(outputFile))
            return res.json({ path: outputFile, tier: "perchance" });
    } catch (e) {
        console.log("Perchance failed:", e.message?.slice(0, 100));
    }

    // Tier 2: Pollinations
    try {
        await run(
            "bash",
            [join(SCRIPTS_DIR, "gen-pollinations.sh"), prompt, outputFile],
            120000,
        );
        if (existsSync(outputFile))
            return res.json({ path: outputFile, tier: "pollinations" });
    } catch (e) {
        console.log("Pollinations failed:", e.message?.slice(0, 100));
    }

    res.status(500).json({ error: "All tiers failed" });
});

/** POST /send — Send image to Telegram (wraps send-telegram-photo.sh) */
app.post("/send", async (req, res) => {
    const { path: imagePath, caption = "" } = req.body || {};
    if (!imagePath || !existsSync(imagePath))
        return res.status(400).json({ error: "image not found" });

    try {
        await run(
            "bash",
            [join(SCRIPTS_DIR, "send-telegram-photo.sh"), imagePath, caption],
            30000,
        );
        try {
            unlinkSync(imagePath);
        } catch {}
        res.json({ sent: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

app.listen(8083, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "image_gen_ready", port: 8083 }));
});
