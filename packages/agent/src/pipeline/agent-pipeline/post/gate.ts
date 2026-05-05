/**
 * Gate for the post-processing extraction loop. Two reject conditions:
 *  1. The exchange is too short (combined user + assistant chars below
 *     MIN_EXTRACTION_LENGTH) — too little signal to extract.
 *  2. MEM-6: the user message is itself an automated status-update echo —
 *     subbrain-ping CLI traffic, free-agent TG digests, freelance-scout
 *     alerts. These get forwarded into chats and previously fed the
 *     hippocampus a steady diet of deploy events / commit hashes / "scout
 *     deployed" facts that polluted shared_memory + layer2_context.
 *     Detected by user-message prefix; the producing tools all tag with a
 *     stable header (subbrain-ping.py:65, freelance scout TG notify path).
 */
import { MIN_EXTRACTION_LENGTH } from "../types";

// MEM-6: prefixes that mark a user message as an automated echo and should
// short-circuit the hippocampus. Match against `userMessage.trimStart()`.
// Keep this list narrow — false positives silently lose extraction; false
// negatives clutter long-term memory.
export const SKIP_USER_PREFIXES = [
  "[from Claude Code CLI]", // subbrain-ping.py status updates
  "🤖 Free agent —", // free-agent TG digest echo (free-agent.ts:notify)
  "[freelance scout]", // scout TG alerts (scheduler/freelance/persist.ts)
];

export function shouldRunHippocampus(combinedLen: number, userMessage?: string): boolean {
  if (combinedLen < MIN_EXTRACTION_LENGTH) return false;
  if (typeof userMessage === "string" && userMessage.length > 0) {
    // NFC-normalize so emoji-bearing prefixes ("🤖 Free agent —") match
    // regardless of decomposed/composed unicode form. trimStart() drops
    // leading whitespace before the prefix check.
    const head = userMessage.normalize("NFC").trimStart();
    for (const pref of SKIP_USER_PREFIXES) {
      if (head.startsWith(pref.normalize("NFC"))) return false;
    }
  }
  return true;
}

export { MIN_EXTRACTION_LENGTH };
