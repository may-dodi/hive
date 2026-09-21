#!/usr/bin/env npx tsx
/**
 * One-time migration: grant Julie (HR Business Partner) local-model inference.
 *
 * Approved by Tony 2026-09-16 as part of the ollama-coreServers restoration.
 *
 * Operations (idempotent, safe to re-run):
 *   1. Add "ollama" to Julie's `coreServers` if absent.
 *   2. Insert the model-routing privacy boundary into Julie's `systemPrompt` if
 *      absent (detected by the GUARDRAIL_HEADING constant).
 *
 * Field and heading are per Tony's 2026-09-18 ruling: Julie first, systemPrompt
 * (not soul), fixed section heading. See GUARDRAIL_HEADING for why the heading
 * is a shared constant rather than a per-agent phrasing.
 *
 * Usage:
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst            # dry-run
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst --apply    # commit
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst --rollback --apply
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017)
 *
 * *** RUN ORDER MATTERS — read this before applying. ***
 * Do NOT apply this until an engine build containing the in-process `ollama`
 * server (src/ollama/ollama-mcp-server.ts) is actually deployed. A core server
 * named in config but absent from the running engine resolves to nothing and
 * the agent silently lacks the tools — that is the exact failure that cost the
 * other seven agents their Ollama access for weeks. Config after code, always.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MongoClient } from "mongodb";

const AGENT_NAME = "Julie";
const SERVER = "ollama";

/**
 * Fixed section heading — IDENTICAL for every agent that gets this rule.
 *
 * This is deliberately NOT domain-specific ("Personnel Data", "Client Records",
 * ...). The parity rollout has to add this rule to six more agents, and nothing
 * in the system currently audits systemPrompt/soul drift — `check:core-servers`
 * covers coreServers only. One constant heading means presence is detectable by
 * a single exact-match string across all agents: one idempotency check, one
 * rollback path, and a future guardrail audit is a one-liner instead of a
 * per-agent marker table. Domain specificity lives in the body, where it costs
 * nothing.
 *
 * Distinct from Ross's existing "## Document Handling — Privacy Boundary": that
 * rule routes DOCUMENTS, this one routes INFERENCE. Ross's is left untouched;
 * he will get this section in addition, not instead.
 *
 * If this string is ever changed, every already-migrated agent needs a rewrite
 * migration — treat it as a schema constant, not a wording preference.
 */
export const GUARDRAIL_HEADING = "## Model Routing — Privacy Boundary";

/**
 * Deterministic placement anchor. The section is inserted immediately BEFORE
 * this heading when present, otherwise appended. Julie, Ross and the rest all
 * carry a "## Guardrails" section, so this puts the rule in the same region of
 * every agent's prompt rather than wherever the file happened to end.
 */
export const PLACEMENT_ANCHOR = "## Guardrails";

/**
 * Mirrors the shape of Ross's "Document Handling — Privacy Boundary": two named
 * paths, an explicit sensitive-trigger list, and a closing clause forbidding the
 * quiet easy path. Ross's lives in agent_definitions.systemPrompt, not .soul
 * (verified 2026-09-16 by reading both fields for all eight ollama agents).
 *
 * Scope difference worth knowing: Ross's rule routes DOCUMENTS (on-device
 * rag_ingest vs Google Workspace fetch into cloud context). This one routes
 * INFERENCE (which model answers). Same privacy logic, different mechanism —
 * so it is a shape precedent, not a drop-in template.
 *
 * Parity, verified same audit: of the eight, only Ross has any written privacy
 * routing rule at all, and his says nothing about model choice. Bill, Diana,
 * Lily, Nora, Stefan and Warren have none in either field. Julie's is therefore
 * the first inference-routing rule on the team. Parity for the rest is an open
 * item, tracked separately — not silently fixed here.
 *
 * Deliberately a PRIVACY boundary, not a cost escape hatch — routing HR work
 * to a weaker model by guess is silent quality degradation where it does the
 * most damage.
 */
export const GUARDRAIL = `
${GUARDRAIL_HEADING}

**Local model (privacy-preserving) — use for anything about a named person.**
Use this for: performance reviews, compensation figures, disciplinary records, health or
accommodation matters, hiring decisions about identified candidates, exit conversations,
anything involving a real employee's name attached to an evaluation.

This list is a floor, not a ceiling. Two cases that are NOT yet a formal record but are
covered anyway:
- **Pre-decision matters** — complaints, allegations, and open investigations, from the
  moment a name is attached. Do not wait for a finding or a written record to exist.
  The period before a decision is the most sensitive, not the least.
- **Reorg / RIF planning** — any org-change work that names individuals as candidates for
  role change or exit, well before anything becomes an "exit conversation."

If a question is about a real person and you are unsure whether it qualifies, it qualifies.

**Frontier model (capability) — use only for general, non-personal material.**
Policy drafting, process design, market-rate research, template writing.

**The rule:** If the question names a real person and attaches a judgment to them, it runs
locally. Never route identifiable personnel material to a cloud model because the answer would
be better. If local capability is genuinely insufficient for a personnel question, say so and
ask Mike — do not silently upgrade.
`;

/**
 * Insert the guardrail before PLACEMENT_ANCHOR, or append if the anchor is absent.
 *
 * `section` defaults to Julie's body, so the existing call site and every existing
 * test are unchanged. Guardrail parity needs six more agents carrying DOMAIN-SPECIFIC
 * bodies under the SAME heading — the heading is the schema constant, the body is not.
 * Passing the body in (rather than forking a near-copy of this function into the
 * rollout script) keeps one placement rule and one rollback path, which is the whole
 * reason GUARDRAIL_HEADING is a shared constant in the first place.
 *
 * Throws if `section` does not carry GUARDRAIL_HEADING: a section written under any
 * other heading is invisible to removeGuardrail and therefore cannot be rolled back.
 */
export function insertGuardrail(prompt: string, section: string = GUARDRAIL): string {
  if (!section.includes(GUARDRAIL_HEADING)) {
    throw new Error(
      `guardrail section must contain ${JSON.stringify(GUARDRAIL_HEADING)} — ` +
        `a section under any other heading cannot be rolled back`,
    );
  }
  const body = prompt.trimEnd();
  const at = body.indexOf(`\n${PLACEMENT_ANCHOR}`);
  if (at === -1) return `${body}\n${section}`;
  return `${body.slice(0, at)}\n${section}\n${body.slice(at + 1)}`;
}

/**
 * Remove the guardrail section: from its heading up to the next H2, or to the
 * end. Structural rather than exact-string removal so that a later whitespace
 * or wording edit to GUARDRAIL cannot strand an un-rollback-able section.
 */
export function removeGuardrail(prompt: string): string {
  const at = prompt.indexOf(GUARDRAIL_HEADING);
  if (at === -1) return prompt;
  const rest = prompt.slice(at + GUARDRAIL_HEADING.length);
  const next = rest.search(/\n## /);
  const tail = next === -1 ? "" : rest.slice(next + 1);
  return `${prompt.slice(0, at).trimEnd()}\n\n${tail}`.trimEnd();
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const instance = arg("--instance");
  if (!instance) {
    console.error("Usage: npx tsx scripts/migrate-julie-ollama.ts --instance <id> [--apply] [--rollback]");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const dbName = `hive_${instance}`;

  const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
  await client.connect();
  try {
    const col = client.db(dbName).collection("agent_definitions");
    // NB: agent_definitions has NO `agent_id` field. The key is `name`, title
    // case. Querying {agent_id:"julie"} returns null and looks like "not wired".
    const julie = await col.findOne({ name: AGENT_NAME });
    if (!julie) {
      console.error(`${AGENT_NAME} not found in ${dbName}.agent_definitions — wrong instance?`);
      process.exit(1);
    }

    const core: string[] = Array.isArray(julie.coreServers) ? julie.coreServers : [];
    const prompt: string = typeof julie.systemPrompt === "string" ? julie.systemPrompt : "";
    const soul: string = typeof julie.soul === "string" ? julie.soul : "";
    const hasServer = core.includes(SERVER);
    const hasGuardrail = prompt.includes(GUARDRAIL_HEADING);
    // An earlier revision of this script targeted `soul`. If a stray copy ever
    // landed it there, say so loudly rather than silently writing a second one.
    const strayInSoul = soul.includes(GUARDRAIL_HEADING) || soul.includes("Privacy Boundary");

    console.log(`Target: ${dbName}.agent_definitions / ${AGENT_NAME}`);
    console.log(`  coreServers now   : ${JSON.stringify(core)}`);
    console.log(`  has "${SERVER}"        : ${hasServer}`);
    console.log(`  has guardrail     : ${hasGuardrail} (field: systemPrompt)`);
    console.log(`  systemPrompt len  : ${prompt.length}`);
    console.log(`  anchor present    : ${prompt.includes(PLACEMENT_ANCHOR)} ("${PLACEMENT_ANCHOR}")`);
    if (strayInSoul) {
      console.error(`\n  !! A privacy-boundary section also appears in .soul — resolve by hand.`);
      console.error(`     systemPrompt is the field of record; two copies is a drift bug.`);
      process.exit(1);
    }

    const set: Record<string, unknown> = {};

    if (rollback) {
      if (hasServer) set.coreServers = core.filter((s) => s !== SERVER);
      if (hasGuardrail) set.systemPrompt = removeGuardrail(prompt);
      if (Object.keys(set).length === 0) {
        console.log("\nNothing to roll back — already clean.");
        return;
      }
      console.log(`\nROLLBACK plan: remove "${SERVER}" from coreServers and strip the guardrail.`);
      if (set.systemPrompt) {
        console.log(`  systemPrompt -> ${prompt.length} chars becomes ${(set.systemPrompt as string).length}`);
      }
    } else {
      if (!hasServer) set.coreServers = [...core, SERVER];
      if (!hasGuardrail) set.systemPrompt = insertGuardrail(prompt);
      if (Object.keys(set).length === 0) {
        console.log("\nNo change needed — migration already applied.");
        return;
      }
      console.log(`\nPlan:`);
      if (set.coreServers) console.log(`  coreServers  -> ${JSON.stringify(set.coreServers)}`);
      if (set.systemPrompt) {
        const next = set.systemPrompt as string;
        const where = prompt.includes(PLACEMENT_ANCHOR) ? `before "${PLACEMENT_ANCHOR}"` : "appended at end";
        console.log(`  systemPrompt -> insert ${GUARDRAIL.length} chars ${where}`);
        console.log(`                  ${prompt.length} chars becomes ${next.length}`);
        console.log(`\n  --- section headings after migration ---`);
        for (const h of next.match(/^#{1,4} .*$/gm) ?? []) console.log(`    ${h}`);
      }
    }

    if (!apply) {
      console.log("\nDRY RUN — no write performed. Re-run with --apply to commit.");
      return;
    }

    set.updatedAt = new Date();
    set.updatedBy = "jim/migrate-julie-ollama";
    const res = await col.updateOne({ name: AGENT_NAME }, { $set: set });
    console.log(`\nAPPLIED — matched ${res.matchedCount}, modified ${res.modifiedCount}.`);
    console.log("Restart/redeploy required for the agent to pick up the new core server.");
  } finally {
    await client.close();
  }
}

/**
 * tsx-compatible main detection, same idiom as scripts/flatten-skills.ts —
 * `pathToFileURL` (argv[1] may need percent-encoding) with a realpath fallback
 * for symlinked invocation. Needed here so the exported pure helpers can be
 * unit-tested without the import opening a Mongo connection.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
