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

/**
 * Guardrail parity (Bill, Diana, Lily, Nora, Stefan, Warren, + Ross additively)
 * reuses these helpers with a per-agent body under the SAME heading. These tests
 * pin the contract the rollout script depends on.
 */
describe("per-agent guardrail bodies", () => {
  const DIANA = `\n${GUARDRAIL_HEADING}\n\nRun locally for anything naming a real client or their figures.\n`;

  it("writes the supplied body, not Julie's, and places it identically", () => {
    const out = insertGuardrail(PROMPT, DIANA);
    expect(out).toContain("naming a real client");
    expect(out).not.toContain("performance reviews");
    // Same deterministic placement rule as the default body.
    expect(out.indexOf(GUARDRAIL_HEADING)).toBeLessThan(out.indexOf(PLACEMENT_ANCHOR));
  });

  it("rolls back a per-agent body with the unchanged, body-independent remover", () => {
    expect(removeGuardrail(insertGuardrail(PROMPT, DIANA))).toBe(PROMPT.trimEnd());
  });

  it("stays idempotent per agent: one heading, one section", () => {
    expect(insertGuardrail(PROMPT, DIANA).split(GUARDRAIL_HEADING).length - 1).toBe(1);
  });

  it("rejects a body under a different heading rather than writing an unremovable section", () => {
    // Without this guard the section lands but removeGuardrail cannot find it,
    // stranding text in a live agent prompt with no rollback path.
    expect(() => insertGuardrail(PROMPT, "\n## Model Routing\n\nbody\n")).toThrow(/cannot be rolled back/);
  });

  it("defaults to Julie's body when no body is passed (existing call site unchanged)", () => {
    expect(insertGuardrail(PROMPT)).toBe(insertGuardrail(PROMPT, GUARDRAIL));
  });
});
