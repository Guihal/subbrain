type Rule = {
  id: string;
  pattern: RegExp;
  message: string;
  appliesTo?: (relPath: string) => boolean;
};

const EMOJI_RE =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/u;

export const RULES: Rule[] = [
  {
    id: "as-any",
    pattern: /\bas\s+any\b/,
    message: "`as any` prohibited — type explicitly or use generic",
  },
  {
    id: "as-unknown-as",
    pattern: /\bas\s+unknown\s+as\s+\w/,
    message: "`as unknown as X` = type-system bypass — refactor source",
  },
  {
    id: "ts-ignore",
    pattern: /@ts-ignore/,
    message:
      "`@ts-ignore` prohibited — fix type. If impossible — `@ts-expect-error TODO(name): reason`",
  },
  {
    id: "ts-nocheck",
    pattern: /@ts-nocheck/,
    message: "`@ts-nocheck` prohibited absolutely",
  },
  {
    id: "ts-expect-error-bare",
    pattern: /@ts-expect-error\s*$/m,
    message: "`@ts-expect-error` without reason — add `TODO(author): reason`",
  },
  {
    id: "non-null-bang",
    pattern: /(?<![=!<>])![\s)]/,
    message: "non-null assertion `x!` prohibited in new code — use type guard or throw",
    appliesTo: (_rel) => false,
  },
  {
    id: "biome-ignore-bare",
    pattern: /\/\/\s*biome-ignore\s+[\w/]+\s*$/m,
    message: "`biome-ignore` without explanation — add `: reason`",
  },
  {
    id: "no-verify",
    pattern: /--no-verify/,
    message: "`--no-verify` prohibited — pre-commit hooks mandatory",
    appliesTo: (rel) => /\.(sh|ts|js)$/.test(rel),
  },
  {
    id: "no-gpg-sign",
    pattern: /--no-gpg-sign/,
    message: "`--no-gpg-sign` prohibited",
    appliesTo: (rel) => /\.(sh|ts|js)$/.test(rel),
  },
  {
    id: "promise-all-fetch",
    pattern: /Promise\.all\(\s*\[[^\]]*fetch/,
    message: "Promise.all with fetch — use Promise.allSettled (see guardrails S2)",
  },
  {
    id: "raw-fetch",
    pattern: /(?<!Json|Stream|http_)\bfetch\s*\(/,
    message: "raw fetch() prohibited — use fetchJson/fetchStream from src/lib/http-client.ts",
    appliesTo: (rel) =>
      rel.startsWith("src/") &&
      !rel.startsWith("src/lib/http-client") &&
      !rel.endsWith(".test.ts") &&
      !rel.endsWith(".spec.ts") &&
      !rel.endsWith(".live.ts"),
  },
  {
    id: "raw-sql-in-routes",
    pattern: /\b(SELECT\s+|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
    message: "SQL in routes/ prohibited — move to src/db/tables/* or services/*",
    appliesTo: (rel) => rel.startsWith("src/routes/"),
  },
  {
    id: "console-in-src",
    pattern: /\bconsole\.(log|debug|info)\s*\(/,
    message: "console.log/debug/info in src/ prohibited — use logger.child(...)",
    appliesTo: (rel) =>
      rel.startsWith("src/") &&
      !rel.endsWith(".test.ts") &&
      !rel.endsWith(".spec.ts") &&
      !rel.endsWith(".live.ts"),
  },
];

export type { Rule };
export { EMOJI_RE };
