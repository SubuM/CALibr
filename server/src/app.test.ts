import { afterEach, describe, expect, it, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { Repository } from "./db/repository.js";
import { Library } from "./domain/library.js";
import {
  hashPassword,
  verifyPassword,
  validateNewPassword,
  defaultPassword,
  initialsUsername,
  signToken,
  verifyToken,
} from "./domain/auth.js";
import { ValidationError } from "./domain/errors.js";
import { parseTeamExcel, teamTemplateBytes } from "./domain/team-excel.js";
import { TeamMember } from "./domain/team.js";
import { buildApp } from "./index.js";

function makeLib(): { repo: Repository; lib: Library } {
  const repo = new Repository(":memory:");
  return { repo, lib: new Library(repo) };
}

async function makeExcel(rows: Array<[string, string, string, string, string]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Team");
  ws.addRow(["FirstName", "LastName", "Department", "Team", "UserGroup"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("auth primitives", () => {
  it("hashes and verifies passwords (PBKDF2)", () => {
    const { salt, hash } = hashPassword("Secret1!abc");
    expect(salt).toHaveLength(32);
    expect(hash).toHaveLength(64);
    expect(verifyPassword("Secret1!abc", salt, hash)).toBe(true);
    expect(verifyPassword("wrong", salt, hash)).toBe(false);
    expect(verifyPassword("Secret1!abc", "zz", "zz")).toBe(false);
  });

  it("generates initials usernames like the original", () => {
    expect(initialsUsername({ firstName: "John", lastName: "Doe" })).toBe("JDO");
    expect(initialsUsername({ firstName: "Ada", lastName: "Lovelace" })).toBe("ALO");
    expect(initialsUsername({ firstName: "Cher", lastName: "" })).toBe("CHE");
  });

  it("enforces the password policy", () => {
    expect(() => validateNewPassword("short1A", {})).toThrow(ValidationError);
    expect(() => validateNewPassword("NoSpecial1", {})).toThrow(ValidationError);
    expect(() => validateNewPassword("ValidPass1!", {})).not.toThrow();
    // initial password is exempt
    expect(() => validateNewPassword("ASH1234o$", { username: "ASH" })).not.toThrow();
    // must not contain the name
    expect(() => validateNewPassword("John1980!!", { firstName: "John" })).toThrow(ValidationError);
  });

  it("signs and verifies session tokens", () => {
    const tok = signToken({ borrowerId: 7, exp: Math.floor(Date.now() / 1000) + 60 }, "secret");
    expect(verifyToken(tok, "secret")?.borrowerId).toBe(7);
    expect(verifyToken(tok, "other")).toBeNull();
    const expired = signToken({ borrowerId: 7, exp: Math.floor(Date.now() / 1000) - 10 }, "secret");
    expect(verifyToken(expired, "secret")).toBeNull();
  });
});

describe("library core", () => {
  let repo: Repository;
  let lib: Library;

  beforeEach(() => {
    repo = new Repository(":memory:");
    lib = new Library(repo);
  });

  afterEach(() => repo.close());

  it("adds and lists books with stock/status", () => {
    const book = lib.addBook("  Clean Code  ", { author: " Robert C. Martin ", totalCopies: 2, cost: 39.99 });
    expect(book.title).toBe("Clean Code");
    const views = lib.getBooks();
    expect(views).toHaveLength(1);
    expect(views[0]!.status).toBe("Available");
    expect(views[0]!.borrowerLabel).toBe("--");
  });

  it("validates titles/copies/cost", () => {
    expect(() => lib.addBook(" ")).toThrow(ValidationError);
    expect(() => lib.addBook("X", { totalCopies: -1 })).toThrow(ValidationError);
    expect(() => lib.addBook("X", { cost: -5 })).toThrow(ValidationError);
  });

  it("first admin bootstrap then login flow", () => {
    const user = lib.createFirstAdmin("Jane", "Roe", "jro", "Strong3!pass");
    expect(user.username).toBe("JRO");
    expect(user.groupName).toBe("admin");
    const logged = lib.loginUser("jro", "Strong3!pass");
    expect(logged.borrowerId).toBe(user.borrowerId);
    // wrong password rejected
    expect(() => lib.loginUser("jro", "nope")).toThrow(ValidationError);
  });

  it("borrow/return honors copy limits and borrower activeness", () => {
    const b = lib.addBook("Refactoring", { totalCopies: 1 });
    const p = lib.addBorrower("Bob Singh");
    const loan = lib.borrow(b.id!, p.id!);
    expect(loan.bookId).toBe(b.id);
    expect(() => lib.borrow(b.id!, p.id!)).toThrow(ValidationError);
    lib.returnBook(loan.id!, undefined, "cover scuffed");
    // now available again
    const again = lib.borrow(b.id!, p.id!);
    expect(again.id).not.toBe(loan.id);
  });

  it("rejects borrowing from a discontinued book", () => {
    const b = lib.addBook("Old Manual", { totalCopies: 2 });
    const p = lib.addBorrower("Carol");
    lib.setDiscontinued(b.id!, true);
    expect(() => lib.borrow(b.id!, p.id!)).toThrow(ValidationError);
  });

  it("clears a borrower without deleting history", () => {
    const b = lib.addBook("Design Patterns", { totalCopies: 1 });
    const p = lib.addBorrower("Alice Sharma");
    lib.borrow(b.id!, p.id!);
    const closed = lib.clearBorrower(b.id!);
    expect(closed).toBe(1);
    const history = lib.getLoanHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.returnDate).not.toBeNull();
  });

  it("prevents deleting a borrower with loan history", () => {
    const b = lib.addBook("Book", { totalCopies: 1 });
    const p = lib.addBorrower("Dana");
    lib.borrow(b.id!, p.id!);
    expect(() => lib.deleteBorrower(p.id!)).toThrow(ValidationError);
  });

  it("computes stats", () => {
    lib.addBook("A", { totalCopies: 2, cost: 10 });
    lib.addBook("B", { totalCopies: 1, cost: 5 });
    const stats = lib.stats();
    expect(stats.books).toBe(2);
    expect(stats.totalCopies).toBe(3);
    expect(stats.inventoryValue).toBe(25);
  });
});

describe("team sync", () => {
  it("bootstraps a whole team from an Excel upload (setupFirstTeam)", async () => {
    const buf = await makeExcel([
      ["Ada", "Lovelace", "Finance", "Audit", "admin"],
      ["Alan", "Turing", "IT", "Ops", "power"],
      ["Grace", "Hopper", "Finance", "Ops", "general"],
    ]);
    const members = await parseTeamExcel(buf);
    expect(members).toHaveLength(3);
    expect(members[0]!.fullName).toBe("Ada Lovelace");
    expect(members[0]!.key).toBe("ada lovelace");

    const { repo, lib } = makeLib();
    const summary = lib.setupFirstTeam(members);
    expect(repo.countUsers()).toBe(3);
    expect(repo.countAdmins()).toBe(1);
    expect(summary.created[0]!.username).toBe("ALO");
    expect(summary.created[0]!.defaultPassword).toBe(defaultPassword("ALO"));
    repo.close();
  });

  it("rejects a team file with no admin", async () => {
    const buf = await makeExcel([
      ["Alan", "Turing", "IT", "Ops", "general"],
    ]);
    const members = await parseTeamExcel(buf);
    const { repo, lib } = makeLib();
    expect(() => lib.setupFirstTeam(members)).toThrow(ValidationError);
    repo.close();
  });

  it("blocks removal of a member with an active loan", () => {
    const { repo, lib } = makeLib();
    const m = new TeamMember({ firstName: "Ada", lastName: "Lovelace", group: "admin" });
    lib.setupFirstTeam([m]);
    const book = lib.addBook("SICP", { totalCopies: 1 });
    const borrower = lib.getBorrowers()[0];
    lib.borrow(book.id!, borrower!.id!);
    expect(() => lib.syncTeam([], undefined)).toThrow(/still have borrowed books/);
    repo.close();
  });

  it("generates the Excel template and re-reads it cleanly", async () => {
    const buf = await teamTemplateBytes();
    const members = await parseTeamExcel(buf);
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.group)).toEqual(["admin", "power", "general"]);
  });
});

describe("HTTP API", () => {
  it("exposes bootstrap config on empty db", async () => {
    const { app } = await buildApp({ dbPath: ":memory:", log: false });
    const res = await app.inject({ method: "GET", url: "/api/app/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasUsers).toBe(false);
    await app.close();
  });

  it("login → me → change password → logout flow", async () => {
    const { app, lib } = await buildApp({ dbPath: ":memory:", log: false });
    const admin = lib.createFirstAdmin("Jane", "Roe", "jro", "Strong3!pass");
    void admin;

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "jro", password: "Strong3!pass" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    expect(cookie).toContain("calibr_session");

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("JRO");

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { oldPassword: "Strong3!pass", newPassword: "NewStrong1!" },
    });
    expect(change.statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const cleared = logout.headers["set-cookie"] as string;
    expect(cleared).toContain("calibr_session=");
    expect(cleared.toLowerCase()).toContain("max-age=0");

    // With the cookie actually cleared (not re-sent), /me is unauthenticated.
    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(meAfter.statusCode).toBe(401);
    await app.close();
  });

  it("protects admin routes from power users", async () => {
    const { app, lib } = await buildApp({ dbPath: ":memory:", log: false });
    lib.createFirstAdmin("Jane", "Roe", "jro", "Strong3!pass");
    const second = lib.addBorrower("Power User");
    lib.repo.insertUser(second.id!, "BPO", "PowerUser1!", "power");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "BPO", password: "PowerUser1!" },
    });
    const cookie = login.headers["set-cookie"] as string;

    const addBook = await app.inject({
      method: "POST",
      url: "/api/books",
      headers: { cookie },
      payload: { title: "Forbidden" },
    });
    expect(addBook.statusCode).toBe(403);

    const readBooks = await app.inject({ method: "GET", url: "/api/books", headers: { cookie } });
    expect(readBooks.statusCode).toBe(200);
    await app.close();
  });
});

describe("fresh-db first-run via multipart team upload", () => {
  async function multipartBody(b64: string): Promise<{ headers: Record<string, string>; payload: Buffer }> {
    const file = Buffer.from(b64, "base64");
    const boundary = "----calibr-test-boundary";
    const chunks: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="team.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    return {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(chunks),
    };
  }

  it("creates the library + admin accounts from the uploaded team", async () => {
    const excel = await makeExcel([
      ["Ada", "Lovelace", "Finance", "Audit", "admin"],
      ["Alan", "Turing", "IT", "Ops", "general"],
    ]);
    const { headers, payload } = await multipartBody(excel.toString("base64"));
    const { app } = await buildApp({ dbPath: ":memory:", log: false });
    const res = await app.inject({ method: "POST", url: "/api/setup/team", headers, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.added).toBe(2);

    const config = await app.inject({ method: "GET", url: "/api/app/config" });
    expect(config.json().hasUsers).toBe(true);

    // initial password login works, must change
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ALO", password: defaultPassword("ALO") },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChange).toBe(true);
    await app.close();
  });

  it("persists a changed initial password across re-login", async () => {
    const excel = await makeExcel([
      ["Ada", "Lovelace", "Finance", "Audit", "admin"],
    ]);
    const { headers, payload } = await multipartBody(excel.toString("base64"));
    const { app, lib } = await buildApp({ dbPath: ":memory:", log: false });
    await app.inject({ method: "POST", url: "/api/setup/team", headers, payload });

    // login with the initial password -> forced change required
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ALO", password: defaultPassword("ALO") },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChange).toBe(true);
    const cookie = login.headers["set-cookie"] as string;

    // forced change: old password is the initial password
    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { oldPassword: defaultPassword("ALO"), newPassword: "NewStrong1!" },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().user.mustChange).toBe(false);
    expect(lib.repo.userByUsername("ALO")!.mustChange).toBe(false);

    // the new password now signs in…
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ALO", password: "NewStrong1!" },
    });
    expect(again.statusCode).toBe(200);

    // …and the initial password no longer does
    const old = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ALO", password: defaultPassword("ALO") },
    });
    expect(old.statusCode).toBe(400);
    expect(old.json().message).toContain("invalid username or password");
    await app.close();
  });
});