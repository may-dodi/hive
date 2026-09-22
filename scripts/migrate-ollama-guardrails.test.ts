import { describe, expect, it } from "vitest";

import { GUARDRAIL_HEADING, PLACEMENT_ANCHOR, insertGuardrail, removeGuardrail } from "./migrate-julie-ollama.js";
import { AGENTS, BODIES, SHARED_RULE } from "./migrate-ollama-guardrails.js";

const PROMPT = ["# Agent", "", "## Role", "", "Do things.", "", PLACEMENT_ANCHOR, "", "- Be careful."].join("\n");

describe("guardrail parity rollout", () => {
  it("covers exactly the seven agents from the 2026-09-16 audit, and not Julie", () => {
    expect(AGENTS).toEqual(["Bill", "Diana", "Lily", "Nora", "Ross", "Stefan", "Warren"]);
    expect(AGENTS).not.toContain("Julie");
  });

  it("keys bodies by title-case name — agent_definitions has no agent_id field", () => {
    for (const name of AGENTS) expect(name[0]).toBe(name[0]?.toUpperCase());
  });

  it.each(AGENTS)("%s's body carries the shared heading and the shared default rule", (name) => {
    const b = BODIES[name] as string;
    expect(b).toContain(GUARDRAIL_HEADING);
    // The shared sentence is what a future prompt-drift audit matches on across
    // all agents. Domain owners narrow the trigger list, never this.
    expect(b).toContain(SHARED_RULE);
  });

  it.each(AGENTS)("%s's body is domain-specific, not a copy of the neighbour's", (name) => {
    const others = AGENTS.filter((a) => a !== name).map((a) => BODIES[a]);
    expect(others).not.toContain(BODIES[name]);
  });

  it.each(AGENTS)("%s inserts before the anchor and round-trips back to the original", (name) => {
    const withGuardrail = insertGuardrail(PROMPT, BODIES[name]);
    expect(withGuardrail.indexOf(GUARDRAIL_HEADING)).toBeLessThan(withGuardrail.indexOf(PLACEMENT_ANCHOR));
    expect(removeGuardrail(withGuardrail).trimEnd()).toBe(PROMPT.trimEnd());
  });

  it.each(AGENTS)("%s's insert is idempotent in effect — re-removing is a no-op", (name) => {
    const once = insertGuardrail(PROMPT, BODIES[name]);
    expect(removeGuardrail(removeGuardrail(once))).toBe(removeGuardrail(once));
  });

  it("leaves Ross's existing document-handling rule untouched", () => {
    const ross = [PROMPT, "", "## Document Handling — Privacy Boundary", "", "Ingest on device."].join("\n");
    const next = insertGuardrail(ross, BODIES.Ross);
    expect(next).toContain("## Document Handling — Privacy Boundary");
    expect(next).toContain("Ingest on device.");
    // Both sections coexist; the remover only takes back the one we added.
    expect(removeGuardrail(next)).toContain("## Document Handling — Privacy Boundary");
    expect(removeGuardrail(next)).not.toContain(GUARDRAIL_HEADING);
  });

  it("appends when the agent has no Guardrails anchor", () => {
    const noAnchor = "# Agent\n\n## Role\n\nDo things.";
    const next = insertGuardrail(noAnchor, BODIES.Diana);
    expect(next.startsWith(noAnchor)).toBe(true);
    expect(next).toContain(GUARDRAIL_HEADING);
  });
});
