import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'repometrics.db');
const db = new Database(DB_PATH);

// Enable WAL for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    namespace TEXT NOT NULL,
    repo TEXT NOT NULL,
    token TEXT,
    last_synced_at TEXT,
    is_wildcard INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    author TEXT,
    date TEXT,
    message TEXT,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE(repo_id, sha)
  );

  CREATE TABLE IF NOT EXISTS pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    state TEXT,
    created_at TEXT,
    merged_at TEXT,
    closed_at TEXT,
    author TEXT,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE(repo_id, number)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    reviewer TEXT,
    submitted_at TEXT,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    state TEXT,
    created_at TEXT,
    closed_at TEXT,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE(repo_id, number)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    synced_at TEXT DEFAULT (datetime('now')),
    commits_added INTEGER DEFAULT 0,
    prs_added INTEGER DEFAULT 0,
    issues_added INTEGER DEFAULT 0,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo_id);
  CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);
  CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo_id);
  CREATE INDEX IF NOT EXISTS idx_prs_state ON pull_requests(state);
  CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews(repo_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repo_id);
`);

export default db;
