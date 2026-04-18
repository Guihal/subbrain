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

  // Migration 3: Add 'reasoning' role to layer4_log CHECK constraint
  if (version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS layer4_log_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool', 'reasoning')),
        content     TEXT NOT NULL,
        token_count INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO layer4_log_new SELECT * FROM layer4_log;
      DROP TABLE layer4_log;
      ALTER TABLE layer4_log_new RENAME TO layer4_log;
      CREATE INDEX IF NOT EXISTS idx_log_request  ON layer4_log(request_id);
      CREATE INDEX IF NOT EXISTS idx_log_session  ON layer4_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_log_agent    ON layer4_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_log_created  ON layer4_log(created_at);
      PRAGMA user_version = 3;
    `);
  }
}

export { EMBEDDING_DIM };
