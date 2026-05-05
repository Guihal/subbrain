import type { Database } from "bun:sqlite";
import type { SchedulerStateRow } from "../types";

/**
 * Ephemeral runtime flags (poller locks, last-checked timestamps, heartbeats).
 * Not for long-lived facts — those live in shared/context/archive memory.
 *
 * Phase 4 will use tryAcquireLock() for the TG poller CAS scheme. The method
 * is shipped now as a foundation; not called from anywhere in Phase 1.
 */
export class SchedulerStateTable {
  constructor(public readonly db: Database) {}

  get(key: string): SchedulerStateRow | null {
    return (
      (this.db
        .query(`SELECT * FROM scheduler_state WHERE key = ?`)
        .get(key) as SchedulerStateRow | null) ?? null
    );
  }

  upsert(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO scheduler_state (key, value, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  delete(key: string): boolean {
    return this.db.query(`DELETE FROM scheduler_state WHERE key = ?`).run(key).changes > 0;
  }

  /**
   * Single-statement CAS lock acquire.
   *
   * Claim if: (a) we already hold it (myId match — heartbeat), OR
   *           (b) it's stale (updated_at older than now - staleSec).
   * Returns true iff the lock is now held by `myId`.
   *
   * The INSERT OR IGNORE ensures the row exists before the UPDATE with
   * RETURNING — otherwise a fresh DB would never claim.
   */
  tryAcquireLock(key: string, myId: string, staleSec: number): boolean {
    this.db
      .query(
        `INSERT OR IGNORE INTO scheduler_state (key, value, updated_at)
         VALUES (?, '', 0)`,
      )
      .run(key);
    const res = this.db
      .query(
        `UPDATE scheduler_state
         SET value = ?, updated_at = unixepoch()
         WHERE key = ?
           AND (value = ? OR updated_at < unixepoch() - ?)
         RETURNING value`,
      )
      .get(myId, key, myId, staleSec) as { value: string } | null;
    return res?.value === myId;
  }

  /** Heartbeat: refresh updated_at iff we still own the lock. */
  heartbeat(key: string, myId: string): boolean {
    return (
      this.db
        .query(
          `UPDATE scheduler_state SET updated_at = unixepoch()
           WHERE key = ? AND value = ?`,
        )
        .run(key, myId).changes > 0
    );
  }
}
