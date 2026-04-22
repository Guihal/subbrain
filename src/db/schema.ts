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
    CREATE TABLE IF NOT EXISTS layer3_archive (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      content            TEXT NOT NULL,
      tags               TEXT NOT NULL DEFAULT '',
      source_request_ids TEXT NOT NULL DEFAULT '[]',
      confidence         TEXT NOT NULL DEFAULT 'HIGH' CHECK(confidence IN ('HIGH', 'LOW')),
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
}

export { EMBEDDING_DIM };
