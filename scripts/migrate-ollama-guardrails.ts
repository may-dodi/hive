/**
 * Guardrail parity rollout — adds the "Model Routing — Privacy Boundary" section
 * to the seven ollama agents that do not have one.
 *
 * Usage:
 *   npx tsx scripts/migrate-ollama-guardrails.ts --instance catalyst                  # dry-run, all
 *   npx tsx scripts/migrate-ollama-guardrails.ts --instance catalyst --agent Diana    # dry-run, one
 *   npx tsx scripts/migrate-ollama-guardrails.ts --instance catalyst --apply
 *   npx tsx scripts/migrate-ollama-guardrails.ts --instance catalyst --rollback --apply
 *
 * WHY A SEPARATE SCRIPT, NOT A FLAG ON migrate-julie-ollama.ts:
 * Julie's migration also adds "ollama" to coreServers — she is a net-new ollama
 * agent. These seven are ALREADY wired for ollama; they need the deploy, not a
 * config change. This script therefore touches `systemPrompt` ONLY and never
 * writes coreServers. Keeping that asymmetry in one script would mean a flag
 * that silently changes which fields get written, which is how you end up
 * applying half a migration to the wrong agent.
 *
 * The placement/insert/remove logic is IMPORTED, not re-implemented. One heading
 * constant, one placement rule, one rollback path across every migrated agent —
 * that is the entire reason GUARDRAIL_HEADING is exported. A near-copy here would
 * fork the rollback path and strand sections the remover cannot see.
 *
 * SCOPE — seven agents, from the 2026-09-16 live audit (both `soul` AND
 * `systemPrompt` read for all eight ollama agents):
 *   Bill, Diana, Lily, Nora, Stefan, Warren — no privacy routing rule in either field.
 *   Ross — HAS "## Document Handling — Privacy Boundary", which routes DOCUMENTS and
 *     says nothing about model choice. He gets Model Routing IN ADDITION. His existing
 *     section is never read, moved, or removed by this script.
 *   Julie is NOT here — she is handled by migrate-julie-ollama.ts.
 */
import { MongoClient } from "mongodb";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GUARDRAIL_HEADING, PLACEMENT_ANCHOR, insertGuardrail, removeGuardrail } from "./migrate-julie-ollama.js";

const SERVER = "ollama";

/**
 * The shared default, identical in every body below:
 *   local for anything naming a real identifiable person, frontier for general work.
 *
 * Domain owners are free to NARROW it — to add triggers specific to their material —
 * but not to widen it. Each body states the shared rule in the same words and then
 * lists its own triggers, so a future prompt-drift audit can match on the shared
 * sentence across all eight agents.
 *
 * Every body is a PRIVACY boundary, not a cost escape hatch. Routing sensitive work
 * to a weaker model to save money is silent quality degradation exactly where it does
 * the most damage.
 */
const SHARED_RULE =
  "**The rule:** anything naming a real, identifiable person runs on the local model. " +
  "General work that names no one runs on the frontier model. If a question is about a real " +
  "person and you are unsure whether it qualifies, it qualifies. If local capability is " +
  "genuinely insufficient, say so and ask Mike — do not silently upgrade.";

function body(local: string, frontier: string): string {
  return `
${GUARDRAIL_HEADING}

**Local model (privacy-preserving) — use for anything about a named person.**
${local}

This list is a floor, not a ceiling. It covers matters that are not yet a formal record:
the moment a real name is attached to the material, the local rule applies. The period
before anything is written down is the most sensitive, not the least.

**Frontier model (capability) — use only for general, non-personal material.**
${frontier}

${SHARED_RULE}
`;
}

/**
 * Keyed by TITLE-CASE `name`. agent_definitions has NO `agent_id` field —
 * querying {agent_id:"diana"} returns null and looks like "not wired".
 */
const BODIES: Record<string, string> = {
  Bill: body(
    "Coaching notes about Mike or any named person, health and training metrics tied to a name, " +
      "weight and body-composition figures, accountability check-ins, anything about someone's " +
      "personal goals, setbacks, or habits.",
    "General training methodology, exercise science, habit-formation research, programming templates.",
  ),
  Diana: body(
    "Named client engagements and their financials, CFO Ninjas client books, revenue and margin " +
      "figures attached to an identified company or person, compensation, anything about a client's " +
      "financial position or distress.",
    "General finance methodology, accounting standards, market benchmarks, template and process design.",
  ),
  Lily: body(
    "Anyone's diet, weight, body-composition or blood-work figures, food logs tied to a name, " +
      "personal health conditions, medication or supplement use by a named person.",
    "General nutrition science, TCM theory, recipe and food-therapy research, meal-plan templates.",
  ),
  Nora: body(
    "All health records, medication lists, lab results, diagnoses, symptoms, appointments and " +
      "provider correspondence for any named person. This is the whole of your primary material — " +
      "assume local unless the question names no one.",
    "General medical and wellness research with no patient identifier attached, drug-interaction " +
      "reference lookups stated generically.",
  ),
  Ross: body(
    "Contracts and their parties, matters involving a named client or counterparty, dispute and " +
      "exposure analysis, anything about an identified person's legal position, privileged material.",
    "General legal research, statute and case-law reading, argument structure, clause-library drafting.",
  ),
  Stefan: body(
    "Models and forecasts tied to a named company or person, compensation figures, cap-table and " +
      "ownership detail, any financial projection attached to an identified party.",
    "General modeling technique, public market data, methodology and template design.",
  ),
  Warren: body(
    "Mike's accounts, balances, bills, transactions, account numbers, and any personal financial " +
      "detail. This is the whole of your primary material — assume local unless the question names no one.",
    "General personal-finance research, product and rate comparison, budgeting methodology.",
  ),
};

const AGENTS = Object.keys(BODIES);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const instance = arg("--instance");
  if (!instance) {
    console.error(
      "Usage: npx tsx scripts/migrate-ollama-guardrails.ts --instance <id> [--agent <Name>] [--apply] [--rollback]",
    );
    process.exit(1);
  }
  const only = arg("--agent");
  if (only !== undefined && !AGENTS.includes(only)) {
    console.error(`Unknown agent ${JSON.stringify(only)} — expected one of: ${AGENTS.join(", ")}`);
    console.error("Names are TITLE CASE and must match agent_definitions.name exactly.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const targets = only ? [only] : AGENTS;
  const dbName = `hive_${instance}`;

  const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
  await client.connect();
  try {
    const col = client.db(dbName).collection("agent_definitions");
    console.log(`Target: ${dbName}.agent_definitions — ${targets.length} agent(s)\n`);

    let planned = 0;
    let skipped = 0;

    for (const name of targets) {
      const doc = await col.findOne({ name });
      if (!doc) {
        console.error(`${name}: NOT FOUND in ${dbName}.agent_definitions — wrong instance?`);
        process.exit(1);
      }

      const core: string[] = Array.isArray(doc.coreServers) ? doc.coreServers : [];
      const prompt: string = typeof doc.systemPrompt === "string" ? doc.systemPrompt : "";
      const soul: string = typeof doc.soul === "string" ? doc.soul : "";
      const has = prompt.includes(GUARDRAIL_HEADING);

      // A guardrail in `soul` is drift: systemPrompt is the field of record, and two
      // copies means removeGuardrail only ever strips one of them.
      if (soul.includes(GUARDRAIL_HEADING)) {
        console.error(`${name}: !! "${GUARDRAIL_HEADING}" also present in .soul — resolve by hand.`);
        console.error(`     systemPrompt is the field of record; two copies is a drift bug.`);
        process.exit(1);
      }

      // Writing "route personnel work to the local model" into an agent that has no
      // ollama server is the exact configured-but-absent bug this project exists to
      // fix — an instruction to use a tool the agent does not have. Skip loudly.
      if (!rollback && !core.includes(SERVER)) {
        console.error(
          `${name}: SKIPPED — no "${SERVER}" in coreServers ${JSON.stringify(core)}. ` +
            `The rule would point at a tool this agent does not have.`,
        );
        skipped++;
        continue;
      }

      const next = rollback
        ? has
          ? removeGuardrail(prompt)
          : null
        : has
          ? null
          : insertGuardrail(prompt, BODIES[name]);

      if (next === null) {
        console.log(`${name}: no change — guardrail ${rollback ? "already absent" : "already present"}.`);
        skipped++;
        continue;
      }

      const where = prompt.includes(PLACEMENT_ANCHOR) ? `before "${PLACEMENT_ANCHOR}"` : "appended at end";
      console.log(`${name}: ${rollback ? "REMOVE" : `insert ${where}`}`);
      console.log(`  systemPrompt ${prompt.length} -> ${next.length} chars`);
      console.log(`  headings after:`);
      for (const h of next.match(/^#{1,4} .*$/gm) ?? []) console.log(`    ${h}`);
      planned++;

      if (apply) {
        const res = await col.updateOne(
          { name },
          {
            $set: {
              systemPrompt: next,
              updatedAt: new Date(),
              updatedBy: "jim/migrate-ollama-guardrails",
            },
          },
        );
        console.log(`  APPLIED — matched ${res.matchedCount}, modified ${res.modifiedCount}.`);
      }
      console.log("");
    }

    console.log(`\n${planned} agent(s) to change, ${skipped} unchanged.`);
    if (!apply) console.log("DRY RUN — no write performed. Re-run with --apply to commit.");
    else if (planned > 0) console.log("Restart/redeploy required for agents to pick up the new prompt.");
  } finally {
    await client.close();
  }
}

/** tsx-compatible main detection — same idiom as migrate-julie-ollama.ts, so the
 * module can be imported by tests without opening a Mongo connection. */
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

export { AGENTS, BODIES, SHARED_RULE };

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
