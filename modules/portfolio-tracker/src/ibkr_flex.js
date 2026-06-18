/**
 * IBKR Flex Web Service — pull latest flex query XML.
 *
 * The IBKR Flex Web Service is a REST endpoint that returns flex query
 * results. Uses a two-step protocol: first request may return a reference
 * code requiring a second request to fetch the actual data.
 *
 * Env vars:
 *   IBKR_FLEX_TOKEN    — token from Account Management → Reports → Flex Web Service
 *   IBKR_FLEX_QUERY_ID  — flex query ID from Account Management → Reports → Flex Queries
 */

const IBKR_SEND_URL =
    "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
const USER_AGENT = "Node.js/24";

/**
 * Pull the latest IBKR flex query XML.
 * @returns {Promise<{success: boolean, xml?: string, error?: string}>}
 */
export async function pullFlexXml() {
    const token = process.env.IBKR_FLEX_TOKEN;
    const queryId = process.env.IBKR_FLEX_QUERY_ID;

    if (!token || !queryId) {
        console.log(
            JSON.stringify({
                event: "ibkr_flex_skipped",
                reason: "IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID not set",
            }),
        );
        return { success: false, error: "Not configured" };
    }

    try {
        // Step 1: Request the flex statement
        const params = new URLSearchParams({ t: token, q: queryId, v: "3" });
        const resp = await fetch(`${IBKR_SEND_URL}?${params}`, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(30000),
        });

        if (!resp.ok) {
            throw new Error(
                `IBKR Flex Web Service returned HTTP ${resp.status}`,
            );
        }

        const text = await resp.text();

        // Step 2: Fetch the statement using the reference code
        // Response: <FlexStatementResponse><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode><url>...</url></FlexStatementResponse>
        if (text.includes("<ReferenceCode>")) {
            const refMatch = text.match(
                /<ReferenceCode>(.*?)<\/ReferenceCode>/,
            );
            const urlMatch = text.match(/<Url>(.*?)<\/Url>/);
            if (!refMatch) {
                throw new Error(
                    "ReferenceCode found but could not extract value",
                );
            }

            // Use the URL from the response (can be gdcdyn, ndcdyn, etc.)
            const getUrl = urlMatch
                ? urlMatch[1]
                : "https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement";

            const refParams = new URLSearchParams({
                t: token,
                q: refMatch[1],
                v: "3",
            });
            const refResp = await fetch(`${getUrl}?${refParams}`, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(30000),
            });

            if (!refResp.ok) {
                throw new Error(
                    `IBKR Flex reference request failed: HTTP ${refResp.status}`,
                );
            }

            const refText = await refResp.text();
            return { success: true, xml: refText };
        }

        // Step 1 response may contain the data directly (Status=Success with inline data)
        return { success: true, xml: text };
    } catch (e) {
        console.log(
            JSON.stringify({
                event: "ibkr_flex_error",
                error: e.message,
            }),
        );
        return { success: false, error: e.message };
    }
}

// Allow running directly: node src/ibkr_flex.js [output-path]
if (process.argv[1]?.endsWith("ibkr_flex.js")) {
    const { writeFileSync } = await import("fs");
    const result = await pullFlexXml();
    if (result.success) {
        const outPath = process.argv[2] || "/tmp/ibkr-flex.xml";
        writeFileSync(outPath, result.xml);
        console.log(`Written ${result.xml.length} bytes to ${outPath}`);
    } else {
        console.error("Failed:", result.error);
        process.exit(1);
    }
}
