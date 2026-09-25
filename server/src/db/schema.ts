export const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    author        TEXT    NOT NULL DEFAULT '',
    publisher     TEXT    NOT NULL DEFAULT '',
    isbn          TEXT    NOT NULL DEFAULT '',
    total_copies  INTEGER NOT NULL DEFAULT 1 CHECK (total_copies >= 0),
    cost          REAL    NOT NULL DEFAULT 0,
    added_at      TEXT    NOT NULL,
    discontinued  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS borrowers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    first_name   TEXT    NOT NULL DEFAULT '',
    last_name    TEXT    NOT NULL DEFAULT '',
    department   TEXT    NOT NULL DEFAULT '',
    team         TEXT    NOT NULL DEFAULT '',
    phone        TEXT    NOT NULL DEFAULT '',
    email        TEXT    NOT NULL DEFAULT '',
    joined_at    TEXT    NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL REFERENCES books(id),
    borrower_id INTEGER NOT NULL REFERENCES borrowers(id),
    borrow_date TEXT    NOT NULL,
    return_date TEXT,
    remarks     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id      INTEGER NOT NULL UNIQUE REFERENCES borrowers(id),
    username         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_salt    TEXT    NOT NULL,
    password_hash    TEXT    NOT NULL,
    group_name       TEXT    NOT NULL DEFAULT 'general'
                     CHECK (group_name IN ('admin', 'power', 'general')),
    must_change      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS password_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id    INTEGER NOT NULL REFERENCES borrowers(id),
    password_salt  TEXT    NOT NULL,
    password_hash  TEXT    NOT NULL,
    created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loans_book     ON loans(book_id);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);
CREATE INDEX IF NOT EXISTS idx_loans_open     ON loans(return_date) WHERE return_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_pw_hist        ON password_history(borrower_id);
`;

export interface DBAccess {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
    run: (...params: unknown[]) => { changes: number | bigint };
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
}

/**
 * In-place schema migrations so a database created by the old Streamlit app
 * (or an earlier revision of this app) upgrades cleanly.
 */
export function migrate(db: DBAccess): void {
  const tableInfo = (name: string) =>
    new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((r) => String(r.name)));

  const loanCols = tableInfo("loans");
  if (loanCols.has("due_date")) db.exec("ALTER TABLE loans DROP COLUMN due_date");

  const bookCols = tableInfo("books");
  if (!bookCols.has("discontinued")) {
    db.exec("ALTER TABLE books ADD COLUMN discontinued INTEGER NOT NULL DEFAULT 0");
  }

  let borrCols = tableInfo("borrowers");
  if (!borrCols.has("department")) {
    if (borrCols.has("designation")) {
      try {
        db.exec("ALTER TABLE borrowers RENAME COLUMN designation TO department");
      } catch {
        db.exec("ALTER TABLE borrowers ADD COLUMN department TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE borrowers SET department = designation");
      }
    } else {
      db.exec("ALTER TABLE borrowers ADD COLUMN department TEXT NOT NULL DEFAULT ''");
    }
  }
  if (!borrCols.has("team")) {
    if (borrCols.has("area_of_work")) {
      try {
        db.exec("ALTER TABLE borrowers RENAME COLUMN area_of_work TO team");
      } catch {
        db.exec("ALTER TABLE borrowers ADD COLUMN team TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE borrowers SET team = area_of_work");
      }
    } else {
      db.exec("ALTER TABLE borrowers ADD COLUMN team TEXT NOT NULL DEFAULT ''");
    }
  }

  borrCols = tableInfo("borrowers");
  for (const legacy of ["designation", "area_of_work", "employee_id"]) {
    if (borrCols.has(legacy)) {
      try {
        db.exec(`ALTER TABLE borrowers DROP COLUMN ${legacy}`);
      } catch {
        /* newer SQLite handles DROP COLUMN; older ones leave it */
      }
    }
  }

  borrCols = tableInfo("borrowers");
  for (const [col, ddl] of [
    ["first_name", "TEXT NOT NULL DEFAULT ''"],
    ["last_name", "TEXT NOT NULL DEFAULT ''"],
    ["active", "INTEGER NOT NULL DEFAULT 1"],
  ] as const) {
    if (!borrCols.has(col)) db.exec(`ALTER TABLE borrowers ADD COLUMN ${col} ${ddl}`);
  }

  db.exec(`
    UPDATE borrowers
    SET first_name = CASE WHEN instr(name, ' ') > 0
                          THEN substr(name, 1, instr(name, ' ') - 1)
                          ELSE name END,
        last_name  = CASE WHEN instr(name, ' ') > 0
                          THEN substr(name, instr(name, ' ') + 1) ELSE '' END
    WHERE first_name = '' AND last_name = ''
  `);
}