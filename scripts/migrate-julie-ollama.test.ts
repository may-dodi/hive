import { describe, expect, it } from "vitest";

import {
  GUARDRAIL,
  GUARDRAIL_HEADING,
  PLACEMENT_ANCHOR,
  insertGuardrail,
  removeGuardrail,
} from "./migrate-julie-ollama.js";

/**
 * Julie's real systemPrompt shape (headings verified against
 * hive_catalyst.agent_definitions 2026-09-18): several H2 sections ending in
 * "## Guardrails".
 */
const PROMPT = [
  "## Role",
  "HR Business Partner for Catalyst 168.",
  "",
  "## Response Behavior",
  "Short and direct.",
  "",
  `${PLACEMENT_ANCHOR}`,
  "- Comp bands are Mike's call.",
].join("\n");

describe("insertGuardrail", () => {
  it("inserts the section immediately before the placement anchor", () => {
    const out = insertGuardrail(PROMPT);
    const headings = out.match(/^## .*$/gm) ?? [];
    expect(headings).toEqual(["## Role", "## Response Behavior", GUARDRAIL_HEADING, PLACEMENT_ANCHOR]);
  });

  it("preserves every pre-existing line", () => {
    const out = insertGuardrail(PROMPT);
    for (const line of PROMPT.split("\n").filter((l) => l.trim() !== "")) {
      expect(out).toContain(line);
    }
  });

  it("appends when the anchor is absent rather than dropping the section", () => {
    const noAnchor = "## Role\nHR Business Partner.";
    const out = insertGuardrail(noAnchor);
    expect(out).toContain(GUARDRAIL_HEADING);
    expect(out.indexOf(GUARDRAIL_HEADING)).toBeGreaterThan(out.indexOf("## Role"));
  });

  it("does not match a heading that merely contains the anchor text", () => {
    // "## Guardrails and Escalation" must not be treated as the anchor's own
    // section boundary in a way that splits it — insertion still lands before it.
    const variant = "## Role\nx\n\n## Guardrails and Escalation\ny";
    const out = insertGuardrail(variant);
    expect(out).toContain("## Guardrails and Escalation\ny");
  });
});

describe("removeGuardrail", () => {
  it("round-trips: insert then remove returns the original prompt", () => {
    expect(removeGuardrail(insertGuardrail(PROMPT))).toBe(PROMPT.trimEnd());
  });

  it("round-trips when the guardrail was appended at the end", () => {
    const noAnchor = "## Role\nHR Business Partner.";
    expect(removeGuardrail(insertGuardrail(noAnchor))).toBe(noAnchor);
  });

  it("is a no-op when the section is absent", () => {
    expect(removeGuardrail(PROMPT)).toBe(PROMPT);
  });

  it("removes only its own section, leaving following sections intact", () => {
    const out = removeGuardrail(insertGuardrail(PROMPT));
    expect(out).toContain(`${PLACEMENT_ANCHOR}\n- Comp bands are Mike's call.`);
    expect(out).not.toContain("Reorg / RIF planning");
  });

  it("survives a reworded GUARDRAIL body (structural, not exact-string, removal)", () => {
    const drifted = insertGuardrail(PROMPT).replace("Policy drafting", "Policy authoring");
    expect(removeGuardrail(drifted)).toBe(PROMPT.trimEnd());
  });
});

describe("idempotency contract", () => {
  it("the heading the migration checks for is the heading it writes", () => {
    // Guards the failure mode where the marker and the body drift apart and
    // the migration re-appends the section on every run.
    expect(GUARDRAIL).toContain(GUARDRAIL_HEADING);
    const occurrences = insertGuardrail(PROMPT).split(GUARDRAIL_HEADING).length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not collide with Ross's existing document-handling boundary", () => {
    expect(GUARDRAIL_HEADING).not.toBe("## Document Handling — Privacy Boundary");
    const rossPrompt = "## What You Do\nx\n\n## Document Handling — Privacy Boundary\ny\n\n## Guardrails\nz";
    const out = insertGuardrail(rossPrompt);
    expect(out).toContain("## Document Handling — Privacy Boundary\ny");
    expect(out).toContain(GUARDRAIL_HEADING);
  });
});
