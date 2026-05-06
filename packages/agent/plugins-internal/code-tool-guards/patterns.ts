/**
 * F-2 hardcoded-fact + sandbox patterns.
 *
 * Do NOT change regexes or thresholds — they are security-critical.
 * See docs/tasks/code-tools-poisoning-fix.md.
 */

export interface FactPattern {
  re: RegExp;
  label: string;
}

export const SANDBOX_FORBIDDEN: Array<{ re: RegExp; hint: string }> = [
  {
    re: /\brequire\s*\(/,
    hint: "require() blocked in sandbox; use fetch() to /v1/* HTTP endpoints",
  },
  {
    re: /^\s*import\s+(?!type\b)/m,
    hint: "static `import` (any form) breaks in sandbox Function-context; use fetch()-based pattern",
  },
  {
    re: /\bfrom\s+["']node:/,
    hint: "node:* imports unavailable in sandbox; use fetch() to internal /v1/* endpoints",
  },
  {
    re: /\bimport\s*\(\s*["']node:/,
    hint: "node:* imports unavailable in sandbox; dynamic import() is also blocked at runtime",
  },
  {
    re: /\bfrom\s+["']child_process["']/,
    hint: "child_process unavailable; no shell access in sandbox",
  },
];

export const HARDCODED_FACT_PATTERNS: FactPattern[] = [
  {
    re: /(?:Артём|Артем|Александр|Дмитрий|Полина|Jorge|Aleksandra|Игорь|Михаил|Анна|Sanёchek)/iu,
    label: "person-name",
  },
  {
    re: /(?:^|[^\w])chat_?[iI]d\s*[:=]\s*['"]?-?\d{6,}/m,
    label: "tg-chat-id-literal",
  },
  {
    re: /overdue_hours?\s*:\s*\d+/i,
    label: "overdue-hours-literal",
  },
  {
    re: /(?:lastAction|lastContact|deadline|prepayment_date)\s*:\s*['"][^'"]*\d{2}\.\d{2}/i,
    label: "ddmm-date-literal",
  },
  {
    re: /(?:urgency|status|priority)\s*:\s*["'][🔴🟡🔵⚪🟢]/u,
    label: "urgency-emoji-literal",
  },
];

export type FactSeverity = "ok" | "warn" | "reject";
export interface FactCheckResult {
  matched: string[];
  severity: FactSeverity;
}

export function checkHardcodedFacts(code: string): FactCheckResult {
  const matched = HARDCODED_FACT_PATTERNS.filter((p) => p.re.test(code)).map((p) => p.label);
  if (matched.length === 0) return { matched: [], severity: "ok" };
  if (matched.length === 1) return { matched, severity: "warn" };
  return { matched, severity: "reject" };
}

export interface GuardLog {
  warn(stage: string, message: string, extra?: unknown): void;
}

export type GuardError = { success: false; error: string };

/**
 * Combined sandbox + hardcoded-facts gate. Returns null on pass; on warn
 * still passes (logs only).
 */
export function applyCodeToolGuards(code: string, name: string, log: GuardLog): GuardError | null {
  for (const { re, hint } of SANDBOX_FORBIDDEN) {
    if (re.test(code)) {
      return { success: false, error: `sandbox_violation: ${hint}` };
    }
  }
  const facts = checkHardcodedFacts(code);
  if (facts.severity === "reject") {
    return {
      success: false,
      error: `hardcoded_facts: tool body contains [${facts.matched.join(", ")}]; pass dynamic data via input or query memory/tg_read_chat at runtime — do not embed как const'ы`,
    };
  }
  if (facts.severity === "warn") {
    log.warn("agent-loop", `code-tool ${name}: hardcoded-fact warn`, {
      meta: { matched: facts.matched },
    });
  }
  return null;
}
