#!/usr/bin/env bun
// Pre-flight validator for Kimi K2.6 packets
// Usage: bun run scripts/kimi-preflight.ts <packet-doc> <packet-id>

const [docPath, packetId] = process.argv.slice(2);
if (!docPath || !packetId) {
  console.error("Usage: bun run scripts/kimi-preflight.ts <path-to-packet-doc> <packet-id>");
  process.exit(1);
}

const text = await Bun.file(docPath).text();

// 1) Find JSON block for packet-id
const blocks = text.match(/```json\n([\s\S]*?)\n```/g) ?? [];
let packet: Record<string, unknown> | null = null;
for (const block of blocks) {
  const json = block.slice(7, -3).trim();
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (obj.task_id === packetId) {
      packet = obj;
      break;
    }
  } catch {
    /* skip malformed */
  }
}
if (!packet) {
  console.log("FAIL: preflight: packet not found");
  process.exit(1);
}

const raw = JSON.stringify(packet);

// TBD placeholder check (must run before other checks)
if (/<TBD-[^>]+>|<[^>]+_TBD>/i.test(raw)) {
  console.log("FAIL: preflight: missing_decision_doc: unresolved TBD placeholder found");
  process.exit(1);
}

const checks: { name: string; pass: boolean; reason?: string }[] = [];
const fail = (name: string, reason: string) => checks.push({ name, pass: false, reason });
const ok = (name: string) => checks.push({ name, pass: true });

// 1. Goal is one sentence, imperative, no adjectives
const goal = String(packet.goal ?? "");
const adjPat =
  /\b(improve|clean up|refactor|make better|enhance|optimize|better|nice|good|great|clean|proper|correct|final|best|quick|fast|easy|simple)\b/i;
const hasAdj = adjPat.test(goal);
const sentenceCount = goal.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
const imperative = /^[A-Z][a-z]+\b/.test(goal) && !/^\s*(I|we|it|this|that|there)\b/i.test(goal);
if (!goal || sentenceCount !== 1 || !imperative || hasAdj) {
  fail(
    "goal_one_sentence_imperative_no_adjectives",
    `sentences=${sentenceCount}, imperative=${imperative}, adjectives=${hasAdj ? "yes" : "no"}`,
  );
} else ok("goal_one_sentence_imperative_no_adjectives");

// 2. Paths in allowed_write_paths / read_context are literal (no wildcards)
const paths = [
  ...((packet.allowed_write_paths as string[]) ?? []),
  ...((packet.read_context as string[]) ?? []),
];
const badPath = paths.find((p) => /[*?{}[\]]/.test(p.replace(/\/\*\*$/g, "")));
if (badPath) fail("literal_paths", `wildcard found: ${badPath}`);
else ok("literal_paths");

// 3. Acceptance contains runnable commands with exit codes
const acceptance = (packet.acceptance as string[]) ?? [];
const shellish =
  /\b(bun|bunx|npm|npx|grep|rg|test|wc|docker|git|rm|mkdir|cp|mv|cat|jq|awk|sed|curl|node|python|sh|bash|echo|ls|cd|find|diff|tsc|biome)\b/;
const hasExit = acceptance.every((cmd) => shellish.test(cmd));
if (!acceptance.length || !hasExit)
  fail("acceptance_runnable", "empty or missing runnable commands");
else ok("acceptance_runnable");

// 4. non_goals >= 3 concrete denials
const nonGoals = (packet.non_goals as string[]) ?? [];
const denials = nonGoals.filter((ng) => /^\s*Do not\b/i.test(ng)).length;
if (nonGoals.length < 3 || denials < 3)
  fail("non_goals_3_denials", `items=${nonGoals.length}, denials=${denials}`);
else ok("non_goals_3_denials");

// 5. No if/else / "as needed" / "depending on" in goal or acceptance
// Shell inline code may contain if/else; we only flag fuzzy planning words.
const fuzzyWords =
  /\b(as needed|depending on|where applicable|if applicable|when needed|where needed)\b/i;
const goalFuzzy = /\b(if|else)\b/i.test(goal) || fuzzyWords.test(goal);
const accFuzzy = acceptance.some((a) => fuzzyWords.test(a));
if (goalFuzzy || accFuzzy)
  fail("no_conditionals", goalFuzzy ? "conditional in goal" : "conditional in acceptance");
else ok("no_conditionals");

// 6. diff_budget_loc < 300
const diff = Number(packet.diff_budget_loc ?? Number.POSITIVE_INFINITY);
if (diff >= 300) fail("diff_budget_under_300", `diff_budget_loc=${diff}`);
else ok("diff_budget_under_300");

// 7. Project-specific terms defined in glossary or bound to line range
const glossary = packet.glossary as Record<string, string> | undefined;
const readCtx = (packet.read_context as string[]) ?? [];
const hasLineRange = readCtx.some((p) => /:\d+-\d+$/.test(p));
const hasGlossary = glossary && Object.keys(glossary).length > 0;
if (!hasGlossary && !hasLineRange) fail("terms_defined", "no glossary and no line-range bindings");
else ok("terms_defined");

// 8. escalation_triggers covers "spec contradicts code"
const triggers = (packet.escalation_triggers as string[]) ?? [];
const covers = triggers.some((t) => /spec contradicts? (code|existing)/i.test(t));
if (covers) ok("escalation_spec_contradiction");
else fail("escalation_spec_contradiction", "no trigger for spec-contradicts-code");

// 9. risk_tier explicitly set
const tier = String(packet.risk_tier ?? "");
if (!tier || tier === "undefined") fail("risk_tier_set", "risk_tier missing or empty");
else ok("risk_tier_set");

// 10. Rollback described in one sentence
const rollback = String(packet.rollback ?? "");
const rbSentences = rollback.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
if (!rollback || rbSentences !== 1) fail("rollback_one_sentence", `sentences=${rbSentences}`);
else ok("rollback_one_sentence");

// 11. No TBD / unresolved placeholders (already checked above, but count it)
ok("no_tbd_placeholders");

const failed = checks.filter((c) => !c.pass);
const total = checks.length;
if (failed.length === 0) {
  console.log(`OK ${packetId}: preflight passed (${total}/${total} checks)`);
  process.exit(0);
} else {
  const f = failed[0];
  console.log(`FAIL: preflight: ${f.name}: ${f.reason}`);
  process.exit(1);
}
