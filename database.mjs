import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename = ':memory:') {
  const path = filename === ':memory:' ? filename : resolve(filename);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upload_requests (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL,
      data TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      review_note TEXT
    );
    CREATE INDEX IF NOT EXISTS upload_requests_status_date
      ON upload_requests(status, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS songs_title_key ON songs(title_key);
  `);
  const requestColumns = db.prepare('PRAGMA table_info(upload_requests)').all();
  if (!requestColumns.some(column => column.name === 'line_count')) {
    db.exec('ALTER TABLE upload_requests ADD COLUMN line_count INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

export function normalizeSongTitle(title) {
  return title.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}
