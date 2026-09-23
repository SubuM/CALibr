"""CALibr — lightweight single-file library management (Streamlit).

Registration-style tracking: each book shows its current borrower (or "--"),
borrow date and return date. There are no due dates. Books are never deleted —
a "Discontinued / Not Available" flag zeroes the copies, keeps the borrower
until the copy physically returns, and supports live operation remarks.

Config: edit the CONFIG constants below. Tune DB path, toggles for optional
fields, and the demo-data button.
"""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import asdict, dataclass
from datetime import date
from enum import Enum
from hashlib import pbkdf2_hmac
from hmac import compare_digest
from io import BytesIO
import os
import re
from pathlib import Path

import pandas as pd
import streamlit as st

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
DB_PATH = "data/library.db"
TRACK_ISBN = True
TRACK_COST = True
TRACK_COPIES = True
TRACK_BORROWER_CONTACT = True
ALLOW_DEMO_DATA = True

GROUPS = ("admin", "power", "general")
GROUP_ADMIN, GROUP_POWER, GROUP_GENERAL = GROUPS
DEFAULT_PASSWORD_SUFFIX = "1234o$"
_PBKDF2_ITERATIONS = 200_000


# ---------------------------------------------------------------------------
# DATA MODEL
# ---------------------------------------------------------------------------
class LoanStatus(str, Enum):
    ACTIVE = "active"
    RETURNED = "returned"


def loan_status(return_date: date | None) -> LoanStatus:
    return LoanStatus.RETURNED if return_date is not None else LoanStatus.ACTIVE


@dataclass(slots=True)
class Book:
    id: int | None = None
    title: str = ""
    author: str = ""
    publisher: str = ""
    isbn: str = ""
    total_copies: int = 1
    cost: float = 0.0
    added_at: date | None = None
    discontinued: bool = False


@dataclass(slots=True)
class Borrower:
    id: int | None = None
    name: str = ""
    first_name: str = ""
    last_name: str = ""
    department: str = ""
    team: str = ""
    phone: str = ""
    email: str = ""
    joined_at: date | None = None
    active: bool = True


@dataclass(slots=True)
class TeamMember:
    """A person imported from the team Excel file (valid borrowers + login users)."""
    first_name: str = ""
    last_name: str = ""
    department: str = ""
    team: str = ""
    group: str = GROUP_GENERAL

    @property
    def full_name(self) -> str:
        return " ".join(p for p in (self.first_name, self.last_name) if p).strip()

    @property
    def key(self) -> str:
        """Stable identity: normalized full name (first name + last name)."""
        return " ".join(self.full_name.lower().split())


@dataclass(slots=True)
class SessionUser:
    """The logged-in user, reshaped from the users x borrowers join."""
    borrower_id: int
    username: str
    name: str
    group_name: str
    must_change: bool = False


@dataclass(slots=True)
class Loan:
    id: int | None = None
    book_id: int = 0
    borrower_id: int = 0
    borrow_date: date | None = None
    return_date: date | None = None
    remarks: str = ""


@dataclass(slots=True)
class BookView:
    id: int
    title: str
    author: str
    publisher: str
    isbn: str
    total_copies: int
    borrowed_copies: int
    cost: float
    added_at: date | None = None
    discontinued: bool = False
    borrower_names: tuple[str, ...] = ()
    borrow_date: date | None = None
    return_date: date | None = None
    remarks: str = ""
    loan_id: int | None = None

    @property
    def available_copies(self) -> int:
        return max(self.total_copies - self.borrowed_copies, 0)

    @property
    def borrower_label(self) -> str:
        return ", ".join(self.borrower_names) if self.borrower_names else "--"

    @property
    def status(self) -> str:
        if self.discontinued:
            return "Not Available"
        if self.available_copies > 0:
            return "Available"
        if self.borrowed_copies > 0:
            return "All borrowed"
        return "No copies"


@dataclass(slots=True)
class LoanView:
    id: int
    book_id: int
    book_title: str
    borrower_id: int
    borrower_name: str
    borrow_date: date | None = None
    return_date: date | None = None
    remarks: str = ""

    def status(self) -> LoanStatus:
        return loan_status(self.return_date)


# ---------------------------------------------------------------------------
# ERRORS
# ---------------------------------------------------------------------------
class RepositoryError(Exception):
    pass


class NotFoundError(RepositoryError):
    pass


class InsufficientCopiesError(RepositoryError):
    pass


class ValidationError(Exception):
    pass


# ---------------------------------------------------------------------------
# AUTH & PASSWORD POLICY (stdlib pbkdf2_hmac; never store plaintext)
# ---------------------------------------------------------------------------
def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or os.urandom(16)
    digest = pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, password_hash: str) -> bool:
    try:
        digest = pbkdf2_hmac("sha256", password.encode("utf-8"),
                             bytes.fromhex(salt_hex), _PBKDF2_ITERATIONS)
        return compare_digest(digest.hex(), password_hash)
    except (ValueError, TypeError):
        return False


def default_password(username: str) -> str:
    return f"{username}{DEFAULT_PASSWORD_SUFFIX}"


def initials_username(member: TeamMember) -> str:
    """Initial login ID: 1st letter of first name + first 2 letters of last name."""
    first = (member.first_name or member.full_name or "?").strip()[0].upper()
    last = (member.last_name or "").strip().upper()
    if not last:
        rest = "".join(c for c in (member.first_name or "").upper() if c.isalnum())
        last = rest[1:3] if len(rest) > 1 else "XX"
    return first + last[:2]


def username_from_names(first: str, last: str) -> str:
    return initials_username(TeamMember(first_name=first, last_name=last))


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def validate_new_password(password: str, *, first_name: str = "",
                          last_name: str = "", username: str = "") -> None:
    """Enforce the password policy on a user-chosen password.

    Policy: 8-20 characters; at least 1 uppercase, 1 lowercase, 1 digit and 1
    special character; must not contain the user's first/last name or login ID
    (case-insensitive), must not contain a well-formed email address, and must
    not be the initial password or one of the user's last 3 passwords (checked
    at change time, not here).

    Exception: the initial password (login ID + suffix) is exempt by design —
    it is the one password allowed to contain the login ID.
    """
    problems: list[str] = []
    if not password:
        problems.append("password is required")
        raise ValidationError("Invalid password:\n• " + "\n• ".join(problems))
    if username and password == default_password(username):
        return
    if not 8 <= len(password) <= 20:
        problems.append("length must be between 8 and 20 characters")
    if not any(c.isupper() for c in password):
        problems.append("must contain at least 1 uppercase letter")
    if not any(c.islower() for c in password):
        problems.append("must contain at least 1 lowercase letter")
    if not any(c.isdigit() for c in password):
        problems.append("must contain at least 1 digit")
    if not any(not c.isalnum() for c in password):
        problems.append("must contain at least 1 special character")
    if _EMAIL_RE.search(password):
        problems.append("must not contain an email address")
    low = password.lower()
    for tag in (first_name.strip(), last_name.strip(), username.strip()):
        if len(tag) >= 2 and tag.lower() in low:
            problems.append(f"must not contain your name or login ID (“{tag}”)")
    if problems:
        raise ValidationError("Invalid password:\n• " + "\n• ".join(problems))


# ---------------------------------------------------------------------------
# STORAGE (SQLite, stdlib only)
# ---------------------------------------------------------------------------
_SCHEMA = """
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
"""


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse(value: str | None) -> date | None:
    return date.fromisoformat(value) if value is not None else None


class Repository:
    def __init__(self, path: str = ":memory:"):
        self._path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        loan_cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(loans)")}
        if "due_date" in loan_cols:
            self._conn.execute("ALTER TABLE loans DROP COLUMN due_date")
        book_cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(books)")}
        if "discontinued" not in book_cols:
            self._conn.execute("ALTER TABLE books ADD COLUMN discontinued INTEGER NOT NULL DEFAULT 0")
        borr_cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(borrowers)")}
        if "department" not in borr_cols:
            if "designation" in borr_cols:
                try:
                    self._conn.execute("ALTER TABLE borrowers RENAME COLUMN designation TO department")
                except sqlite3.OperationalError:
                    self._conn.execute("ALTER TABLE borrowers ADD COLUMN department TEXT NOT NULL DEFAULT ''")
                    self._conn.execute("UPDATE borrowers SET department = designation")
            else:
                self._conn.execute("ALTER TABLE borrowers ADD COLUMN department TEXT NOT NULL DEFAULT ''")
        if "team" not in borr_cols:
            if "area_of_work" in borr_cols:
                try:
                    self._conn.execute("ALTER TABLE borrowers RENAME COLUMN area_of_work TO team")
                except sqlite3.OperationalError:
                    self._conn.execute("ALTER TABLE borrowers ADD COLUMN team TEXT NOT NULL DEFAULT ''")
                    self._conn.execute("UPDATE borrowers SET team = area_of_work")
            else:
                self._conn.execute("ALTER TABLE borrowers ADD COLUMN team TEXT NOT NULL DEFAULT ''")
        current = {r["name"] for r in self._conn.execute("PRAGMA table_info(borrowers)")}
        for legacy in ("designation", "area_of_work", "employee_id"):
            if legacy in current:
                try:
                    self._conn.execute(f"ALTER TABLE borrowers DROP COLUMN {legacy}")
                except sqlite3.OperationalError:
                    pass
        borr_cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(borrowers)")}
        for col, ddl in {
            "first_name": "TEXT NOT NULL DEFAULT ''",
            "last_name": "TEXT NOT NULL DEFAULT ''",
            "active": "INTEGER NOT NULL DEFAULT 1",
        }.items():
            if col not in borr_cols:
                self._conn.execute(f"ALTER TABLE borrowers ADD COLUMN {col} {ddl}")
        self._conn.execute(
            """
            UPDATE borrowers
            SET first_name = CASE WHEN instr(name, ' ') > 0
                                  THEN substr(name, 1, instr(name, ' ') - 1)
                                  ELSE name END,
                last_name  = CASE WHEN instr(name, ' ') > 0
                                  THEN substr(name, instr(name, ' ') + 1) ELSE '' END
            WHERE first_name = '' AND last_name = ''
            """
        )

    def _run(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock, self._conn:
            return self._conn.execute(sql, params)

    def add_book(self, book: Book) -> Book:
        cur = self._run(
            "INSERT INTO books (title, author, publisher, isbn, total_copies, cost, added_at, discontinued)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (book.title, book.author, book.publisher, book.isbn,
             book.total_copies, book.cost, _iso(book.added_at or date.today()),
             int(book.discontinued)),
        )
        book.id = cur.lastrowid
        return book

    def update_book(self, book: Book) -> Book:
        if book.id is None:
            raise NotFoundError("book id is required")
        cur = self._run(
            "UPDATE books SET title=?, author=?, publisher=?, isbn=?, total_copies=?, cost=?,"
            " discontinued=? WHERE id=?",
            (book.title, book.author, book.publisher, book.isbn,
             book.total_copies, book.cost, int(book.discontinued), book.id),
        )
        if cur.rowcount == 0:
            raise NotFoundError(f"book {book.id} not found")
        return book

    def get_book(self, book_id: int) -> Book:
        row = self._run("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"book {book_id} not found")
        return Book(id=row["id"], title=row["title"], author=row["author"],
                    publisher=row["publisher"], isbn=row["isbn"],
                    total_copies=row["total_copies"], cost=row["cost"],
                    added_at=_parse(row["added_at"]), discontinued=bool(row["discontinued"]))

    def list_books(self) -> list[BookView]:
        rows = self._run(
            """
            SELECT b.*,
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
            ORDER BY b.title COLLATE NOCASE
            """
        ).fetchall()
        return [
            BookView(id=r["id"], title=r["title"], author=r["author"], publisher=r["publisher"],
                     isbn=r["isbn"], total_copies=r["total_copies"],
                     borrowed_copies=r["borrowed_copies"], cost=r["cost"],
                     added_at=_parse(r["added_at"]), discontinued=bool(r["discontinued"]),
                     borrower_names=tuple(r["borrower_names"].split(", ")) if r["borrower_names"] else (),
                     borrow_date=_parse(r["borrow_date"]), return_date=_parse(r["last_return_date"]),
                     remarks=r["remarks"] or "", loan_id=r["loan_id"])
            for r in rows
        ]

    @staticmethod
    def _borrower_from_row(r: sqlite3.Row) -> Borrower:
        return Borrower(id=r["id"], name=r["name"], first_name=r["first_name"],
                        last_name=r["last_name"], department=r["department"], team=r["team"],
                        phone=r["phone"], email=r["email"], joined_at=_parse(r["joined_at"]),
                        active=bool(r["active"]))

    def add_borrower(self, borrower: Borrower) -> Borrower:
        name = borrower.name.strip() or borrower.first_name or "??"
        cur = self._run(
            "INSERT INTO borrowers (name, first_name, last_name, department, team,"
            " phone, email, joined_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (name, borrower.first_name, borrower.last_name, borrower.department,
             borrower.team, borrower.phone, borrower.email,
             _iso(borrower.joined_at or date.today())),
        )
        borrower.id = cur.lastrowid
        borrower.name = name
        return borrower

    def get_borrower(self, borrower_id: int) -> Borrower:
        row = self._run("SELECT * FROM borrowers WHERE id=?", (borrower_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"borrower {borrower_id} not found")
        return self._borrower_from_row(row)

    def list_borrowers(self, active_only: bool = False) -> list[Borrower]:
        sql = "SELECT * FROM borrowers" + (" WHERE active=1" if active_only else "")
        sql += " ORDER BY active DESC, name COLLATE NOCASE"
        return [self._borrower_from_row(r) for r in self._run(sql).fetchall()]

    def _unique_username(self, base: str) -> str:
        taken = {r["username"] for r in self._conn.execute(
            "SELECT username FROM users WHERE username = ? COLLATE NOCASE", (base,)
        )}
        if base not in taken:
            return base
        n = 1
        while f"{base}{n}" in taken:
            n += 1
        return f"{base}{n}"

    def apply_team(self, to_add: list[TeamMember], to_update: list[tuple[int, TeamMember]],
                   to_deactivate: list[int]) -> list[dict]:
        """Apply a full team-list sync atomically.

        New members get borrower + login rows (initial default password, forced change).
        Returned list carries the newly created credentials for the admin to share.
        """
        created: list[dict] = []
        with self._lock, self._conn:
            for m in to_add:
                cur = self._conn.execute(
                    "INSERT INTO borrowers (name, first_name, last_name, department, team,"
                    " phone, email, joined_at, active)"
                    " VALUES (?, ?, ?, ?, ?, '', '', ?, 1)",
                    (m.full_name, m.first_name, m.last_name, m.department,
                     m.team, _iso(date.today())),
                )
                username = self._unique_username(initials_username(m))
                salt, pwhash = hash_password(default_password(username))
                self._conn.execute(
                    "INSERT INTO users (borrower_id, username, password_salt, password_hash,"
                    " group_name, must_change, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
                    (cur.lastrowid, username, salt, pwhash, m.group, _iso(date.today())),
                )
                created.append({"name": m.full_name, "username": username,
                                "default_password": default_password(username)})
            for bid, m in to_update:
                exists = self._conn.execute(
                    "SELECT 1 FROM users WHERE borrower_id=?", (bid,)
                ).fetchone()
                if exists is None:
                    username = self._unique_username(initials_username(m))
                    salt, pwhash = hash_password(default_password(username))
                    self._conn.execute(
                        "INSERT INTO users (borrower_id, username, password_salt, password_hash,"
                        " group_name, must_change, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
                        (bid, username, salt, pwhash, m.group, _iso(date.today())),
                    )
                    created.append({"name": m.full_name, "username": username,
                                    "default_password": default_password(username)})
                self._conn.execute(
                    "UPDATE borrowers SET name=?, first_name=?, last_name=?, department=?,"
                    " team=?, active=1 WHERE id=?",
                    (m.full_name, m.first_name, m.last_name, m.department, m.team, bid),
                )
                self._conn.execute(
                    "UPDATE users SET group_name=? WHERE borrower_id=?",
                    (m.group, bid),
                )
            for bid in to_deactivate:
                self._conn.execute("UPDATE borrowers SET active=0 WHERE id=?", (bid,))
            self._conn.commit()
        return created

    def delete_borrower(self, borrower_id: int) -> None:
        cur = self._run("DELETE FROM borrowers WHERE id=?", (borrower_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"borrower {borrower_id} not found")

    def clear_auth_data(self) -> None:
        """Remove loans, users and borrowers — used only during first-run setup.

        Before any login account exists the DB can only hold orphaned/demo data,
        so the uploaded team list is authoritative and replaces it.
        """
        with self._lock, self._conn:
            for table in ("loans", "users", "borrowers"):
                self._conn.execute(f"DELETE FROM {table}")
            self._conn.commit()

    def purge_all(self) -> None:
        """Erase every row in the database (temporary developer tool)."""
        with self._lock, self._conn:
            for table in ("loans", "users", "password_history", "borrowers", "books"):
                self._conn.execute(f"DELETE FROM {table}")
            try:
                self._conn.execute("DELETE FROM sqlite_sequence")
            except sqlite3.OperationalError:
                pass
            self._conn.commit()

    def count_users(self) -> int:
        return self._run("SELECT COUNT(*) FROM users").fetchone()[0]

    def count_admins(self) -> int:
        return self._run("SELECT COUNT(*) FROM users WHERE group_name='admin'").fetchone()[0]

    def user_by_username(self, username: str) -> SessionUser | None:
        row = self._run(
            """
            SELECT u.username, u.group_name, u.must_change, u.borrower_id,
                   b.name, b.active
            FROM users u JOIN borrowers b ON b.id = u.borrower_id
            WHERE u.username = ? COLLATE NOCASE
            """,
            (username.strip(),),
        ).fetchone()
        if row is None:
            return None
        return SessionUser(borrower_id=row["borrower_id"], username=row["username"],
                           name=row["name"], group_name=row["group_name"],
                           must_change=bool(row["must_change"]))

    def user_by_borrower(self, borrower_id: int) -> SessionUser | None:
        row = self._run(
            """
            SELECT u.username, u.group_name, u.must_change, u.borrower_id,
                   b.name, b.active
            FROM users u JOIN borrowers b ON b.id = u.borrower_id
            WHERE u.borrower_id = ?
            """,
            (borrower_id,),
        ).fetchone()
        if row is None:
            return None
        return SessionUser(borrower_id=row["borrower_id"], username=row["username"],
                           name=row["name"], group_name=row["group_name"],
                           must_change=bool(row["must_change"]))

    def insert_user(self, borrower_id: int, username: str, password: str,
                    group: str, *, must_change: bool = False) -> None:
        salt, pwhash = hash_password(password)
        self._run(
            "INSERT INTO users (borrower_id, username, password_salt, password_hash,"
            " group_name, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (borrower_id, username, salt, pwhash, group, int(must_change), _iso(date.today())),
        )

    def _remember_password(self, borrower_id: int, salt: str, pwhash: str, keep: int = 3) -> None:
        """Add a superseded password to the user's history, keeping the last `keep`."""
        self._conn.execute(
            "INSERT INTO password_history (borrower_id, password_salt, password_hash, created_at)"
            " VALUES (?, ?, ?, ?)",
            (borrower_id, salt, pwhash, _iso(date.today())),
        )
        self._conn.execute(
            "DELETE FROM password_history WHERE id NOT IN ("
            " SELECT id FROM password_history WHERE borrower_id=? ORDER BY id DESC LIMIT ?)",
            (borrower_id, keep),
        )

    def password_history_hashes(self, borrower_id: int, limit: int = 3) -> list[tuple[str, str]]:
        rows = self._run(
            "SELECT password_salt, password_hash FROM password_history"
            " WHERE borrower_id=? ORDER BY id DESC LIMIT ?",
            (borrower_id, limit),
        ).fetchall()
        return [(r["password_salt"], r["password_hash"]) for r in rows]

    def set_user_password(self, borrower_id: int, password: str) -> None:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT password_salt, password_hash FROM users WHERE borrower_id=?",
                (borrower_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"no login account for borrower {borrower_id}")
            self._remember_password(borrower_id, row["password_salt"], row["password_hash"])
            salt, pwhash = hash_password(password)
            self._conn.execute(
                "UPDATE users SET password_salt=?, password_hash=?, must_change=0"
                " WHERE borrower_id=?",
                (salt, pwhash, borrower_id),
            )
            self._conn.commit()

    def reset_user_password(self, borrower_id: int) -> str:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT username, password_salt, password_hash FROM users WHERE borrower_id=?",
                (borrower_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"no login account for borrower {borrower_id}")
            self._remember_password(borrower_id, row["password_salt"], row["password_hash"])
            default = default_password(row["username"])
            salt, pwhash = hash_password(default)
            self._conn.execute(
                "UPDATE users SET password_salt=?, password_hash=?, must_change=1"
                " WHERE borrower_id=?",
                (salt, pwhash, borrower_id),
            )
            self._conn.commit()
        return default

    def set_user_group(self, borrower_id: int, group: str) -> None:
        cur = self._run("UPDATE users SET group_name=? WHERE borrower_id=?",
                        (group, borrower_id))
        if cur.rowcount == 0:
            raise NotFoundError(f"no login account for borrower {borrower_id}")

    def user_borrower_id(self, username: str) -> int | None:
        row = self._run("SELECT borrower_id FROM users WHERE username=? COLLATE NOCASE",
                        (username.strip(),)).fetchone()
        return row["borrower_id"] if row is not None else None

    def create_loan(self, book_id: int, borrower_id: int, borrow_date: date) -> Loan:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT total_copies, discontinued FROM books WHERE id=?", (book_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"book {book_id} not found")
            if row["discontinued"]:
                raise InsufficientCopiesError("this book is marked Not Available")
            borrower = self._conn.execute(
                "SELECT id, active FROM borrowers WHERE id=?", (borrower_id,)
            ).fetchone()
            if borrower is None:
                raise NotFoundError(f"borrower {borrower_id} not found")
            if not borrower["active"]:
                raise InsufficientCopiesError(
                    "this person is not an active team member (upload the current team list)"
                )
            active = self._conn.execute(
                "SELECT COUNT(*) FROM loans WHERE book_id=? AND return_date IS NULL", (book_id,)
            ).fetchone()[0]
            if active >= row["total_copies"]:
                raise InsufficientCopiesError(
                    f"all {row['total_copies']} copy/copies of this book are already borrowed"
                )
            cur = self._conn.execute(
                "INSERT INTO loans (book_id, borrower_id, borrow_date) VALUES (?, ?, ?)",
                (book_id, borrower_id, _iso(borrow_date)),
            )
            self._conn.commit()
            return Loan(id=cur.lastrowid, book_id=book_id, borrower_id=borrower_id,
                        borrow_date=borrow_date)

    def return_loan(self, loan_id: int, return_date: date, remarks: str = "") -> Loan:
        with self._lock, self._conn:
            row = self._conn.execute("SELECT * FROM loans WHERE id=?", (loan_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"loan {loan_id} not found")
            if row["return_date"] is not None:
                raise RepositoryError(f"loan {loan_id} is already returned")
            self._conn.execute(
                "UPDATE loans SET return_date=?, remarks=? WHERE id=?",
                (_iso(return_date), remarks, loan_id),
            )
            self._conn.commit()
            return Loan(id=loan_id, book_id=row["book_id"], borrower_id=row["borrower_id"],
                        borrow_date=_parse(row["borrow_date"]), return_date=return_date, remarks=remarks)

    def update_loan_remarks(self, loan_id: int, remarks: str) -> None:
        cur = self._run("UPDATE loans SET remarks=? WHERE id=?", (remarks, loan_id))
        if cur.rowcount == 0:
            raise NotFoundError(f"loan {loan_id} not found")

    def clear_active_loans(self, book_id: int, return_date: date) -> int:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE loans SET return_date=? WHERE book_id=? AND return_date IS NULL",
                (_iso(return_date), book_id),
            )
            self._conn.commit()
            return cur.rowcount

    def list_loans(self, include_returned: bool = True) -> list[LoanView]:
        where = "" if include_returned else "WHERE l.return_date IS NULL"
        rows = self._run(
            f"""
            SELECT l.*, b.title AS book_title, br.name AS borrower_name
            FROM loans l
            JOIN books b ON b.id = l.book_id
            JOIN borrowers br ON br.id = l.borrower_id
            {where}
            ORDER BY CASE WHEN l.return_date IS NULL THEN 0 ELSE 1 END, l.id DESC
            """
        ).fetchall()
        return [LoanView(id=r["id"], book_id=r["book_id"], book_title=r["book_title"],
                         borrower_id=r["borrower_id"], borrower_name=r["borrower_name"],
                         borrow_date=_parse(r["borrow_date"]), return_date=_parse(r["return_date"]),
                         remarks=r["remarks"]) for r in rows]

    def active_loan_count(self, book_id: int) -> int:
        row = self._run(
            "SELECT COUNT(*) FROM loans WHERE book_id=? AND return_date IS NULL", (book_id,)
        ).fetchone()
        return row[0]

    def borrower_loan_count(self, borrower_id: int) -> int:
        row = self._run("SELECT COUNT(*) FROM loans WHERE borrower_id=?", (borrower_id,)).fetchone()
        return row[0]


# ---------------------------------------------------------------------------
# BUSINESS LOGIC
# ---------------------------------------------------------------------------
class Library:
    def __init__(self, repo: Repository):
        self.repo = repo

    def add_book(self, title: str, *, author: str = "", publisher: str = "",
                 isbn: str = "", total_copies: int = 1, cost: float = 0.0,
                 added_at: date | None = None) -> Book:
        title = title.strip()
        if not title:
            raise ValidationError("title is required")
        if total_copies < 0:
            raise ValidationError("total copies cannot be negative")
        if cost < 0:
            raise ValidationError("cost cannot be negative")
        return self.repo.add_book(
            Book(title=title, author=author.strip(), publisher=publisher.strip(),
                 isbn=isbn.strip(), total_copies=total_copies, cost=cost, added_at=added_at)
        )

    def update_book(self, book: Book) -> Book:
        if book.id is None:
            raise ValidationError("book id is required")
        if not book.title.strip():
            raise ValidationError("title is required")
        if book.cost < 0:
            raise ValidationError("cost cannot be negative")
        existing = self.repo.get_book(book.id)
        if book.discontinued:
            book.total_copies = 0
        else:
            active = self.repo.active_loan_count(book.id)
            if book.total_copies < active:
                raise ValidationError(f"cannot set copies below the {active} currently borrowed")
        return self.repo.update_book(book)

    def set_discontinued(self, book_id: int, discontinued: bool) -> Book:
        book = self.repo.get_book(book_id)
        book.discontinued = discontinued
        return self.update_book(book)

    def get_books(self, search: str = "") -> list[BookView]:
        books = self.repo.list_books()
        if search.strip():
            needle = search.strip().lower()
            books = [b for b in books
                     if needle in b.title.lower() or needle in b.author.lower()
                     or needle in b.publisher.lower() or needle in b.isbn.lower()
                     or needle in b.borrower_label.lower()]
        return books

    def get_book_view(self, book_id: int) -> BookView:
        for view in self.repo.list_books():
            if view.id == book_id:
                return view
        raise ValidationError(f"book {book_id} not found")

    def get_book(self, book_id: int) -> Book:
        return self.repo.get_book(book_id)

    def add_borrower(self, name: str, *, phone: str = "", email: str = "",
                     joined_at: date | None = None) -> Borrower:
        name = name.strip()
        if not name:
            raise ValidationError("name is required")
        return self.repo.add_borrower(
            Borrower(name=name, phone=phone.strip(), email=email.strip(), joined_at=joined_at)
        )

    def delete_borrower(self, borrower_id: int) -> None:
        borrowed_now = [v for v in self.get_active_loans() if v.borrower_id == borrower_id]
        if borrowed_now:
            raise ValidationError(
                f"cannot delete: {len(borrowed_now)} copy/copies still issued to this borrower"
            )
        if self.repo.borrower_loan_count(borrower_id) > 0:
            raise ValidationError("cannot delete a borrower with loan history — deleting would erase the records")
        self.repo.delete_borrower(borrower_id)

    def get_borrowers(self, search: str = "", active_only: bool = False) -> list[Borrower]:
        people = self.repo.list_borrowers(active_only=active_only)
        needle = " ".join(search.strip().lower().split())
        if needle:
            people = [p for p in people
                      if needle in " ".join(p.name.lower().split())
                      or needle in " ".join(p.department.lower().split())
                      or needle in " ".join(p.team.lower().split())]
        return people

    def _team_map(self) -> tuple[dict[str, Borrower], list[Borrower]]:
        by_key: dict[str, Borrower] = {}
        for p in self.repo.list_borrowers():
            by_key.setdefault(p.name.lower(), p)
        return by_key, list(by_key.values())

    def plan_sync(self, members: list[TeamMember]) -> dict:
        """Preview what an upload would add/update/remove (applies nothing)."""
        by_key, _ = self._team_map()
        new_keys = {m.key for m in members}
        missing = [k for k in by_key if k not in new_keys and by_key[k].active]
        active_loans = self.get_active_loans()
        blocked = [(by_key[k].name,
                    [v.book_title for v in active_loans if v.borrower_id == by_key[k].id])
                   for k in missing
                   if any(v.borrower_id == by_key[k].id for v in active_loans)]
        return {
            "members": len(members),
            "added": sum(1 for m in members if m.key not in by_key),
            "updated": sum(1 for m in members if m.key in by_key),
            "to_remove": len(missing),
            "removed_blocked": blocked,
        }

    def sync_team(self, members: list[TeamMember], *, keep_user_id: int | None = None) -> dict:
        """Apply a team-file upload.

        Any member with borrowed books blocks the whole update — but only once
        real login users exist. With zero user accounts the borrowers are
        leftover/imported data with no owner, so removals are not blocked.
        The caller's own account (keep_user_id) cannot be removed by their own upload.
        """
        by_key, _ = self._team_map()
        new_keys = {m.key for m in members}
        to_add = [m for m in members if m.key not in by_key]
        to_update = [(by_key[m.key].id, m) for m in members if m.key in by_key]
        to_deactivate = [by_key[k].id for k in by_key if k not in new_keys and by_key[k].active]
        active_loans = self.get_active_loans() if self.repo.count_users() > 0 else []
        blocked = [(by_key[k].name,
                    [v.book_title for v in active_loans if v.borrower_id == by_key[k].id])
                   for k in by_key if k not in new_keys
                   and any(v.borrower_id == by_key[k].id for v in active_loans)]
        if keep_user_id is not None and keep_user_id in to_deactivate:
            blocked.append(("your own account", ["you cannot remove yourself while logged in"]))
        if blocked:
            detail = "\n".join(f"• {name} — currently borrowed: {', '.join(books)}"
                                for name, books in blocked)
            raise ValidationError(
                "Team list not updated. These members still have borrowed books:\n"
                f"{detail}\n\nReturn the book(s) first, then upload the file again."
            )
        created = self.repo.apply_team(to_add, to_update, to_deactivate)
        return {"added": len(to_add), "updated": len(to_update),
                "removed": len(to_deactivate), "created": created}

    def get_borrower(self, borrower_id: int) -> Borrower:
        return self.repo.get_borrower(borrower_id)

    def login_user(self, username: str, password: str) -> SessionUser:
        user = self.repo.user_by_username(username)
        if user is None:
            raise ValidationError("invalid username or password")
        row = self.repo._run(
            "SELECT password_salt, password_hash, active FROM users"
            " JOIN borrowers ON borrowers.id = users.borrower_id"
            " WHERE users.username = ? COLLATE NOCASE",
            (user.username,),
        ).fetchone()
        if not verify_password(password, row["password_salt"], row["password_hash"]):
            raise ValidationError("invalid username or password")
        if not row["active"]:
            raise ValidationError("this account has been deactivated (no longer in the team list)")
        return user

    def change_password(self, user: SessionUser, old_password: str, new_password: str) -> None:
        row = self.repo._run(
            "SELECT username, password_salt, password_hash FROM users WHERE borrower_id=?",
            (user.borrower_id,),
        ).fetchone()
        if row is None:
            raise ValidationError("no login account found for this borrower")
        if not verify_password(old_password, row["password_salt"], row["password_hash"]):
            raise ValidationError("current password is incorrect")
        borrower = self.repo.get_borrower(user.borrower_id)
        validate_new_password(new_password, first_name=borrower.first_name,
                              last_name=borrower.last_name, username=row["username"])
        if new_password == default_password(row["username"]):
            raise ValidationError("the new password cannot be the same as the initial password")
        if verify_password(new_password, row["password_salt"], row["password_hash"]):
            raise ValidationError("the new password must be different from your current password")
        for salt, pwhash in self.repo.password_history_hashes(user.borrower_id):
            if verify_password(new_password, salt, pwhash):
                raise ValidationError("the new password cannot be one of your last 3 passwords")
        self.repo.set_user_password(user.borrower_id, new_password)

    def admin_reset_password(self, target_borrower_id: int) -> str:
        return self.repo.reset_user_password(target_borrower_id)

    def admin_set_group(self, target_borrower_id: int, group: str) -> None:
        if group not in GROUPS:
            raise ValidationError(f"unknown group: {group}")
        self.repo.set_user_group(target_borrower_id, group)

    def create_first_admin(self, first: str, last: str, username: str, password: str) -> SessionUser:
        """Create the very first admin (used when no admin exists yet)."""
        if self.repo.count_admins() > 0:
            raise ValidationError("an administrator already exists — sign in or use the Team tab")
        username = username.strip().upper()
        if not username:
            raise ValidationError("username is required")
        if self.repo.user_by_username(username) is not None:
            raise ValidationError("username already taken")
        validate_new_password(password, first_name=first, last_name=last, username=username)
        borrower = self.repo.add_borrower(Borrower(
            name=f"{first.strip()} {last.strip()}".strip(), first_name=first.strip(),
            last_name=last.strip(), phone="", email="",
        ))
        self.repo.insert_user(borrower.id, username, password, GROUP_ADMIN)
        return SessionUser(borrower_id=borrower.id, username=username,
                           name=borrower.name, group_name=GROUP_ADMIN)

    def setup_first_team(self, members: list[TeamMember]) -> dict:
        """Bootstrap CALibr from a team file when no users exist yet.

        Every member gets a login account; members in the admin group become
        administrators. No login account exists yet, so the file is authoritative:
        any pre-existing (orphaned/demo) loans and borrowers are cleared first,
        and the old "cannot remove a member with borrowed books" guard is skipped.
        Refuses to run once any user already exists.
        """
        if self.repo.count_users() > 0:
            raise ValidationError("users already exist — sign in and use the Team tab")
        if not any(m.group == GROUP_ADMIN for m in members):
            raise ValidationError("the uploaded file has no one in the admin group")
        self.repo.clear_auth_data()
        return self.sync_team(members)

    def own_loans(self, borrower_id: int) -> list[LoanView]:
        return [v for v in self.repo.list_loans(include_returned=False)
                if v.borrower_id == borrower_id]

    def borrow(self, book_id: int, borrower_id: int, *, borrow_date: date | None = None) -> Loan:
        borrow_date = borrow_date or date.today()
        view = self.get_book_view(book_id)
        if view.discontinued:
            raise ValidationError("this book is marked Not Available")
        if view.available_copies <= 0:
            raise ValidationError("no copies of this book are available")
        try:
            return self.repo.create_loan(book_id, borrower_id, borrow_date)
        except (InsufficientCopiesError, NotFoundError) as exc:
            raise ValidationError(str(exc)) from exc

    def return_book(self, loan_id: int, *, return_date: date | None = None, remarks: str = "") -> Loan:
        return self.repo.return_loan(loan_id, return_date or date.today(), remarks.strip())

    def update_remarks(self, loan_id: int, remarks: str) -> None:
        self.repo.update_loan_remarks(loan_id, remarks.strip())

    def clear_borrower(self, book_id: int, *, return_date: date | None = None) -> int:
        return self.repo.clear_active_loans(book_id, return_date or date.today())

    def get_active_loans(self) -> list[LoanView]:
        return list(self.repo.list_loans(include_returned=False))

    def get_loan_history(self) -> list[LoanView]:
        return self.repo.list_loans(include_returned=True)

    def stats(self) -> dict:
        books = self.repo.list_books()
        active = self.repo.list_loans(include_returned=False)
        returned = [v for v in self.repo.list_loans(include_returned=True) if v.return_date is not None]
        noted = [v for v in returned if v.remarks.strip()]
        return {
            "books": len(books),
            "total_copies": sum(b.total_copies for b in books),
            "available_copies": sum(b.available_copies for b in books),
            "borrowed_copies": len(active),
            "returned_loans": len(returned),
            "returns_with_remarks": len(noted),
            "discontinued_books": sum(1 for b in books if b.discontinued),
            "borrowers": len(self.repo.list_borrowers(active_only=True)),
            "inventory_value": round(sum(b.total_copies * b.cost for b in books), 2),
        }

    def seed_demo_data(self) -> None:
        if self.repo.list_books():
            return
        demo_books = [
            Book(title="Clean Code", author="Robert C. Martin", publisher="Prentice Hall",
                 isbn="9780132350884", total_copies=2, cost=39.99),
            Book(title="The Pragmatic Programmer", author="Andrew Hunt & David Thomas",
                 publisher="Addison-Wesley", isbn="9780201616224", total_copies=1, cost=49.99),
            Book(title="Design Patterns", author="Erich Gamma et al.",
                 publisher="Addison-Wesley", isbn="9780201633610", total_copies=2, cost=54.99),
            Book(title="Refactoring", author="Martin Fowler", publisher="Addison-Wesley",
                 isbn="9780134757599", total_copies=1, cost=44.99),
            Book(title="You Don't Know JS", author="Kyle Simpson", publisher="O'Reilly",
                 isbn="9781491904158", total_copies=3, cost=29.99),
        ]
        people = [
            Borrower(name="Alice Sharma", first_name="Alice", last_name="Sharma",
                     department="Finance", team="Audit",
                     phone="555-0101", email="alice@example.com"),
            Borrower(name="Bob Singh", first_name="Bob", last_name="Singh",
                     department="Tax", team="Taxation",
                     phone="555-0102", email="bob@example.com"),
            Borrower(name="Carol Das", first_name="Carol", last_name="Das",
                     department="Finance", team="Consulting",
                     phone="555-0103", email="carol@example.com"),
        ]
        for b in demo_books:
            self.repo.add_book(b)
        borrowers = []
        for p in people:
            borrowers.append(self.repo.add_borrower(p))
        alice, bob, carol = borrowers
        self.repo.insert_user(alice.id, "ASH", default_password("ASH"), GROUP_ADMIN,
                              must_change=True)
        self.repo.insert_user(bob.id, "BSI", default_password("BSI"), GROUP_POWER,
                              must_change=True)
        self.repo.insert_user(carol.id, "CDA", default_password("CDA"), GROUP_GENERAL,
                              must_change=True)
        self.borrow(1, 1)
        self.borrow(3, 2)
        loan = self.borrow(2, 3)
        self.return_book(loan.id, remarks="coffee stain on pages 40-45")
        self.set_discontinued(4, True)


# ---------------------------------------------------------------------------
# TEAM LIST PARSING (Excel via pandas + openpyxl)
# ---------------------------------------------------------------------------
_HEADER_ALIASES = {
    "first_name": {"first name", "first", "firstname", "given name", "fname"},
    "last_name": {"last name", "last", "lastname", "surname", "family name", "lname"},
    "department": {"department", "dept", "department name", "dept name", "division", "business unit",
                   "business unit", "bu", "function", "unit"},
    "team": {"team", "team name", "work team", "work group", "stream", "sub team", "squad"},
    "group": {"group", "user group", "usergroup", "access group", "access", "user role",
              "permission", "role group", "security group", "role"},
}


def _norm_header(value) -> str:
    return str(value).strip().lower().replace("_", " ").replace("-", " ")


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        if value != value:  # NaN from an empty Excel cell
            return ""
        if value.is_integer():
            return str(int(value))
    return str(value).strip()


def parse_team_excel(data: bytes) -> list[TeamMember]:
    try:
        df = pd.read_excel(BytesIO(data), engine="openpyxl")
    except Exception as exc:
        raise ValidationError(f"could not read the Excel file: {exc}") from exc
    if df is None or df.empty:
        raise ValidationError("the Excel file has no rows")

    col: dict[str, str] = {}
    for raw in df.columns:
        key = _norm_header(raw)
        for field, aliases in _HEADER_ALIASES.items():
            if key in aliases:
                col.setdefault(field, raw)
                break
    if not {"first_name", "last_name"} <= set(col):
        raise ValidationError(
            "the Excel file needs First Name & Last Name columns\n"
            "Recognized header names:\n"
            + ", ".join(sorted({a for aliases in _HEADER_ALIASES.values() for a in aliases}))
            + "\nColumns: FirstName, LastName, Department, Team, UserGroup"
        )

    members: list[TeamMember] = []
    problems: list[str] = []
    seen: set[str] = set()
    for idx, row in df.iterrows():
        raw = {f: _cell(row[col[f]]) for f in col}
        first, last = raw.get("first_name", ""), raw.get("last_name", "")
        if not first and not last:
            continue
        group = raw.get("group", "").strip().lower()
        if group and group not in GROUPS:
            problems.append(f"row {idx + 2}: invalid group “{group}” (choose one of: "
                            + ", ".join(GROUPS) + ")")
            continue
        member = TeamMember(
            first_name=first or "", last_name=last or "",
            department=raw.get("department", ""), team=raw.get("team", ""),
            group=group or GROUP_GENERAL,
        )
        if not member.first_name and not member.last_name:
            problems.append(f"row {idx + 2}: missing name")
            continue
        if not member.full_name:
            problems.append(f"row {idx + 2}: has no usable name")
            continue
        if member.key in seen:
            problems.append(f"row {idx + 2}: duplicate member “{member.full_name}”")
        seen.add(member.key)
        members.append(member)
    if not members and not problems:
        problems.append("no data rows found")
    if problems:
        raise ValidationError("Issue(s) in the Excel file:\n" + "\n".join(f"• {p}" for p in problems))
    return members


def team_template_bytes() -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Team"
    ws.append(["FirstName", "LastName", "Department", "Team", "UserGroup"])
    ws.append(["Ada", "Lovelace", "Finance", "Audit", "admin"])
    ws.append(["Alan", "Turing", "IT", "Consulting", "power"])
    ws.append(["Grace", "Hopper", "Finance", "Operations", "general"])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# STREAMLIT UI
# ---------------------------------------------------------------------------
st.set_page_config(page_title="CALibr · Library Manager", page_icon="📚", layout="wide")


@st.cache_resource
def get_library() -> Library:
    return Library(Repository(DB_PATH))


lib = get_library()

SESSION_USER_KEY = "calibr_user"


def get_session_user() -> SessionUser | None:
    data = st.session_state.get(SESSION_USER_KEY)
    return SessionUser(**data) if data else None


def _set_session_user(user: SessionUser) -> None:
    st.session_state[SESSION_USER_KEY] = asdict(user)


st.title("📚 CALibr — Library Management")
st.caption("No due dates. Register-style tracking with Not Available / discontinued support.")


def flash(exc: Exception) -> None:
    st.error(f"{type(exc).__name__}: {exc}")


def fmt(value) -> str:
    return value.isoformat() if value else "--"


def _password_help() -> str:
    return (f"8–20 characters, at least 1 uppercase, 1 lowercase, 1 digit and 1 special "
            f"character. Must not contain your first or last name or login ID (the initial "
            f"password is exempt), must not contain an email address, must not be the initial "
            f"password, and cannot be one of your last 3 passwords.")


def render_login() -> SessionUser | None:
    setup = st.session_state.get("first_run_done")
    if setup:
        st.success(f"🎉 Library set up: {setup['users']} user(s) created, "
                   f"{setup['admins']} of them **admin**.")
        st.info("Sign in with your initial password, e.g. for **John Doe** the ID is "
                f"**`JDO`** and the initial password is **`JDO{DEFAULT_PASSWORD_SUFFIX}`** "
                "(must change on first login).")
    st.header("🔐 Sign in")
    with st.form("login"):
        uid = st.text_input("Login ID", placeholder="e.g. JDO (from the team file)")
        pwd = st.text_input("Password", type="password")
        if st.form_submit_button("Sign in"):
            if not uid.strip() or not pwd:
                st.error("Enter your login ID and password.")
                return None
            try:
                return lib.login_user(uid, pwd)
            except Exception as exc:
                st.error(str(exc))
                return None
    st.info(f"First time? Your login ID is the 1st letter of your first name plus the first 2 "
            f"letters of your last name (e.g. John Doe → **JDO**). The initial password is your "
            f"ID followed by `{DEFAULT_PASSWORD_SUFFIX}` (e.g. `JDO{DEFAULT_PASSWORD_SUFFIX}`). "
            "You will be asked to set your own password on first sign-in.")
    return None


def render_first_run() -> SessionUser | None:
    st.header("🚀 First-time setup")
    st.caption(f"Upload the team list (Excel) to set up CALibr. Everyone marked in the "
               f"**admin** group of the **UserGroup** column becomes an administrator.")
    uploaded = st.file_uploader("Upload team list (.xlsx)", type=["xlsx"], key="first_run_upload")
    if uploaded is not None:
        try:
            members = parse_team_excel(uploaded.getvalue())
        except Exception as exc:
            st.error(str(exc))
            return None
        st.dataframe(pd.DataFrame([asdict(m) for m in members]),
                     use_container_width=True, hide_index=True)
        admins = [m for m in members if m.group == GROUP_ADMIN]
        if not admins:
            st.warning(f"No one in the **admin** group was found in this file — create the first "
                       "administrator below. You can upload the full team list afterwards from "
                       "the Team tab.")
            return render_first_admin_form()
        if st.button("✔️ Create the library & admin accounts", type="primary"):
            try:
                summary = lib.setup_first_team(members)
                st.session_state["first_run_done"] = {
                    "users": summary["added"],
                    "admins": len(admins),
                }
                st.rerun()
            except Exception as exc:
                st.error(str(exc))
    return None


def render_first_admin_form() -> SessionUser | None:
    st.subheader("👑 Create the first administrator")
    st.caption("Set up one administrator account. Once signed in, upload the full team list from "
               "the Team tab.")
    with st.form("bootstrap"):
        b1, b2 = st.columns(2)
        bf = b1.text_input("First name *")
        bl = b2.text_input("Last name *")
        suggested = username_from_names(bf, bl) if (bf.strip() or bl.strip()) else ""
        bu = st.text_input("Login ID *", value=suggested or "")
        st.caption(f"Suggested ID for this name: `{suggested or '—'}`")
        bp = st.text_input("Password *", type="password")
        bp2 = st.text_input("Confirm password *", type="password")
        if st.form_submit_button("Create administrator"):
            if bp != bp2:
                st.error("Passwords do not match.")
                return None
            try:
                return lib.create_first_admin(bf, bl, bu, bp)
            except Exception as exc:
                st.error(str(exc))
                return None
    st.info("Password rules: " + _password_help())
    return None


def render_forced_change(user: SessionUser) -> None:
    st.header("🔑 Set your own password")
    st.warning(f"Welcome, {user.name}! You signed in with the initial password and need to "
               "choose a personal one.")
    with st.form("force_pw"):
        c1, c2 = st.columns(2)
        np1 = c1.text_input("New password *", type="password")
        np2 = c2.text_input("Confirm new password *", type="password")
        if st.form_submit_button("Save password"):
            if np1 != np2:
                st.error("Passwords do not match.")
                return
            try:
                lib.change_password(user, default_password(user.username), np1)
                _set_session_user(SessionUser(borrower_id=user.borrower_id,
                                              username=user.username, name=user.name,
                                              group_name=user.group_name, must_change=False))
                st.success("Password saved.")
                st.rerun()
            except Exception as exc:
                st.error(str(exc))
    st.info("Password rules: " + _password_help())


user = get_session_user()
if user is None:
    user = render_first_run() if lib.repo.count_users() == 0 else render_login()
    if user is not None:
        _set_session_user(user)

if user is None:
    st.stop()

# The DB is the source of truth for must_change. Refresh the session user so a
# password changed via any form (forced or sidebar) never loops back onto the
# forced first-login screen.
live = lib.repo.user_by_borrower(user.borrower_id)
if live is not None and live.must_change != user.must_change:
    user = live
    _set_session_user(user)

with st.sidebar:
    st.caption(f"👤 **{user.name}**  \nGroup: **{user.group_name}** · ID: `{user.username}`")
    if st.button("🚪 Sign out", use_container_width=True):
        st.session_state.pop(SESSION_USER_KEY, None)
        st.rerun()
    if user.group_name == GROUP_ADMIN:
        with st.expander("🧰 Developer tools", expanded=False):
            st.caption("Temporary — remove before production.")
            confirm = st.text_input('Type "PURGE" to wipe the whole database',
                                    key="purge_confirm")
            if st.button("🗑️ Purge database", use_container_width=True):
                if confirm.strip().upper() != "PURGE":
                    st.error("Type PURGE to confirm.")
                else:
                    lib.repo.purge_all()
                    st.session_state.pop(SESSION_USER_KEY, None)
                    st.session_state.pop("first_run_done", None)
                    st.rerun()
    with st.expander("Change my password", expanded=False):
        if not user.must_change:
            with st.form("pw_change"):
                old_pw = st.text_input("Current password", type="password", key="pw_old")
                new_pw = st.text_input("New password", type="password", key="pw_new")
                if st.form_submit_button("Update password"):
                    try:
                        lib.change_password(user, old_pw, new_pw)
                        st.success("Password updated.")
                        st.rerun()
                    except Exception as exc:
                        st.error(str(exc))

if user.must_change:
    render_forced_change(user)
    st.stop()

if user.group_name == GROUP_GENERAL:
    st.header("📕 My borrowed books")
    mine = lib.own_loans(user.borrower_id)
    if mine:
        rows = [{"Book": v.book_title, "Borrow Date": fmt(v.borrow_date)} for v in mine]
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
    else:
        st.success("You have no books borrowed right now.")
    st.stop()

can_edit = user.group_name == GROUP_ADMIN
if not can_edit:
    st.caption("🔍 View-only access (Power group): you can view the whole library but cannot "
               "make changes.")

tab_dash, tab_books, tab_people, tab_loans = st.tabs(
    ["📊 Dashboard", "📚 Books", "👥 Team", "🔁 Loans"]
)

with tab_dash:
    stats = lib.stats()
    c1, c2, c3, c4, c5, c6 = st.columns(6)
    c1.metric("Books", stats["books"])
    c2.metric("Copies", stats["total_copies"])
    c3.metric("Available", stats["available_copies"])
    c4.metric("Borrowed", stats["borrowed_copies"])
    c5.metric("Not Available", stats["discontinued_books"])
    c6.metric("Borrowers", stats["borrowers"])

    col_a, col_b = st.columns(2)
    with col_a:
        st.subheader(f"📤 Currently out ({stats['borrowed_copies']})")
        active = lib.get_active_loans()
        if active:
            rows = [{"Book": v.book_title, "Borrower": v.borrower_name,
                     "Borrow Date": v.borrow_date, "Return Date": fmt(v.return_date),
                     "Remarks": v.remarks} for v in active]
            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        else:
            st.success("Every copy is on the shelf.")
    with col_b:
        st.subheader(f"⚠️ Returns with remarks ({stats['returns_with_remarks']})")
        noted = [v for v in lib.get_loan_history() if v.remarks]
        if noted:
            rows = [{"Book": v.book_title, "Borrower": v.borrower_name,
                     "Return Date": fmt(v.return_date), "Remarks": v.remarks} for v in noted]
            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        else:
            st.info("No remarks on any return.")

    with st.expander("Inventory value & activity"):
        m1, m2, m3 = st.columns(3)
        m1.metric("Inventory value", f"{stats['inventory_value']:,.2f}")
        m2.metric("Returned so far", stats["returned_loans"])
        m3.metric("Not available", stats["discontinued_books"])

    if ALLOW_DEMO_DATA and can_edit:
        if st.button("Load demo data (only if empty)", key="seed_demo"):
            with st.spinner("Seeding…"):
                lib.seed_demo_data()
            st.cache_resource.clear()
            st.rerun()


with tab_books:
    if can_edit:
        st.subheader("➕ Add book")
        with st.form("add_book", clear_on_submit=True):
            fc1, fc2 = st.columns(2)
            title = fc1.text_input("Title *")
            author = fc2.text_input("Author")
            fc3, fc4 = st.columns(2)
            publisher = fc3.text_input("Publisher")
            isbn = fc4.text_input("ISBN") if TRACK_ISBN else ""
            fc5, fc6 = st.columns(2)
            copies = fc5.number_input("Total copies", min_value=0, value=1, step=1) if TRACK_COPIES else 1
            cost = fc6.number_input("Cost", min_value=0.0, value=0.0, step=0.01) if TRACK_COST else 0.0
            if st.form_submit_button("Add"):
                try:
                    lib.add_book(title, author=author, publisher=publisher,
                                 isbn=isbn if TRACK_ISBN else "",
                                 total_copies=int(copies) if TRACK_COPIES else 1,
                                 cost=cost if TRACK_COST else 0.0)
                    st.success("Book added.")
                    st.rerun()
                except Exception as exc:
                    flash(exc)

    st.divider()
    st.subheader("🗂️ Register")
    search = st.text_input("Search title / author / publisher / ISBN / borrower", key="book_search")
    books = lib.get_books(search)
    if books:
        rows = [{
            "ID": b.id, "Title": b.title, "Author": b.author, "Publisher": b.publisher,
            "ISBN": b.isbn, "Copies": b.total_copies, "Status": b.status,
            "Borrower": b.borrower_label, "Borrow Date": fmt(b.borrow_date),
            "Return Date": fmt(b.return_date), "Remarks": b.remarks, "Cost": b.cost,
        } for b in books]
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

        if can_edit:
            with st.expander("✏️ Edit book · mark Not Available · update remarks"):
                options = {f"#{b.id} · {b.title}": b.id for b in books}
                choice = st.selectbox("Select book", list(options), key="book_select")
                book = lib.get_book(options[choice])
                view = next(v for v in books if v.id == book.id)

                ef1, ef2 = st.columns(2)
                new_title = ef1.text_input("Title", value=book.title)
                new_author = ef2.text_input("Author", value=book.author)
                ef3, ef4 = st.columns(2)
                new_pub = ef3.text_input("Publisher", value=book.publisher)
                new_isbn = ef4.text_input("ISBN", value=book.isbn) if TRACK_ISBN else book.isbn
                ef5, ef6 = st.columns(2)
                new_copies = ef5.number_input("Total copies", min_value=0, value=int(book.total_copies),
                                              step=1, disabled=book.discontinued) if TRACK_COPIES else book.total_copies
                new_cost = ef6.number_input("Cost", min_value=0.0, value=float(book.cost), step=0.01) \
                    if TRACK_COST else book.cost

                discontinued = st.checkbox("Discontinued / Not Available (sets copies to 0)",
                                           value=book.discontinued)
                if discontinued:
                    st.warning("This book will be marked Not Available with 0 copies. Any copy still "
                               "out stays with its borrower until physically returned.")

                st.markdown(f"**Current borrower:** {view.borrower_label}"
                            + (f" · borrowed {fmt(view.borrow_date)}" if view.borrow_date else ""))
                remarks = st.text_area("Remarks / live operations note (e.g. damage, follow-up)",
                                       value=view.remarks, disabled=view.loan_id is None,
                                       placeholder="No active loan — use the Return flow in the Loans tab."
                                       if view.loan_id is None else "")

                b1, b2 = st.columns(2)
                if b1.button("💾 Save changes"):
                    try:
                        book.title = new_title
                        book.author = new_author
                        book.publisher = new_pub
                        book.isbn = new_isbn
                        book.total_copies = int(new_copies) if TRACK_COPIES else book.total_copies
                        book.cost = new_cost
                        book.discontinued = discontinued
                        lib.update_book(book)
                        if view.loan_id is not None:
                            lib.update_remarks(view.loan_id, remarks)
                        st.success("Saved.")
                        st.rerun()
                    except Exception as exc:
                        flash(exc)
                if view.loan_id is not None:
                    if b2.button("✅ Copy returned — mark borrower as --"):
                        try:
                            count = lib.clear_borrower(book.id)
                            st.success(f"Closed {count} loan(s). Borrower is now --.")
                            st.rerun()
                        except Exception as exc:
                            flash(exc)
    else:
        st.info("No books match your search.")


with tab_people:
    st.subheader("👥 Team members (valid borrowers & login users)")
    st.caption("Borrowers = team members from the uploaded Excel file, each with a **login ID**, "
               "a **group** (admin / power / general) and an initial password. Re-uploading "
               "updates membership — a member with borrowed books cannot be removed.")

    if can_edit:
        c_up, c_tpl = st.columns([3, 1])
        with c_up:
            uploaded = st.file_uploader("Upload team list (.xlsx)", type=["xlsx"])
        with c_tpl:
            st.download_button("📥 Download Excel template",
                               data=team_template_bytes(),
                               file_name="calibr_team_template.xlsx",
                               mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

        if uploaded is not None:
            try:
                members = parse_team_excel(uploaded.getvalue())
            except Exception as exc:
                st.error(str(exc))
                members = None
            if members:
                plan = lib.plan_sync(members)
                st.write(f"📄 {plan['members']} member(s) read — {plan['added']} new, "
                         f"{plan['updated']} updated, {plan['to_remove']} removed.")
                groups = pd.DataFrame([asdict(m) for m in members])
                st.dataframe(pd.DataFrame([asdict(m) for m in members]),
                             use_container_width=True, hide_index=True)
                if plan["removed_blocked"]:
                    detail = "\n".join(f"• {name} — currently borrowed: {', '.join(books)}"
                                        for name, books in plan["removed_blocked"])
                    st.error("This update cannot be applied. The following members still have "
                             "borrowed books and cannot be removed:\n\n" + detail +
                             "\n\nReturn the book(s) first, then upload the file again.")
                else:
                    if st.button("✔️ Apply team update", type="primary"):
                        try:
                            summary = lib.sync_team(members, keep_user_id=user.borrower_id)
                            st.success(f"Team updated: {summary['added']} added, "
                                       f"{summary['updated']} updated, {summary['removed']} removed.")
                            if summary["created"]:
                                creds = "\n".join(
                                    f"• {c['name']} → ID **`{c['username']}`**, initial password "
                                    f"**`{c['default_password']}`** (must change on first login)"
                                    for c in summary["created"])
                                st.info("New login accounts:\n\n" + creds)
                            st.rerun()
                        except Exception as exc:
                            flash(exc)

    st.divider()
    st.subheader("Current team")
    search_t = st.text_input("Search name / department / team", key="team_search")
    team = lib.get_borrowers(search_t)
    if team:
        active_loans = lib.get_active_loans()
        rows = []
        for p in team:
            borrowed = [v.book_title for v in active_loans if v.borrower_id == p.id]
            rows.append({
                "ID": p.id, "Name": p.name, "Department": p.department, "Team": p.team,
                "Borrowed": ", ".join(borrowed) if borrowed else "--",
                "Status": "Active" if p.active else "Removed",
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
    else:
        st.info("No team members yet — upload the team Excel file above.")

    if can_edit:
        with st.expander("⚙️ Admin: user maintenance (reset password · change group)"):
            opts = {f"#{p.id} · {p.name} ({p.department} · {p.team})": p.id
                    for p in lib.get_borrowers(active_only=True)}
            if opts:
                sel = st.selectbox("User", list(opts), key="admin_user_sel")
                target_id = opts[sel]
                target = lib.get_borrower(target_id)
                target_user = lib.repo.user_by_borrower(target_id)
                current_group = target_user.group_name if target_user else GROUP_GENERAL
                is_self = target_id == user.borrower_id
                if is_self:
                    st.info("You cannot change your own group or reset your own password here.")
                with st.columns(1)[0]:
                    new_group = st.selectbox("Group", GROUPS, index=GROUPS.index(current_group),
                                             key="admin_group_sel")
                if st.button("🔁 Reset password to default", disabled=is_self):
                    try:
                        default = lib.admin_reset_password(target_id)
                        st.info(f"Password reset for {target.name} to **`{default}`** — "
                                "they must change it on next login.")
                        st.rerun()
                    except Exception as exc:
                        flash(exc)
                if st.button("💾 Save group",
                             disabled=is_self or new_group == current_group):
                    try:
                        lib.admin_set_group(target_id, new_group)
                        st.success(f"{target.name} is now in the **{new_group}** group.")
                        st.rerun()
                    except Exception as exc:
                        flash(exc)
            else:
                st.info("No active users to maintain.")


with tab_loans:
    if can_edit:
        st.subheader("📤 Issue a book")
        books_avail = [b for b in lib.get_books() if b.available_copies > 0 and not b.discontinued]
        people_all = lib.get_borrowers(active_only=True)
        if books_avail and people_all:
            with st.form("issue"):
                a1, a2, a3 = st.columns([3, 3, 2])
                book_opts = {f"#{b.id} · {b.title} ({b.available_copies} avail.)": b.id for b in books_avail}
                person_opts = {f"#{p.id} · {p.name} ({p.department} · {p.team})": p.id for p in people_all}
                sel_book = a1.selectbox("Book", list(book_opts), key="issue_book")
                sel_person = a2.selectbox("Borrower", list(person_opts), key="issue_person")
                bdate = a3.date_input("Borrow date")
                if st.form_submit_button("Issue"):
                    try:
                        lib.borrow(book_opts[sel_book], person_opts[sel_person], borrow_date=bdate)
                        st.success("Book issued.")
                        st.rerun()
                    except Exception as exc:
                        flash(exc)
        else:
            st.warning("No books available, or no active team members yet — upload the team list in "
                       "the Team tab.")

        st.divider()
    st.subheader("🔁 Active loans")
    active = lib.get_active_loans()
    if active:
        rows = [{"ID": v.id, "Book": v.book_title, "Borrower": v.borrower_name,
                 "Borrow Date": v.borrow_date, "Return Date": fmt(v.return_date),
                 "Remarks": v.remarks} for v in active]
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

        if can_edit:
            st.subheader("↩️ Return a book")
            with st.expander("Select a loan to return"):
                opts = {f"#{v.id} · {v.book_title} → {v.borrower_name}": v.id for v in active}
                choice = st.selectbox("Loan", list(opts), key="ret_loan")
                r1, r2 = st.columns(2)
                ret_date = r1.date_input("Return date")
                remarks = r2.text_area("Remarks (damage found on return, etc.)")
                if st.button("Return book"):
                    try:
                        loan = lib.return_book(opts[choice], return_date=ret_date, remarks=remarks)
                        if loan.remarks:
                            st.warning(f"Returned with remarks: {loan.remarks}")
                        else:
                            st.success("Returned. Borrower is now --.")
                        st.rerun()
                    except Exception as exc:
                        flash(exc)
    else:
        st.info("No active loans.")

    with st.expander("📜 Full loan history"):
        history = lib.get_loan_history()
        if history:
            rows = [{"ID": v.id, "Book": v.book_title, "Borrower": v.borrower_name,
                     "Borrow Date": v.borrow_date, "Return Date": fmt(v.return_date),
                     "Remarks": v.remarks} for v in history]
            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        else:
            st.info("No loan history yet.")