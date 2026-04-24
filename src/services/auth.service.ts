import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-length SHA-256 digest for a string.
 *
 * Kept private to this module so other layers never touch the raw hashing
 * primitives. Used on both sides of a compare so differing input lengths do
 * not leak via the compare call itself.
 */
function hashSync(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time compare of two fixed-length digests. Returns `false` rather
 * than throwing when sizes mismatch so callers can pass this a freshly
 * hashed input without extra guards.
 */
function timingSafeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * AuthService — first slice of the routes → services layer split (PR 25a).
 *
 * Holds the proxy's Bearer token + its precomputed SHA-256 digest. The
 * digest is captured once in the constructor so per-request validation is a
 * single `hashSync` of the incoming bearer plus a constant-time compare —
 * no repeated hashing of the expected token.
 *
 * Routes / middleware must only depend on the public API (`validateBearer`,
 * `getToken`). `createHash` / `timingSafeEqual` never leave this file, which
 * is asserted by a grep on the PR.
 */
export class AuthService {
  private readonly expectedHash: Buffer;

  constructor(private readonly token: string) {
    this.expectedHash = hashSync(token);
  }

  /**
   * Validate an HTTP `Authorization` header value.
   *
   * Accepts the raw header (e.g. `"Bearer abc"` or `null` when missing).
   * Returns `false` for any non-`Bearer` scheme, missing header, or wrong
   * token — never throws, so middleware can branch on a boolean.
   */
  validateBearer(header: string | null): boolean {
    if (!header) return false;
    if (!/^Bearer\s+/i.test(header)) return false;
    const bearer = header.replace(/^Bearer\s+/i, "");
    if (!bearer) return false;
    return timingSafeCompare(this.expectedHash, hashSync(bearer));
  }

  /**
   * Returns the configured token. Used by the `/api/token` endpoint which
   * echoes the current proxy token to the already-authenticated caller.
   */
  getToken(): string {
    return this.token;
  }
}
