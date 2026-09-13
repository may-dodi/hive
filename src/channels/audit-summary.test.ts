import { describe, it, expect } from "vitest";
import { buildAuditSummary, AUDIT_SUMMARY_CHARS } from "./dispatcher.js";

describe("buildAuditSummary", () => {
  it("returns short text unchanged and adds no marker", () => {
    const text = "Done — pushed to main, ready to deploy.";
    expect(buildAuditSummary(text)).toBe(text);
    expect(buildAuditSummary(text)).not.toContain("audit summary truncated");
  });

  it("returns text exactly at the limit unchanged", () => {
    const text = "x".repeat(AUDIT_SUMMARY_CHARS);
    expect(buildAuditSummary(text)).toBe(text);
  });

  it("marks truncation explicitly instead of a bare ellipsis", () => {
    const text = "word ".repeat(200);
    const out = buildAuditSummary(text);
    expect(out).toContain("audit summary truncated");
    expect(out).toContain("conversation_search");
    // The old behaviour — a bare "..." with no explanation — is what made the
    // loss silent. Guard against a regression to it.
    expect(out.endsWith("...")).toBe(false);
  });

  it("reports the omitted character count accurately", () => {
    const text = "word ".repeat(200); // 1000 chars
    const out = buildAuditSummary(text);
    const body = out.slice(0, out.indexOf(" […]"));
    const omitted = text.length - body.length;
    expect(out).toContain(`${omitted.toLocaleString()} more characters`);
    expect(omitted).toBeGreaterThan(0);
  });

  it("never cuts mid-word", () => {
    const text = "supercalifragilistic ".repeat(40);
    const out = buildAuditSummary(text);
    const body = out.slice(0, out.indexOf(" […]"));
    // Every whitespace-separated token in the body must be a complete word.
    for (const token of body.split(/\s+/).filter(Boolean)) {
      expect(token).toBe("supercalifragilistic");
    }
  });

  it("does not sever an inline code span — the Sep 13 failure", () => {
    // Reproduces the real incident: the cut landed inside `ollama_query`,
    // leaving an unbalanced backtick in the stored Slack message.
    const text = `${"filler ".repeat(41)}Ollama MCP integration (\`ollama_query\`) is still open and needs a decision.`;
    const out = buildAuditSummary(text);
    const body = out.slice(0, out.indexOf(" […]"));
    // Backticks in the emitted body must be balanced.
    expect((body.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it("falls back to a hard cut when the text has no usable whitespace", () => {
    const text = "a".repeat(500);
    const out = buildAuditSummary(text);
    const body = out.slice(0, out.indexOf(" […]"));
    expect(body.length).toBe(AUDIT_SUMMARY_CHARS);
    expect(out).toContain("more characters");
  });

  it("honours a custom limit", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const out = buildAuditSummary(text, 10);
    const body = out.slice(0, out.indexOf(" […]"));
    expect(body.length).toBeLessThanOrEqual(10);
    expect(out).toContain("audit summary truncated");
  });

  it("keeps the body within the limit in all cases", () => {
    for (const text of ["word ".repeat(300), "a".repeat(400), "x y ".repeat(150)]) {
      const out = buildAuditSummary(text);
      const body = out.slice(0, out.indexOf(" […]"));
      expect(body.length).toBeLessThanOrEqual(AUDIT_SUMMARY_CHARS);
    }
  });
});
