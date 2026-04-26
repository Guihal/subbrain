import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const EMBEDDING_DIM = 2048;

export function openDatabase(path: string): Database {
  const db = new Database(path);

  // Performance pragmas
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    -------------------------------------------------------------------
    -- Layer 1: Focus (system prompt, identity, directives)
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS layer1_focus (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -------------------------------------------------------------------
    -- Layer 2: Context (active projects, current tasks)
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS layer2_context (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      tags         TEXT NOT NULL DEFAULT '',
      derived_from TEXT NOT NULL DEFAULT '[]',
      agent_id     TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -------------------------------------------------------------------
    -- Layer 3: Archive (compressed knowledge, EN)
    -------------------------------------------------------------------
    -- M-12 (mig 15): confidence is REAL [0..1]; legacy 'HIGH'/'LOW' rows
    -- backfilled to 0.9 / 0.4 on existing DBs. Fresh DBs land on REAL
    -- directly. Mig 10 / 13 add last_accessed_at / access_count / salience /
    -- last_decayed_at; ALTERs handle existing DBs, this CREATE seeds fresh.
    CREATE TABLE IF NOT EXISTS layer3_archive (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      content            TEXT NOT NULL,
      tags               TEXT NOT NULL DEFAULT '',
      source_request_ids TEXT NOT NULL DEFAULT '[]',
      confidence         REAL DEFAULT NULL,
      agent_id           TEXT,
      created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -------------------------------------------------------------------
    -- Layer 4: Raw log (append-only)
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS layer4_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content     TEXT NOT NULL,
      token_count INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_log_request  ON layer4_log(request_id);
    CREATE INDEX IF NOT EXISTS idx_log_session  ON layer4_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_log_agent    ON layer4_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_log_created  ON layer4_log(created_at);

    -------------------------------------------------------------------
    -- Shared memory (facts about user, family, global goals)
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS shared_memory (
      id         TEXT PRIMARY KEY,
      category   TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '',
      source     TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -------------------------------------------------------------------
    -- Agent-private memory (per-role experience)
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS agent_memory (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_agent_mem ON agent_memory(agent_id);

    -------------------------------------------------------------------
    -- Code Tools: self-written executable tools by the agent
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS code_tools (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      code        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      run_count   INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_error  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -------------------------------------------------------------------
    -- FTS5: Full-text search on Layer 2 (context)
    -------------------------------------------------------------------
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_context USING fts5(
      title, content, tags,
      content=layer2_context,
      content_rowid=rowid
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS fts_context_ai AFTER INSERT ON layer2_context BEGIN
      INSERT INTO fts_context(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_context_ad AFTER DELETE ON layer2_context BEGIN
      INSERT INTO fts_context(fts_context, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_context_au AFTER UPDATE ON layer2_context BEGIN
      INSERT INTO fts_context(fts_context, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO fts_context(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    -------------------------------------------------------------------
    -- FTS5: Full-text search on Layer 3 (archive)
    -------------------------------------------------------------------
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_archive USING fts5(
      title, content, tags,
      content=layer3_archive,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS fts_archive_ai AFTER INSERT ON layer3_archive BEGIN
      INSERT INTO fts_archive(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_archive_ad AFTER DELETE ON layer3_archive BEGIN
      INSERT INTO fts_archive(fts_archive, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_archive_au AFTER UPDATE ON layer3_archive BEGIN
      INSERT INTO fts_archive(fts_archive, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO fts_archive(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    -------------------------------------------------------------------
    -- FTS5: Full-text search on shared memory
    -------------------------------------------------------------------
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_shared USING fts5(
      category, content, tags,
      content=shared_memory,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS fts_shared_ai AFTER INSERT ON shared_memory BEGIN
      INSERT INTO fts_shared(rowid, category, content, tags)
      VALUES (new.rowid, new.category, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_shared_ad AFTER DELETE ON shared_memory BEGIN
      INSERT INTO fts_shared(fts_shared, rowid, category, content, tags)
      VALUES ('delete', old.rowid, old.category, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS fts_shared_au AFTER UPDATE ON shared_memory BEGIN
      INSERT INTO fts_shared(fts_shared, rowid, category, content, tags)
      VALUES ('delete', old.rowid, old.category, old.content, old.tags);
      INSERT INTO fts_shared(rowid, category, content, tags)
      VALUES (new.rowid, new.category, new.content, new.tags);
    END;
  `);

  // sqlite-vec: embeddings table (separate exec — virtual table)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      id       TEXT PRIMARY KEY,
      layer    TEXT NOT NULL,
      embedding FLOAT[${EMBEDDING_DIM}]
    );
  `);

  // Metrics log for nightly analysis
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      snapshot  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_log(timestamp);
  `);

  // Chat sessions & messages (persisted conversations)
  db.exec(`
    -------------------------------------------------------------------
    -- Chats: each conversation session
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'Новый чат',
      model      TEXT NOT NULL DEFAULT 'teamlead',
      source     TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'api', 'autonomous', 'continue', 'telegram')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_source  ON chats(source);

    -------------------------------------------------------------------
    -- Chat messages
    -------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content    TEXT NOT NULL,
      reasoning  TEXT,
      model      TEXT,
      request_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_chatmsg_chat ON chat_messages(chat_id, id);
  `);

  // ─── Migrations ─────────────────────────────────────────
  // Add 'telegram' to chats.source CHECK constraint (SQLite requires table rebuild)
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats_new (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT 'Новый чат',
        model      TEXT NOT NULL DEFAULT 'teamlead',
        source     TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'api', 'autonomous', 'continue', 'telegram')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT OR IGNORE INTO chats_new SELECT * FROM chats;
      DROP TABLE chats;
      ALTER TABLE chats_new RENAME TO chats;
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_source  ON chats(source);
      PRAGMA user_version = 1;
    `);
  }

  // Migration 2: Telegram chat exclusions table
  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tg_excluded_chats (
        chat_id    TEXT PRIMARY KEY,
        chat_title TEXT NOT NULL DEFAULT '',
        reason     TEXT NOT NULL DEFAULT 'private',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      PRAGMA user_version = 2;
    `);
  }

  // Migration 3: Add 'reasoning' role to layer4_log CHECK constraint.
  // Wrapped in a transaction — a crash mid-DROP/RENAME would otherwise leave
  // both layer4_log and layer4_log_new present. Uses .run() per statement
  // (not .exec()) so that a failure at any step throws and rolls back the tx;
  // bun:sqlite's multi-statement .exec() silently skips failing statements.
  if (version < 3) {
    const mig3Stmts = [
      `CREATE TABLE IF NOT EXISTS layer4_log_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool', 'reasoning')),
        content     TEXT NOT NULL,
        token_count INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `INSERT INTO layer4_log_new SELECT * FROM layer4_log`,
      `DROP TABLE layer4_log`,
      `ALTER TABLE layer4_log_new RENAME TO layer4_log`,
      `CREATE INDEX IF NOT EXISTS idx_log_request ON layer4_log(request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_session ON layer4_log(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_agent   ON layer4_log(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_created ON layer4_log(created_at)`,
      `PRAGMA user_version = 3`,
    ];
    db.transaction(() => {
      for (const sql of mig3Stmts) db.query(sql).run();
    })();
  }

  // Migration 4: tg_messages + FTS5 mirror (Telegram search index).
  if (version < 4) {
    const mig4Stmts = [
      `CREATE TABLE IF NOT EXISTS tg_messages (
        message_id  INTEGER NOT NULL,
        chat_id     TEXT NOT NULL,
        chat_name   TEXT NOT NULL DEFAULT '',
        from_name   TEXT NOT NULL DEFAULT '',
        ts          INTEGER NOT NULL,
        text        TEXT NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (chat_id, message_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tgmsg_ts ON tg_messages(ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_tgmsg_chat ON tg_messages(chat_id, ts DESC)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS fts_tg_messages USING fts5(
        text, chat_name, from_name,
        content=tg_messages,
        content_rowid=rowid
      )`,
      `CREATE TRIGGER IF NOT EXISTS fts_tgmsg_ai AFTER INSERT ON tg_messages BEGIN
        INSERT INTO fts_tg_messages(rowid, text, chat_name, from_name)
        VALUES (new.rowid, new.text, new.chat_name, new.from_name);
      END`,
      `CREATE TRIGGER IF NOT EXISTS fts_tgmsg_ad AFTER DELETE ON tg_messages BEGIN
        INSERT INTO fts_tg_messages(fts_tg_messages, rowid, text, chat_name, from_name)
        VALUES ('delete', old.rowid, old.text, old.chat_name, old.from_name);
      END`,
      `PRAGMA user_version = 4`,
    ];
    db.transaction(() => {
      for (const sql of mig4Stmts) db.query(sql).run();
    })();
  }

  // Migration 5: chats.kind + freelance_leads table (freelance scout).
  if (version < 5) {
    const mig5Stmts = [
      `ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'main'`,
      `CREATE INDEX IF NOT EXISTS idx_chats_kind ON chats(kind)`,
      `CREATE TABLE IF NOT EXISTS freelance_leads (
        id         TEXT PRIMARY KEY,
        url        TEXT NOT NULL UNIQUE,
        source     TEXT NOT NULL,
        title      TEXT NOT NULL,
        budget     INTEGER,
        score      INTEGER,
        reason     TEXT,
        status     TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','taken','rejected')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX IF NOT EXISTS idx_fl_status ON freelance_leads(status)`,
      `CREATE INDEX IF NOT EXISTS idx_fl_created ON freelance_leads(created_at DESC)`,
      `PRAGMA user_version = 5`,
    ];
    db.transaction(() => {
      for (const sql of mig5Stmts) db.query(sql).run();
    })();
  }

  // Migration 6: tasks lifecycle store + scheduler_state (runtime flags).
  // Separates mutable task state from immutable memory facts.
  if (version < 6) {
    const mig6Stmts = [
      `CREATE TABLE IF NOT EXISTS tasks (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        scope        TEXT NOT NULL
                     CHECK(scope IN ('global','autonomous','free-agent','freelance','tg')),
        status       TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open','in_progress','done','cancelled')),
        priority     INTEGER NOT NULL DEFAULT 0,
        due_at       INTEGER,
        source       TEXT UNIQUE,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        CHECK (
          (status IN ('done','cancelled') AND completed_at IS NOT NULL)
          OR (status IN ('open','in_progress') AND completed_at IS NULL)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_active
        ON tasks(scope, status, priority DESC, due_at, id)
        WHERE status IN ('open','in_progress')`,
      `CREATE TABLE IF NOT EXISTS scheduler_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `PRAGMA user_version = 6`,
    ];
    db.transaction(() => {
      for (const sql of mig6Stmts) db.query(sql).run();
    })();
  }

  // Migration 7 (OBS-1): expand layer4_log role CHECK to include logger levels
  // (_log_debug/_log_info/_log_warn/_log_error) and telegram channel_message.
  // Before this, logger writes silently failed CHECK and were swallowed by the
  // logger's catch, so Layer 4 missed 100% of logger traffic + TG monitor rows.
  // Note: channel_message is semantically a msg_type, not a role. Widening the
  // CHECK is the minimal fix for OBS-1; proper column split is OBS-2 follow-up.
  // Same rebuild pattern as migration 3 (SQLite cannot ALTER CHECK in place).
  if (version < 7) {
    const mig7Stmts = [
      `CREATE TABLE IF NOT EXISTS layer4_log_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN (
          'user', 'assistant', 'system', 'tool', 'reasoning',
          '_log_debug', '_log_info', '_log_warn', '_log_error',
          'channel_message'
        )),
        content     TEXT NOT NULL,
        token_count INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `INSERT INTO layer4_log_new SELECT * FROM layer4_log`,
      `DROP TABLE layer4_log`,
      `ALTER TABLE layer4_log_new RENAME TO layer4_log`,
      `CREATE INDEX IF NOT EXISTS idx_log_request ON layer4_log(request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_session ON layer4_log(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_agent   ON layer4_log(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_log_created ON layer4_log(created_at)`,
      `PRAGMA user_version = 7`,
    ];
    db.transaction(() => {
      for (const sql of mig7Stmts) db.query(sql).run();
    })();
  }

  // Migration 8 (MEM-5): confidence + status columns on shared_memory and
  // layer2_context. Post-hippocampus now emits a confidence score (0..1);
  // rows below MEMORY_AUTOACCEPT_CONFIDENCE (default 0.8) are inserted with
  // status='pending' and filtered out of RAG injection until approved.
  // CHECK on status via triggers because SQLite ALTER cannot ADD CHECK.
  // Existing rows default to status='active' via the column DEFAULT — back-compat.
  // Archive layer (layer3_archive) is NOT touched here: it already has its own
  // HIGH/LOW confidence column used by the night-cycle, different semantics.
  if (version < 8) {
    const mig8Stmts = [
      `ALTER TABLE shared_memory ADD COLUMN confidence REAL DEFAULT NULL`,
      `ALTER TABLE shared_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `CREATE TRIGGER IF NOT EXISTS shared_status_check_ins
         BEFORE INSERT ON shared_memory
         WHEN NEW.status NOT IN ('pending','active','rejected')
         BEGIN SELECT RAISE(ABORT, 'invalid status'); END`,
      `CREATE TRIGGER IF NOT EXISTS shared_status_check_upd
         BEFORE UPDATE OF status ON shared_memory
         WHEN NEW.status NOT IN ('pending','active','rejected')
         BEGIN SELECT RAISE(ABORT, 'invalid status'); END`,
      `ALTER TABLE layer2_context ADD COLUMN confidence REAL DEFAULT NULL`,
      `ALTER TABLE layer2_context ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `CREATE TRIGGER IF NOT EXISTS context_status_check_ins
         BEFORE INSERT ON layer2_context
         WHEN NEW.status NOT IN ('pending','active','rejected')
         BEGIN SELECT RAISE(ABORT, 'invalid status'); END`,
      `CREATE TRIGGER IF NOT EXISTS context_status_check_upd
         BEFORE UPDATE OF status ON layer2_context
         WHEN NEW.status NOT IN ('pending','active','rejected')
         BEGIN SELECT RAISE(ABORT, 'invalid status'); END`,
      `CREATE INDEX IF NOT EXISTS idx_shared_status ON shared_memory(status)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_status ON layer2_context(status)`,
      `PRAGMA user_version = 8`,
    ];
    db.transaction(() => {
      for (const sql of mig8Stmts) db.query(sql).run();
    })();
  }

  // Migration 9 (MEM-6): expires_at + superseded_by on shared_memory and
  // layer2_context. Lets the post-hippocampus + night cycle mark stale plans /
  // strategies as expired, and merge near-duplicate facts into a single
  // surviving row without losing the audit trail. Pre + RAG read paths gain a
  // separate `notStale` filter so pending (status<active) rows stay visible to
  // the pre-phase agentic search but expired/superseded rows never reach the
  // system prompt. Migration is purely additive — ALTER ADD with NULL default,
  // no backfill — so existing rows keep working under both old and new code.
  // FTS5 mirrors are NOT touched: filter happens at JOIN-time on the source
  // table, so mirror rebuild is unnecessary.
  if (version < 9) {
    const mig9Stmts = [
      `ALTER TABLE shared_memory ADD COLUMN expires_at INTEGER DEFAULT NULL`,
      `ALTER TABLE shared_memory ADD COLUMN superseded_by TEXT DEFAULT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_shared_active
         ON shared_memory(expires_at, superseded_by)
         WHERE superseded_by IS NULL`,
      `CREATE TRIGGER IF NOT EXISTS shared_supersede_self
         BEFORE UPDATE OF superseded_by ON shared_memory
         WHEN NEW.superseded_by IS NOT NULL
          AND NEW.superseded_by NOT IN ('expired')
          AND NEW.superseded_by = NEW.id
         BEGIN SELECT RAISE(ABORT, 'cannot supersede self'); END`,
      `ALTER TABLE layer2_context ADD COLUMN expires_at INTEGER DEFAULT NULL`,
      `ALTER TABLE layer2_context ADD COLUMN superseded_by TEXT DEFAULT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_context_active
         ON layer2_context(expires_at, superseded_by)
         WHERE superseded_by IS NULL`,
      `CREATE TRIGGER IF NOT EXISTS context_supersede_self
         BEFORE UPDATE OF superseded_by ON layer2_context
         WHEN NEW.superseded_by IS NOT NULL
          AND NEW.superseded_by NOT IN ('expired')
          AND NEW.superseded_by = NEW.id
         BEGIN SELECT RAISE(ABORT, 'cannot supersede self'); END`,
      `PRAGMA user_version = 9`,
    ];
    db.transaction(() => {
      for (const sql of mig9Stmts) db.query(sql).run();
    })();
  }

  // Migration 10 (M-02): access tracking on shared / context / archive.
  // Adds `last_accessed_at` (unix-ms, NULL for legacy rows that have never
  // been retrieved) and `access_count` (cumulative popularity, NOT NULL
  // DEFAULT 0 — SQLite ALTER ADD COLUMN with DEFAULT backfills existing
  // rows). Foundation for M-03 (salience reinforce-on-access) and M-08
  // (Ebbinghaus-style recency decay in retrieval ranking). RAG retrieval
  // bumps these fields after rerank via MemoryRepository.bumpAccess.
  //
  // Idempotency: `user_version < 10` guard plus per-statement try/catch on
  // "duplicate column name" — same belt-and-braces pattern as future re-runs
  // on databases where partial state exists. The `db.transaction` wrap +
  // per-statement `.run()` matches mig 7/8/9 (bun:sqlite multi-statement
  // .exec swallows failures, .run + try/catch propagates them properly).
  if (version < 10) {
    const addColumnStmts = [
      `ALTER TABLE shared_memory   ADD COLUMN last_accessed_at INTEGER DEFAULT NULL`,
      `ALTER TABLE shared_memory   ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE layer2_context  ADD COLUMN last_accessed_at INTEGER DEFAULT NULL`,
      `ALTER TABLE layer2_context  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE layer3_archive  ADD COLUMN last_accessed_at INTEGER DEFAULT NULL`,
      `ALTER TABLE layer3_archive  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
    ];
    const indexStmts = [
      `CREATE INDEX IF NOT EXISTS idx_shared_access  ON shared_memory  (last_accessed_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_context_access ON layer2_context (last_accessed_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_archive_access ON layer3_archive (last_accessed_at DESC)`,
    ];
    db.transaction(() => {
      for (const sql of addColumnStmts) {
        try {
          db.query(sql).run();
        } catch (err) {
          // SQLite emits "duplicate column name: <name>" if a previous
          // partial run already added this column; treat as idempotent.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/duplicate column name/i.test(msg)) throw err;
        }
      }
      for (const sql of indexStmts) db.query(sql).run();
      db.query(`PRAGMA user_version = 10`).run();
    })();
  }

  // Migration 11 (M-04): FTS5 mirror over layer4_log (role + content) +
  // sync triggers + one-shot backfill. Foundation for episodic queryable
  // memory: agent-only `memory_log_search` tool + RAG layer "log" (FTS-only
  // branch — no vec embeddings on Layer 4 in this PR; that's M-04.1).
  //
  // Public REST `/v1/memory/log` stays read-only without `?q` to avoid
  // leaking PII through unauthenticated/admin search; the FTS index is
  // reachable only via MCP `agent-only` scope.
  //
  // Backfill guarded: only runs when fts_log is empty so a partial
  // migration rerun does not double-index existing rows. Pattern matches
  // fts_context / fts_archive / fts_shared (schema.ts:126-200).
  if (version < 11) {
    const mig11Stmts = [
      `CREATE VIRTUAL TABLE IF NOT EXISTS fts_log USING fts5(
        role, content,
        content='layer4_log', content_rowid='id',
        tokenize='porter unicode61'
      )`,
      `CREATE TRIGGER IF NOT EXISTS fts_log_ai AFTER INSERT ON layer4_log BEGIN
        INSERT INTO fts_log(rowid, role, content) VALUES (new.id, new.role, new.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS fts_log_ad AFTER DELETE ON layer4_log BEGIN
        INSERT INTO fts_log(fts_log, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS fts_log_au AFTER UPDATE ON layer4_log BEGIN
        INSERT INTO fts_log(fts_log, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
        INSERT INTO fts_log(rowid, role, content) VALUES (new.id, new.role, new.content);
      END`,
    ];
    db.transaction(() => {
      for (const sql of mig11Stmts) db.query(sql).run();
      // One-shot backfill — only when fts_log is empty. Handles two cases:
      // (a) fresh DB with non-empty layer4_log (mig 11 first run after
      // upgrade), (b) partial-rerun where triggers already populated some
      // rows. count=0 → seed from layer4_log; count>0 → triggers are in
      // charge, no double-insert.
      const ftsCount = db
        .query<{ c: number }, []>("SELECT count(*) AS c FROM fts_log")
        .get()!.c;
      if (ftsCount === 0) {
        db.query(
          `INSERT INTO fts_log(rowid, role, content)
             SELECT id, role, content FROM layer4_log`,
        ).run();
      }
      db.query(`PRAGMA user_version = 11`).run();
    })();
  }

  // Migration 12 (M-07): kind column on shared_memory.
  //
  // Splits identity/personality facts (persona) from generic semantic facts
  // so the RAG pipeline can give persona rows a +10% rerank boost — "user
  // prefers Hyprland" should outrank "TypeScript strict mode is good".
  // Foundation for M-08 (asymmetric forgetting curve — persona never decays)
  // and M-11 (sleep-time block rewriter).
  //
  // Kind column is shared-only in M-07 by design; layer2_context /
  // layer3_archive / agent_memory are NOT touched. Persona facts are global
  // user-identity statements — they belong to shared by definition.
  //
  // CHECK constraint via 2 BEFORE-triggers (INSERT + UPDATE OF kind) because
  // SQLite ALTER cannot ADD CHECK in place. Same pattern as mig 8 status.
  //
  // Backfill: profile / preference / relationship → 'persona'; everything
  // else → 'semantic' (matches the SQL DEFAULT for new rows missing kind).
  // episodic / procedural NOT auto-assigned — values valid in CHECK but no
  // category mapping in M-07.
  //
  // Number assignment: 12 (M-04 owns 11; merges resolve cleanly because the
  // two migrations touch disjoint tables — fts_log vs shared_memory).
  if (version < 12) {
    const mig12Stmts = [
      `ALTER TABLE shared_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'`,
      `UPDATE shared_memory
          SET kind = CASE LOWER(category)
                       WHEN 'profile'      THEN 'persona'
                       WHEN 'preference'   THEN 'persona'
                       WHEN 'relationship' THEN 'persona'
                       ELSE 'semantic'
                     END`,
      `CREATE TRIGGER IF NOT EXISTS trg_shared_kind_check
         BEFORE INSERT ON shared_memory
         WHEN NEW.kind NOT IN ('persona','semantic','episodic','procedural')
         BEGIN SELECT RAISE(ABORT, 'invalid kind'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_shared_kind_check_upd
         BEFORE UPDATE OF kind ON shared_memory
         WHEN NEW.kind NOT IN ('persona','semantic','episodic','procedural')
         BEGIN SELECT RAISE(ABORT, 'invalid kind'); END`,
      `CREATE INDEX IF NOT EXISTS idx_shared_kind ON shared_memory(kind)`,
    ];
    db.transaction(() => {
      for (const sql of mig12Stmts) {
        try {
          db.query(sql).run();
        } catch (err) {
          // Idempotency: ALTER ADD COLUMN re-run on a partially-migrated DB
          // throws "duplicate column name". Same belt-and-braces as mig 10.
          // Trigger / index create-if-not-exists never throws on rerun.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/duplicate column name/i.test(msg)) throw err;
        }
      }
      db.query(`PRAGMA user_version = 12`).run();
    })();
  }

  // Migration 13 (M-03): salience + last_decayed_at on shared / context /
  // archive. Builds on M-02 (mig 10) access tracking — salience is the
  // popularity/importance score that grows on every retrieval hit
  // (`MemoryRepository.bumpAccess`) and decays daily in the night cycle
  // (`night-cycle/steps/decay-salience.ts`).
  //
  // `salience REAL NOT NULL DEFAULT 0.5` — neutral baseline; existing rows
  // backfilled by SQLite's ALTER ADD COLUMN-with-DEFAULT mechanism.
  // `last_decayed_at INTEGER DEFAULT NULL` — bookkeeping for idempotent
  // night-cycle decay (Path A in M-03 plan): decay computes
  // `(now - last_decayed_at) / 86400` and updates `last_decayed_at = now`,
  // so a same-day re-run is a no-op (age delta = 0).
  //
  // Idempotency: try/catch on "duplicate column name" — same belt-and-
  // braces pattern as mig 10/12. Indexes are CREATE IF NOT EXISTS.
  if (version < 13) {
    const addColumnStmts = [
      `ALTER TABLE shared_memory   ADD COLUMN salience REAL NOT NULL DEFAULT 0.5`,
      `ALTER TABLE shared_memory   ADD COLUMN last_decayed_at INTEGER DEFAULT NULL`,
      `ALTER TABLE layer2_context  ADD COLUMN salience REAL NOT NULL DEFAULT 0.5`,
      `ALTER TABLE layer2_context  ADD COLUMN last_decayed_at INTEGER DEFAULT NULL`,
      `ALTER TABLE layer3_archive  ADD COLUMN salience REAL NOT NULL DEFAULT 0.5`,
      `ALTER TABLE layer3_archive  ADD COLUMN last_decayed_at INTEGER DEFAULT NULL`,
    ];
    const indexStmts = [
      `CREATE INDEX IF NOT EXISTS idx_shared_salience  ON shared_memory  (salience DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_context_salience ON layer2_context (salience DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_archive_salience ON layer3_archive (salience DESC)`,
    ];
    db.transaction(() => {
      for (const sql of addColumnStmts) {
        try {
          db.query(sql).run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/duplicate column name/i.test(msg)) throw err;
        }
      }
      for (const sql of indexStmts) db.query(sql).run();
      db.query(`PRAGMA user_version = 13`).run();
    })();
  }

  // Migration 14 (M-05): memory_edges table + 3 indexes + backfill from
  // layer2_context.derived_from JSON. Typed edges between memory rows
  // (A-MEM lite Zettelkasten). Backfill heuristic: `derived_from` stores
  // ids without layer info; assume `context` (true for current writers).
  // Idempotency: PK (src_id, src_layer, dst_id, dst_layer, kind) +
  // `count(memory_edges) = 0` guard before backfill.
  if (version < 14) {
    const mig14Stmts = [
      `CREATE TABLE IF NOT EXISTS memory_edges (
        src_id     TEXT NOT NULL,
        src_layer  TEXT NOT NULL CHECK(src_layer IN ('context','archive','shared')),
        dst_id     TEXT NOT NULL,
        dst_layer  TEXT NOT NULL CHECK(dst_layer IN ('context','archive','shared')),
        kind       TEXT NOT NULL CHECK(kind IN ('derives','relates','contradicts','supersedes')),
        weight     REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (src_id, src_layer, dst_id, dst_layer, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_edges_src  ON memory_edges(src_id, src_layer)`,
      `CREATE INDEX IF NOT EXISTS idx_edges_dst  ON memory_edges(dst_id, dst_layer)`,
      `CREATE INDEX IF NOT EXISTS idx_edges_kind ON memory_edges(kind)`,
    ];
    db.transaction(() => {
      for (const sql of mig14Stmts) db.query(sql).run();
      const edgeCount = db
        .query<{ c: number }, []>("SELECT count(*) AS c FROM memory_edges")
        .get()!.c;
      if (edgeCount === 0) {
        db.query(
          `INSERT OR IGNORE INTO memory_edges
             (src_id, src_layer, dst_id, dst_layer, kind, weight, created_at)
           SELECT
             je.value     AS src_id,
             'context'    AS src_layer,
             c.id         AS dst_id,
             'context'    AS dst_layer,
             'derives'    AS kind,
             1.0          AS weight,
             c.created_at AS created_at
             FROM layer2_context c, json_each(COALESCE(c.derived_from, '[]')) je
            WHERE c.derived_from IS NOT NULL
              AND c.derived_from <> ''
              AND c.derived_from <> '[]'
              AND je.value IS NOT NULL
              AND je.value <> ''`,
        ).run();
      }
      db.query(`PRAGMA user_version = 14`).run();
    })();
  }

  // Migration 15 (M-12): unify layer3_archive.confidence — TEXT('HIGH'|'LOW')
  // → REAL [0..1]. shared_memory + layer2_context already carry REAL via
  // mig 8; archive was the last legacy holdout (different writer = night
  // cycle). Backfill: 'HIGH' → 0.9 (≥ MEMORY_AUTOACCEPT_CONFIDENCE 0.8 →
  // status='active'), 'LOW' → 0.4, NULL/anything else → NULL.
  //
  // SQLite cannot ALTER COLUMN type — same temp-table + INSERT SELECT +
  // DROP + RENAME pattern as mig 3/7. Rebuild preserves M-02 columns
  // (last_accessed_at, access_count) and M-03 columns (salience,
  // last_decayed_at). FTS5 triggers (`fts_archive_*`) are dropped
  // implicitly when the source table is dropped — re-create after rename.
  // Indexes (idx_archive_access from mig 10, idx_archive_salience from
  // mig 13) are also re-created.
  //
  // M-07 plan-locked archive out of `kind` — do NOT add it here.
  // M-10 (parallel) needs no migration → 15 belongs entirely to M-12.
  if (version < 15) {
    const mig15Stmts = [
      `CREATE TABLE IF NOT EXISTS layer3_archive_new (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        content            TEXT NOT NULL,
        tags               TEXT NOT NULL DEFAULT '',
        source_request_ids TEXT NOT NULL DEFAULT '[]',
        confidence         REAL DEFAULT NULL,
        agent_id           TEXT,
        created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        last_accessed_at   INTEGER DEFAULT NULL,
        access_count       INTEGER NOT NULL DEFAULT 0,
        salience           REAL NOT NULL DEFAULT 0.5,
        last_decayed_at    INTEGER DEFAULT NULL
      )`,
      `INSERT INTO layer3_archive_new
         SELECT id, title, content, tags, source_request_ids,
                CASE confidence
                  WHEN 'HIGH' THEN 0.9
                  WHEN 'LOW'  THEN 0.4
                  ELSE NULL
                END,
                agent_id, created_at, updated_at,
                last_accessed_at, access_count, salience, last_decayed_at
           FROM layer3_archive`,
      `DROP TABLE layer3_archive`,
      `ALTER TABLE layer3_archive_new RENAME TO layer3_archive`,
      // M-02 / M-03 indexes — re-create after rename.
      `CREATE INDEX IF NOT EXISTS idx_archive_access   ON layer3_archive(last_accessed_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_archive_salience ON layer3_archive(salience DESC)`,
      // FTS5 mirror triggers — DROP TABLE invalidated them. fts_archive
      // virtual table itself survives (separate table); just rewire.
      `CREATE TRIGGER IF NOT EXISTS fts_archive_ai AFTER INSERT ON layer3_archive BEGIN
         INSERT INTO fts_archive(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END`,
      `CREATE TRIGGER IF NOT EXISTS fts_archive_ad AFTER DELETE ON layer3_archive BEGIN
         INSERT INTO fts_archive(fts_archive, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
       END`,
      `CREATE TRIGGER IF NOT EXISTS fts_archive_au AFTER UPDATE ON layer3_archive BEGIN
         INSERT INTO fts_archive(fts_archive, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
         INSERT INTO fts_archive(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END`,
      // Critic round-1 fix: fts_archive (contentless FTS5 with
      // content=layer3_archive, content_rowid=rowid) survived the
      // DROP+RENAME but its index is keyed by OLD rowids that no longer
      // map to anything. New rows entering via `_ai` trigger work fine
      // (matched rowids); legacy rows would silently fall out of FTS
      // search. The 'rebuild' command tells FTS5 to re-read everything
      // from the (now-renamed) source table — single statement, fast on
      // modest archive sizes, fully solves the rowid mismatch.
      `INSERT INTO fts_archive(fts_archive) VALUES('rebuild')`,
      `PRAGMA user_version = 15`,
    ];
    db.transaction(() => {
      for (const sql of mig15Stmts) db.query(sql).run();
    })();
  }
}

export { EMBEDDING_DIM };
