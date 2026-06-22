import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { z } from "zod";

const PERCHANCE_SCRIPT = "/app/modules/perchance-gen/perchance-image.cjs";
const OUTPUT_DIR = "/app/.openclaw/workspace/media";
mkdirSync(OUTPUT_DIR, { recursive: true });

function run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

function createMcpServer() {
    const mcp = new McpServer({
        name: "image-gen-perchance",
        version: "1.0.0",
    });

    mcp.tool(
        "image_gen_perchance",
        "Generate an image using Perchance. Pass the user's prompt verbatim — do NOT modify, enhance, or rephrase.",
        {
            prompt: z.string().describe("Exact user prompt — do not modify"),
            shape: z
                .enum(["square", "landscape", "portrait"])
                .default("square"),
            negativePrompt: z.string().default(""),
            guidance: z.string().default("7"),
        },
        async ({ prompt, shape, negativePrompt, guidance }) => {
            const outputFile = join(OUTPUT_DIR, `img-${Date.now()}.png`);
            try {
                await run(
                    "node",
                    [
                        PERCHANCE_SCRIPT,
                        prompt,
                        outputFile,
                        shape || "square",
                        "",
                        negativePrompt || "",
                        String(guidance || "7"),
                    ],
                    120000,
                );
                if (existsSync(outputFile)) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    path: outputFile,
                                    tier: "perchance",
                                }),
                            },
                        ],
                    };
                }
            } catch (e) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Perchance failed: ${e.message?.slice(0, 200)}`,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: "Perchance generation failed — no output file",
                        }),
                    },
                ],
                isError: true,
            };
        },
    );

    return mcp;
}

const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport();
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        await mcp.close();
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(8083, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "image_gen_ready", port: 8083 }));
});
