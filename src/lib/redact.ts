/**
 * Central secret-masking. Applied on the write-path (logger.formatForDb,
 * chat error echo) and kept on the read-path (routes/logs.ts) as
 * defense-in-depth — maskSecrets is idempotent by shape (`***` replacement
 * doesn't match any of the patterns), so double-application is a no-op.
 *
 * Patterns are length-bounded (8..200 / 10..200 / 20..200) with explicit
 * `\b` boundaries to avoid catastrophic backtracking on pathological input.
 * Very long inputs are pre-trimmed to 100 KB for ReDoS safety.
 */

const MAX_INPUT_LEN = 100_000;

// JSON KV: "api_key":"...", "authorization":"Bearer ...", etc.
const SECRET_JSON_RE = /"(api[_-]?key|authorization|token|bearer)"\s*:\s*"[^"]*"/gi;
// Plain KV: api-key=xxx, authorization=Bearer xyz
const SECRET_KV_RE = /\b(api[_-]?key|authorization|token|bearer)=[^\s|,;"]+/gi;
// Standalone "Bearer <token>" outside an attribute (e.g. header dumps).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9_\-\.]{8,200}\b/g;
// OpenAI-style API keys.
const SK_RE = /\bsk-[A-Za-z0-9_-]{10,200}\b/g;
// GitHub personal access tokens.
const GHP_RE = /\bghp_[A-Za-z0-9]{20,200}\b/g;

export function maskSecrets(s: string): string {
  if (!s || s.length === 0) return s;
  const input = s.length > MAX_INPUT_LEN ? s.slice(0, MAX_INPUT_LEN) : s;
  return input
    .replace(SECRET_JSON_RE, (_m, k: string) => `"${k}":"***"`)
    .replace(SECRET_KV_RE, (_m, k: string) => `${k}=***`)
    .replace(BEARER_RE, "Bearer ***")
    .replace(SK_RE, "sk-***")
    .replace(GHP_RE, "ghp_***");
}
