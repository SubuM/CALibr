import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrate, SCHEMA, type DBAccess } from "./schema.js";
import type { Book, Borrower, BookView, Loan, LoanView, SessionUser, TeamMember } from "../domain/models.js";
import { makeBookView, toIsoDate, todayIso } from "../domain/models.js";
import { GROUPS, type GroupName } from "../config.js";
import { NotFoundError, RepositoryError } from "../domain/errors.js";
import { defaultPassword, hashPassword, initialsUsername } from "../domain/auth.js";

type Row = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 10) || null;
}

function bool(value: unknown): boolean {
  return Boolean(value);
}

type Statement = ReturnType<DatabaseSync["prepare"]>;

export class Repository {
  readonly db: DatabaseSync;

  constructor(pathOrMemory: string = ":memory:") {
    if (pathOrMemory !== ":memory:") {
      fs.mkdirSync(path.dirname(pathOrMemory), { recursive: true });
    }
    this.db = new DatabaseSync(pathOrMemory);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    migrate(this.db as unknown as DBAccess);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Run `fn` inside an immediate transaction (rolls back on error). */
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    const stmt: Statement = this.db.prepare(sql);
    const info = stmt.run(...params);
    return Number(info.changes);
  }

  // ------------------------------------------------------------------ books
  addBook(book: Book): Book {
    const sql = `INSERT INTO books (title, author, publisher, isbn, total_copies, cost, added_at, discontinued)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const info = this.db
      .prepare(sql)
      .run(
        book.title,
        book.author,
        book.publisher,
        book.isbn,
        book.totalCopies,
        book.cost,
        iso(book.addedAt) ?? todayIso(),
        book.discontinued ? 1 : 0,
      );
    book.id = Number(info.lastInsertRowid);
    return book;
  }

  updateBook(book: Book): Book {
    if (book.id === undefined) throw new NotFoundError("book id is required");
    const changes = this.run(
      `UPDATE books SET title=?, author=?, publisher=?, isbn=?, total_copies=?, cost=?,
       discontinued=? WHERE id=?`,
      book.title,
      book.author,
      book.publisher,
      book.isbn,
      book.totalCopies,
      book.cost,
      book.discontinued ? 1 : 0,
      book.id,
    );
    if (changes === 0) throw new NotFoundError(`book ${book.id} not found`);
    return book;
  }

  getBook(bookId: number): Book {
    const row = this.db.prepare("SELECT * FROM books WHERE id=?").get(bookId) as
      | Row
      | undefined;
    if (!row) throw new NotFoundError(`book ${bookId} not found`);
    return {
      id: Number(row.id),
      title: String(row.title),
      author: String(row.author ?? ""),
      publisher: String(row.publisher ?? ""),
      isbn: String(row.isbn ?? ""),
      totalCopies: Number(row.total_copies),
      cost: Number(row.cost ?? 0),
      addedAt: iso(row.added_at),
      discontinued: bool(row.discontinued),
    };
  }

  listBooks(): BookView[] {
    const rows = this.db
      .prepare(
        `SELECT b.*,
                (SELECT COUNT(*) FROM loans l
                  WHERE l.book_id = b.id AND l.return_date IS NULL) AS borrowed_copies,
                (SELECT GROUP_CONCAT(br.name, ', ')
                  FROM loans l JOIN borrowers br ON br.id = l.borrower_id
                 WHERE l.book_id = b.id AND l.return_date IS NULL) AS borrower_names,
                (SELECT MIN(l.borrow_date) FROM loans l
                  WHERE l.book_id = b.id AND l.return_date IS NULL) AS borrow_date,
                (SELECT l.remarks FROM loans l
                  WHERE l.book_id = b.id AND l.return_date IS NULL
                  ORDER BY l.borrow_date, l.id LIMIT 1) AS remarks,
                (SELECT l.id FROM loans l
                  WHERE l.book_id = b.id AND l.return_date IS NULL
                  ORDER BY l.borrow_date, l.id LIMIT 1) AS loan_id,
                (SELECT MAX(l.return_date) FROM loans l
                  WHERE l.book_id = b.id AND l.return_date IS NOT NULL) AS last_return_date
         FROM books b
         ORDER BY b.title COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map((r) =>
      makeBookView({
        id: Number(r.id),
        title: String(r.title),
        author: String(r.author ?? ""),
        publisher: String(r.publisher ?? ""),
        isbn: String(r.isbn ?? ""),
        totalCopies: Number(r.total_copies),
        borrowedCopies: Number(r.borrowed_copies ?? 0),
        cost: Number(r.cost ?? 0),
        addedAt: iso(r.added_at),
        discontinued: bool(r.discontinued),
        borrowerNames: r.borrower_names
          ? String(r.borrower_names)
              .split(", ")
              .filter((s) => s.length > 0)
          : [],
        borrowDate: iso(r.borrow_date),
        returnDate: iso(r.last_return_date),
        remarks: String(r.remarks ?? ""),
        loanId: r.loan_id !== null && r.loan_id !== undefined ? Number(r.loan_id) : null,
      }),
    );
  }

  activeLoanCount(bookId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM loans WHERE book_id=? AND return_date IS NULL")
      .get(bookId) as Row;
    return Number(row.n);
  }

  // -------------------------------------------------------------- borrowers
  private borrowerFromRow(r: Row): Borrower {
    return {
      id: Number(r.id),
      name: String(r.name),
      firstName: String(r.first_name ?? ""),
      lastName: String(r.last_name ?? ""),
      department: String(r.department ?? ""),
      team: String(r.team ?? ""),
      phone: String(r.phone ?? ""),
      email: String(r.email ?? ""),
      joinedAt: iso(r.joined_at),
      active: bool(r.active),
    };
  }

  addBorrower(borrower: Borrower): Borrower {
    const name = borrower.name.trim() || borrower.firstName || "??";
    const info = this.db
      .prepare(
        `INSERT INTO borrowers (name, first_name, last_name, department, team, phone, email, joined_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        name,
        borrower.firstName,
        borrower.lastName,
        borrower.department,
        borrower.team,
        borrower.phone,
        borrower.email,
        iso(borrower.joinedAt) ?? todayIso(),
      );
    borrower.id = Number(info.lastInsertRowid);
    borrower.name = name;
    return borrower;
  }

  getBorrower(borrowerId: number): Borrower {
    const row = this.db.prepare("SELECT * FROM borrowers WHERE id=?").get(borrowerId) as
      | Row
      | undefined;
    if (!row) throw new NotFoundError(`borrower ${borrowerId} not found`);
    return this.borrowerFromRow(row);
  }

  listBorrowers(activeOnly = false): Borrower[] {
    const sql =
      "SELECT * FROM borrowers" +
      (activeOnly ? " WHERE active=1" : "") +
      " ORDER BY active DESC, name COLLATE NOCASE";
    return (this.db.prepare(sql).all() as Row[]).map((r) => this.borrowerFromRow(r));
  }

  deleteBorrower(borrowerId: number): void {
    const changes = this.run("DELETE FROM borrowers WHERE id=?", borrowerId);
    if (changes === 0) throw new NotFoundError(`borrower ${borrowerId} not found`);
  }

  borrowerLoanCount(borrowerId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM loans WHERE borrower_id=?")
      .get(borrowerId) as Row;
    return Number(row.n);
  }

  // ----------------------------------------------------------- users & auth
  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row;
    return Number(row.n);
  }

  countAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE group_name='admin'")
      .get() as Row;
    return Number(row.n);
  }

  private sessionUserFromRow(r: Row): SessionUser {
    return {
      borrowerId: Number(r.borrower_id),
      username: String(r.username),
      name: String(r.name),
      groupName: String(r.group_name) as GroupName,
      mustChange: bool(r.must_change),
    };
  }

  userByUsername(username: string): SessionUser | null {
    const row = this.db
      .prepare(
        `SELECT u.username, u.group_name, u.must_change, u.borrower_id, b.name, b.active
         FROM users u JOIN borrowers b ON b.id = u.borrower_id
         WHERE u.username = ? COLLATE NOCASE`,
      )
      .get(username.trim()) as Row | undefined;
    return row ? this.sessionUserFromRow(row) : null;
  }

  userByBorrower(borrowerId: number): SessionUser | null {
    const row = this.db
      .prepare(
        `SELECT u.username, u.group_name, u.must_change, u.borrower_id, b.name, b.active
         FROM users u JOIN borrowers b ON b.id = u.borrower_id
         WHERE u.borrower_id = ?`,
      )
      .get(borrowerId) as Row | undefined;
    return row ? this.sessionUserFromRow(row) : null;
  }

  userBorrowerId(username: string): number | null {
    const row = this.db
      .prepare("SELECT borrower_id FROM users WHERE username=? COLLATE NOCASE")
      .get(username.trim()) as Row | undefined;
    return row && row.borrower_id !== null ? Number(row.borrower_id) : null;
  }

  insertUser(
    borrowerId: number,
    username: string,
    password: string,
    group: GroupName,
    mustChange = false,
  ): void {
    const { salt, hash } = hashPassword(password);
    this.db
      .prepare(
        `INSERT INTO users (borrower_id, username, password_salt, password_hash, group_name, must_change, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(borrowerId, username, salt, hash, group, mustChange ? 1 : 0, todayIso());
  }

  passwordCredential(borrowerIdOrUsername: number | string): {
    username: string;
    salt: string;
    hash: string;
    active: boolean;
  } | null {
    const where =
      typeof borrowerIdOrUsername === "number"
        ? "users.borrower_id = ?"
        : "users.username = ? COLLATE NOCASE";
    const row = this.db
      .prepare(
        `SELECT users.username, users.password_salt, users.password_hash, borrowers.active
         FROM users JOIN borrowers ON borrowers.id = users.borrower_id
         WHERE ${where}`,
      )
      .get(borrowerIdOrUsername) as Row | undefined;
    if (!row) return null;
    return {
      username: String(row.username),
      salt: String(row.password_salt),
      hash: String(row.password_hash),
      active: bool(row.active),
    };
  }

  private rememberPassword(borrowerId: number, salt: string, hash: string, keep = 3): void {
    this.db
      .prepare(
        "INSERT INTO password_history (borrower_id, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(borrowerId, salt, hash, todayIso());
    this.db
      .prepare(
        `DELETE FROM password_history WHERE id NOT IN (
           SELECT id FROM password_history WHERE borrower_id=? ORDER BY id DESC LIMIT ?)`,
      )
      .run(borrowerId, keep);
  }

  passwordHistoryHashes(borrowerId: number, limit = 3): Array<[string, string]> {
    const rows = this.db
      .prepare(
        "SELECT password_salt, password_hash FROM password_history WHERE borrower_id=? ORDER BY id DESC LIMIT ?",
      )
      .all(borrowerId, limit) as Row[];
    return rows.map((r) => [String(r.password_salt), String(r.password_hash)]);
  }

  setUserPassword(borrowerId: number, password: string): void {
    const current = this.passwordCredential(borrowerId);
    if (!current) throw new NotFoundError(`no login account for borrower ${borrowerId}`);
    this.rememberPassword(borrowerId, current.salt, current.hash);
    const { salt, hash } = hashPassword(password);
    this.db
      .prepare("UPDATE users SET password_salt=?, password_hash=?, must_change=0 WHERE borrower_id=?")
      .run(salt, hash, borrowerId);
  }

  resetUserPassword(borrowerId: number): { defaultPassword: string; username: string } {
    const current = this.passwordCredential(borrowerId);
    if (!current) throw new NotFoundError(`no login account for borrower ${borrowerId}`);
    this.rememberPassword(borrowerId, current.salt, current.hash);
    const def = defaultPassword(current.username);
    const { salt, hash } = hashPassword(def);
    this.db
      .prepare("UPDATE users SET password_salt=?, password_hash=?, must_change=1 WHERE borrower_id=?")
      .run(salt, hash, borrowerId);
    return { defaultPassword: def, username: current.username };
  }

  setUserGroup(borrowerId: number, group: GroupName): void {
    const changes = this.run("UPDATE users SET group_name=? WHERE borrower_id=?", group, borrowerId);
    if (changes === 0) throw new NotFoundError(`no login account for borrower ${borrowerId}`);
  }

  // ------------------------------------------------------- team sync helpers
  private uniqueUsername(base: string): string {
    const prefix = base.toUpperCase();
    const taken = new Set<string>();
    for (const r of this.db.prepare("SELECT username FROM users").all() as Row[]) {
      taken.add(String(r.username).toUpperCase());
    }
    if (!taken.has(prefix)) return prefix;
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n += 1;
    return `${prefix}${n}`;
  }

  applyTeam(
    toAdd: TeamMember[],
    toUpdate: Array<[number, TeamMember]>,
    toDeactivate: number[],
  ): Array<{ name: string; username: string; defaultPassword: string }> {
    const created: Array<{ name: string; username: string; defaultPassword: string }> = [];
    return this.transaction(() => {
      for (const m of toAdd) {
        const info = this.db
          .prepare(
            `INSERT INTO borrowers (name, first_name, last_name, department, team, phone, email, joined_at, active)
             VALUES (?, ?, ?, ?, ?, '', '', ?, 1)`,
          )
          .run(m.fullName, m.firstName, m.lastName, m.department, m.team, todayIso());
        const username = this.uniqueUsername(initialsUsername(m));
        const def = defaultPassword(username);
        const { salt, hash } = hashPassword(def);
        this.db
          .prepare(
            `INSERT INTO users (borrower_id, username, password_salt, password_hash, group_name, must_change, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(Number(info.lastInsertRowid), username, salt, hash, m.group, todayIso());
        created.push({ name: m.fullName, username, defaultPassword: def });
      }
      for (const [bid, m] of toUpdate) {
        const exists = this.db.prepare("SELECT 1 FROM users WHERE borrower_id=?").get(bid);
        if (!exists) {
          const username = this.uniqueUsername(initialsUsername(m));
          const def = defaultPassword(username);
          const { salt, hash } = hashPassword(def);
          this.db
            .prepare(
              `INSERT INTO users (borrower_id, username, password_salt, password_hash, group_name, must_change, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?)`,
            )
            .run(bid, username, salt, hash, m.group, todayIso());
          created.push({ name: m.fullName, username, defaultPassword: def });
        }
        this.db
          .prepare(
            "UPDATE borrowers SET name=?, first_name=?, last_name=?, department=?, team=?, active=1 WHERE id=?",
          )
          .run(m.fullName, m.firstName, m.lastName, m.department, m.team, bid);
        this.db.prepare("UPDATE users SET group_name=? WHERE borrower_id=?").run(m.group, bid);
      }
      for (const bid of toDeactivate) {
        this.db.prepare("UPDATE borrowers SET active=0 WHERE id=?").run(bid);
      }
      return created;
    });
  }

  clearAuthData(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM loans");
      this.db.exec("DELETE FROM users");
      this.db.exec("DELETE FROM borrowers");
    });
  }

  purgeAll(): void {
    this.transaction(() => {
      for (const table of ["loans", "users", "password_history", "borrowers", "books"]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      try {
        this.db.exec("DELETE FROM sqlite_sequence");
      } catch {
        /* no-op */
      }
    });
  }

  // ---------------------------------------------------------------- loans
  createLoan(bookId: number, borrowerId: number, borrowDate: string): Loan {
    const book = this.db
      .prepare("SELECT total_copies, discontinued FROM books WHERE id=?")
      .get(bookId) as Row | undefined;
    if (!book) throw new NotFoundError(`book ${bookId} not found`);
    if (bool(book.discontinued)) throw new RepositoryError("this book is marked Not Available");

    const borrower = this.db
      .prepare("SELECT id, active FROM borrowers WHERE id=?")
      .get(borrowerId) as Row | undefined;
    if (!borrower) throw new NotFoundError(`borrower ${borrowerId} not found`);
    if (!bool(borrower.active)) {
      throw new RepositoryError(
        "this person is not an active team member (upload the current team list)",
      );
    }

    const activeRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM loans WHERE book_id=? AND return_date IS NULL")
      .get(bookId) as Row;
    const active = Number(activeRow.n);
    if (active >= Number(book.total_copies)) {
      throw new RepositoryError(
        `all ${book.total_copies} copy/copies of this book are already borrowed`,
      );
    }

    const info = this.db
      .prepare("INSERT INTO loans (book_id, borrower_id, borrow_date) VALUES (?, ?, ?)")
      .run(bookId, borrowerId, borrowDate);
    return {
      id: Number(info.lastInsertRowid),
      bookId,
      borrowerId,
      borrowDate: toIsoDate(borrowDate),
      returnDate: null,
      remarks: "",
    };
  }

  returnLoan(loanId: number, returnDate: string, remarks = ""): Loan {
    const row = this.db.prepare("SELECT * FROM loans WHERE id=?").get(loanId) as
      | Row
      | undefined;
    if (!row) throw new NotFoundError(`loan ${loanId} not found`);
    if (row.return_date !== null) throw new RepositoryError(`loan ${loanId} is already returned`);
    this.db.prepare("UPDATE loans SET return_date=?, remarks=? WHERE id=?").run(returnDate, remarks, loanId);
    return {
      id: loanId,
      bookId: Number(row.book_id),
      borrowerId: Number(row.borrower_id),
      borrowDate: iso(row.borrow_date),
      returnDate: toIsoDate(returnDate),
      remarks,
    };
  }

  updateLoanRemarks(loanId: number, remarks: string): void {
    const changes = this.run("UPDATE loans SET remarks=? WHERE id=?", remarks, loanId);
    if (changes === 0) throw new NotFoundError(`loan ${loanId} not found`);
  }

  clearActiveLoans(bookId: number, returnDate: string): number {
    return this.run(
      "UPDATE loans SET return_date=? WHERE book_id=? AND return_date IS NULL",
      returnDate,
      bookId,
    );
  }

  listLoans(includeReturned = true): LoanView[] {
    const where = includeReturned ? "" : "WHERE l.return_date IS NULL";
    const rows = this.db
      .prepare(
        `SELECT l.*, b.title AS book_title, br.name AS borrower_name
         FROM loans l
         JOIN books b ON b.id = l.book_id
         JOIN borrowers br ON br.id = l.borrower_id
         ${where}
         ORDER BY CASE WHEN l.return_date IS NULL THEN 0 ELSE 1 END, l.id DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      bookId: Number(r.book_id),
      bookTitle: String(r.book_title),
      borrowerId: Number(r.borrower_id),
      borrowerName: String(r.borrower_name),
      borrowDate: iso(r.borrow_date),
      returnDate: iso(r.return_date),
      remarks: String(r.remarks ?? ""),
    }));
  }
}