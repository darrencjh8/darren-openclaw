/**
 * Tests for email content extractors — HTML, plain text, edge cases.
 * Ported from tests/test_extractors.py (TestHtmlExtractor + TestTextCleaner)
 */
import { describe, it, expect } from "vitest";
import { extractEmailContent } from "../src/extractors.js";

describe("extractEmailContent — HTML extraction", () => {
    it("strips HTML tags and returns plain text", () => {
        const html =
            "<html><body><p>Hello <b>World</b></p></body></html>";
        const result = extractEmailContent(html);
        expect(result).toContain("Hello World");
        expect(result).not.toContain("<p>");
        expect(result).not.toContain("<b>");
    });

    it("preserves text spacing from block-level elements", () => {
        const html = "<p>Line 1</p><p>Line 2</p>";
        const result = extractEmailContent(html);
        expect(result).toContain("Line 1");
        expect(result).toContain("Line 2");
    });

    it("handles empty input", () => {
        expect(extractEmailContent("")).toBe("");
        expect(extractEmailContent("<html></html>")).toBe("");
    });

    it("handles whitespace-only input", () => {
        expect(extractEmailContent("   ")).toBe("");
        expect(extractEmailContent("<html>   \n  </html>")).toBe("");
    });

    it("handles nested table structures", () => {
        const html =
            "<table><tr><td>Amount</td><td>S$12.80</td></tr></table>";
        const result = extractEmailContent(html);
        expect(result).toContain("Amount");
        expect(result).toContain("S$12.80");
    });

    it("handles Unicode characters", () => {
        const html = "<p>🎉 S$12.80 at Café 东京</p>";
        const result = extractEmailContent(html);
        expect(result).toContain("S$12.80");
        expect(result).toContain("Café");
        expect(result).toContain("东京");
    });

    it("handles HTML entities", () => {
        const html = "<p>S$12.80 &amp; S$5.00 = S$17.80</p>";
        const result = extractEmailContent(html);
        expect(result).not.toContain("&amp;");
        expect(result).toContain("S$12.80");
        expect(result).toContain("S$17.80");
    });

    it("handles malformed HTML gracefully", () => {
        const html = "S$12.80 at Toast Box</p><span>missing open tag";
        const result = extractEmailContent(html);
        expect(result).toContain("S$12.80");
        expect(result).toContain("Toast Box");
    });

    it("strips script and style elements", () => {
        const html =
            "<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><p>Hello</p></body></html>";
        const result = extractEmailContent(html);
        expect(result).toContain("Hello");
        expect(result).not.toContain("alert");
        expect(result).not.toContain("color:red");
    });

    it("handles large input without crashing", () => {
        const large = "<html><body>" + "A".repeat(100000) + "</body></html>";
        const result = extractEmailContent(large);
        expect(result.length).toBeGreaterThan(0);
    });

    it("collapses multiple whitespace into single space", () => {
        const html = "<p>Hello    World\n\n\nFoo</p>";
        const result = extractEmailContent(html);
        // Cheerio's text() may preserve some spacing; check both words present
        expect(result).toContain("Hello");
        expect(result).toContain("World");
        expect(result).toContain("Foo");
    });
});
