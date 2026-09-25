import {
  GROUP_ADMIN,
  GROUP_GENERAL,
  GROUPS,
  type GroupName,
} from "../config.js";
import type { Repository } from "../db/repository.js";
import { ValidationError } from "./errors.js";
import {
  defaultPassword,
  validateNewPassword,
  verifyPassword,
} from "./auth.js";
import type { TeamMember } from "./team.js";
import {
  type Book,
  type Borrower,
  type BookView,
  type Loan,
  type LoanView,
  type SessionUser,
  todayIso,
  toIsoDate,
} from "./models.js";

export interface CredentialCreated {
  name: string;
  username: string;
  defaultPassword: string;
}

export interface TeamSyncSummary {
  added: number;
  updated: number;
  removed: number;
  created: CredentialCreated[];
}

export interface SyncPlan {
  members: number;
  added: number;
  updated: number;
  toRemove: number;
  removedBlocked: Array<{ name: string; books: string[] }>;
}

export class Library {
  constructor(readonly repo: Repository) {}

  // ------------------------------------------------------------------ books
  addBook(
    title: string,
    opts: {
      author?: string;
      publisher?: string;
      isbn?: string;
      totalCopies?: number;
      cost?: number;
      addedAt?: string | null;
    } = {},
  ): Book {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new ValidationError("title is required");
    const totalCopies = opts.totalCopies ?? 1;
    const cost = opts.cost ?? 0;
    if (totalCopies < 0) throw new ValidationError("total copies cannot be negative");
    if (cost < 0) throw new ValidationError("cost cannot be negative");
    return this.repo.addBook({
      title: cleanTitle,
      author: (opts.author ?? "").trim(),
      publisher: (opts.publisher ?? "").trim(),
      isbn: (opts.isbn ?? "").trim(),
      totalCopies,
      cost,
      addedAt: opts.addedAt ? toIsoDate(opts.addedAt) : todayIso(),
      discontinued: false,
    });
  }

  updateBook(book: Book): Book {
    if (book.id === undefined) throw new ValidationError("book id is required");
    if (!book.title.trim()) throw new ValidationError("title is required");
    if (book.cost < 0) throw new ValidationError("cost cannot be negative");
    if (book.discontinued) {
      book.totalCopies = 0;
    } else {
      const active = this.repo.activeLoanCount(book.id);
      if (book.totalCopies < active) {
        throw new ValidationError(
          `cannot set copies below the ${active} currently borrowed`,
        );
      }
    }
    return this.repo.updateBook(book);
  }

  setDiscontinued(bookId: number, discontinued: boolean): Book {
    const book = this.repo.getBook(bookId);
    book.discontinued = discontinued;
    return this.updateBook(book);
  }

  getBooks(search = ""): BookView[] {
    const books = this.repo.listBooks();
    const needle = search.trim().toLowerCase();
    if (needle) {
      return books.filter(
        (b) =>
          b.title.toLowerCase().includes(needle) ||
          b.author.toLowerCase().includes(needle) ||
          b.publisher.toLowerCase().includes(needle) ||
          b.isbn.toLowerCase().includes(needle) ||
          b.borrowerLabel.toLowerCase().includes(needle),
      );
    }
    return books;
  }

  getBookView(bookId: number): BookView {
    const view = this.repo.listBooks().find((b) => b.id === bookId);
    if (!view) throw new ValidationError(`book ${bookId} not found`);
    return view;
  }

  getBook(bookId: number): Book {
    return this.repo.getBook(bookId);
  }

  // -------------------------------------------------------------- borrowers
  addBorrower(
    name: string,
    opts: { phone?: string; email?: string; joinedAt?: string | null } = {},
  ): Borrower {
    const clean = name.trim();
    if (!clean) throw new ValidationError("name is required");
    return this.repo.addBorrower({
      name: clean,
      firstName: "",
      lastName: "",
      department: "",
      team: "",
      phone: (opts.phone ?? "").trim(),
      email: (opts.email ?? "").trim(),
      joinedAt: opts.joinedAt ? toIsoDate(opts.joinedAt) : todayIso(),
      active: true,
    });
  }

  deleteBorrower(borrowerId: number): void {
    const activeLoans = this.getActiveLoans();
    const borrowedNow = activeLoans.filter((v) => v.borrowerId === borrowerId);
    if (borrowedNow.length > 0) {
      throw new ValidationError(
        `cannot delete: ${borrowedNow.length} copy/copies still issued to this borrower`,
      );
    }
    if (this.repo.borrowerLoanCount(borrowerId) > 0) {
      throw new ValidationError(
        "cannot delete a borrower with loan history — deleting would erase the records",
      );
    }
    this.repo.deleteBorrower(borrowerId);
  }

  getBorrowers(search = "", activeOnly = false): Borrower[] {
    const people = this.repo.listBorrowers(activeOnly);
    const needle = search.trim().toLowerCase().split(/\s+/).join(" ");
    if (needle) {
      return people.filter(
        (p) =>
          p.name.toLowerCase().split(/\s+/).join(" ").includes(needle) ||
          p.department.toLowerCase().split(/\s+/).join(" ").includes(needle) ||
          p.team.toLowerCase().split(/\s+/).join(" ").includes(needle),
      );
    }
    return people;
  }

  getBorrower(borrowerId: number): Borrower {
    return this.repo.getBorrower(borrowerId);
  }

  // -------------------------------------------------------------- team sync
  private teamMap(): Map<string, Borrower> {
    const byKey = new Map<string, Borrower>();
    for (const p of this.repo.listBorrowers()) {
      byKey.set(p.name.toLowerCase(), p);
    }
    return byKey;
  }

  planSync(members: TeamMember[]): SyncPlan {
    const byKey = this.teamMap();
    const newKeys = new Set(members.map((m) => m.key));
    const missing = [...byKey.values()].filter(
      (b) => !newKeys.has(b.name.toLowerCase()) && b.active,
    );
    const activeLoans = this.getActiveLoans();
    const removedBlocked = missing
      .filter((b) => activeLoans.some((v) => v.borrowerId === b.id))
      .map((b) => ({
        name: b.name,
        books: activeLoans
          .filter((v) => v.borrowerId === b.id)
          .map((v) => v.bookTitle),
      }));
    return {
      members: members.length,
      added: members.filter((m) => !byKey.has(m.key.toLowerCase())).length,
      updated: members.filter((m) => byKey.has(m.key.toLowerCase())).length,
      toRemove: missing.length,
      removedBlocked,
    };
  }

  syncTeam(members: TeamMember[], keepUserId?: number): TeamSyncSummary {
    const byKey = this.teamMap();
    const newKeys = new Set(members.map((m) => m.key));
    const toAdd = members.filter((m) => !byKey.has(m.key.toLowerCase()));
    const toUpdate = members
      .filter((m) => byKey.has(m.key.toLowerCase()))
      .map((m) => [byKey.get(m.key.toLowerCase())!.id!, m] as [number, TeamMember]);
    const toDeactivate = [...byKey.values()]
      .filter((b) => !newKeys.has(b.name.toLowerCase()) && b.active)
      .map((b) => b.id!);

    const activeLoans = this.repo.countUsers() > 0 ? this.getActiveLoans() : [];
    const blocked: Array<{ name: string; books: string[] }> = [];
    for (const k of [...byKey.keys()]) {
      const b = byKey.get(k)!;
      if (newKeys.has(k)) continue;
      const borrowed = activeLoans.filter((v) => v.borrowerId === b.id);
      if (borrowed.length > 0) {
        blocked.push({
          name: b.name,
          books: borrowed.map((v) => v.bookTitle),
        });
      }
    }
    if (keepUserId !== undefined && toDeactivate.includes(keepUserId)) {
      blocked.push({ name: "your own account", books: ["you cannot remove yourself while logged in"] });
    }
    if (blocked.length > 0) {
      const detail = blocked
        .map(({ name, books }) => `• ${name} — currently borrowed: ${books.join(", ")}`)
        .join("\n");
      throw new ValidationError(
        "Team list not updated. These members still have borrowed books:\n" +
          `${detail}\n\nReturn the book(s) first, then upload the file again.`,
      );
    }
    const created = this.repo.applyTeam(toAdd, toUpdate, toDeactivate);
    return { added: toAdd.length, updated: toUpdate.length, removed: toDeactivate.length, created };
  }

  // ------------------------------------------------------------------ auth
  loginUser(username: string, password: string): SessionUser {
    const user = this.repo.userByUsername(username);
    if (!user) throw new ValidationError("invalid username or password");
    const cred = this.repo.passwordCredential(user.username);
    if (!cred || !verifyPassword(password, cred.salt, cred.hash)) {
      throw new ValidationError("invalid username or password");
    }
    if (!cred.active) {
      throw new ValidationError(
        "this account has been deactivated (no longer in the team list)",
      );
    }
    return user;
  }

  changePassword(user: SessionUser, oldPassword: string, newPassword: string): void {
    const cred = this.repo.passwordCredential(user.borrowerId);
    if (!cred) throw new ValidationError("no login account found for this borrower");
    if (!verifyPassword(oldPassword, cred.salt, cred.hash)) {
      throw new ValidationError("current password is incorrect");
    }
    const borrower = this.repo.getBorrower(user.borrowerId);
    validateNewPassword(newPassword, {
      firstName: borrower.firstName,
      lastName: borrower.lastName,
      username: cred.username,
    });
    if (newPassword === defaultPassword(cred.username)) {
      throw new ValidationError("the new password cannot be the same as the initial password");
    }
    if (verifyPassword(newPassword, cred.salt, cred.hash)) {
      throw new ValidationError("the new password must be different from your current password");
    }
    for (const [salt, hash] of this.repo.passwordHistoryHashes(user.borrowerId)) {
      if (verifyPassword(newPassword, salt, hash)) {
        throw new ValidationError("the new password cannot be one of your last 3 passwords");
      }
    }
    this.repo.setUserPassword(user.borrowerId, newPassword);
  }

  adminResetPassword(targetBorrowerId: number): string {
    const res = this.repo.resetUserPassword(targetBorrowerId);
    return res.defaultPassword;
  }

  adminSetGroup(targetBorrowerId: number, group: GroupName): void {
    if (!(GROUPS as readonly string[]).includes(group)) {
      throw new ValidationError(`unknown group: ${group}`);
    }
    this.repo.setUserGroup(targetBorrowerId, group);
  }

  createFirstAdmin(
    first: string,
    last: string,
    username: string,
    password: string,
  ): SessionUser {
    if (this.repo.countAdmins() > 0) {
      throw new ValidationError("an administrator already exists — sign in or use the Team tab");
    }
    const cleanUsername = username.trim().toUpperCase();
    if (!cleanUsername) throw new ValidationError("username is required");
    if (this.repo.userByUsername(cleanUsername) !== null) {
      throw new ValidationError("username already taken");
    }
    const firstClean = first.trim();
    const lastClean = last.trim();
    validateNewPassword(password, {
      firstName: firstClean,
      lastName: lastClean,
      username: cleanUsername,
    });
    const borrower = this.repo.addBorrower({
      name: [firstClean, lastClean].filter(Boolean).join(" "),
      firstName: firstClean,
      lastName: lastClean,
      department: "",
      team: "",
      phone: "",
      email: "",
      joinedAt: todayIso(),
      active: true,
    });
    this.repo.insertUser(borrower.id!, cleanUsername, password, GROUP_ADMIN);
    return {
      borrowerId: borrower.id!,
      username: cleanUsername,
      name: borrower.name,
      groupName: GROUP_ADMIN,
      mustChange: false,
    };
  }

  setupFirstTeam(members: TeamMember[]): TeamSyncSummary {
    if (this.repo.countUsers() > 0) {
      throw new ValidationError("users already exist — sign in and use the Team tab");
    }
    if (!members.some((m) => m.group === GROUP_ADMIN)) {
      throw new ValidationError("the uploaded file has no one in the admin group");
    }
    this.repo.clearAuthData();
    return this.syncTeam(members);
  }

  // ------------------------------------------------------------------ loans
  ownLoans(borrowerId: number): LoanView[] {
    return this.getActiveLoans().filter((v) => v.borrowerId === borrowerId);
  }

  borrow(bookId: number, borrowerId: number, borrowDate?: string): Loan {
    const date = borrowDate ? toIsoDate(borrowDate) ?? todayIso() : todayIso();
    const view = this.getBookView(bookId);
    if (view.discontinued) throw new ValidationError("this book is marked Not Available");
    if (view.availableCopies <= 0) throw new ValidationError("no copies of this book are available");
    try {
      return this.repo.createLoan(bookId, borrowerId, date);
    } catch (exc) {
      if (exc instanceof ValidationError) throw exc;
      throw new ValidationError((exc as Error).message);
    }
  }

  returnBook(loanId: number, returnDate?: string, remarks = ""): Loan {
    const date = returnDate ? toIsoDate(returnDate) ?? todayIso() : todayIso();
    return this.repo.returnLoan(loanId, date, remarks.trim());
  }

  updateRemarks(loanId: number, remarks: string): void {
    this.repo.updateLoanRemarks(loanId, remarks.trim());
  }

  clearBorrower(bookId: number, returnDate?: string): number {
    const date = returnDate ? toIsoDate(returnDate) ?? todayIso() : todayIso();
    return this.repo.clearActiveLoans(bookId, date);
  }

  getActiveLoans(): LoanView[] {
    return this.repo.listLoans(false);
  }

  getLoanHistory(): LoanView[] {
    return this.repo.listLoans(true);
  }

  // ------------------------------------------------------------------ stats
  stats(): Record<string, number> {
    const books = this.repo.listBooks();
    const active = this.repo.listLoans(false);
    const all = this.repo.listLoans(true);
    const returned = all.filter((v) => v.returnDate !== null);
    const noted = returned.filter((v) => v.remarks.trim());
    return {
      books: books.length,
      totalCopies: books.reduce((s, b) => s + b.totalCopies, 0),
      availableCopies: books.reduce((s, b) => s + b.availableCopies, 0),
      borrowedCopies: active.length,
      returnedLoans: returned.length,
      returnsWithRemarks: noted.length,
      discontinuedBooks: books.filter((b) => b.discontinued).length,
      borrowers: this.repo.listBorrowers(true).length,
      inventoryValue: Math.round(
        books.reduce((s, b) => s + b.totalCopies * b.cost, 0) * 100,
      ) / 100,
    };
  }

  // ------------------------------------------------------------ demo data
  seedDemoData(): void {
    if (this.repo.listBooks().length > 0) return;
    const demoBooks = [
      { title: "Clean Code", author: "Robert C. Martin", publisher: "Prentice Hall", isbn: "9780132350884", totalCopies: 2, cost: 39.99 },
      { title: "The Pragmatic Programmer", author: "Andrew Hunt & David Thomas", publisher: "Addison-Wesley", isbn: "9780201616224", totalCopies: 1, cost: 49.99 },
      { title: "Design Patterns", author: "Erich Gamma et al.", publisher: "Addison-Wesley", isbn: "9780201633610", totalCopies: 2, cost: 54.99 },
      { title: "Refactoring", author: "Martin Fowler", publisher: "Addison-Wesley", isbn: "9780134757599", totalCopies: 1, cost: 44.99 },
      { title: "You Don't Know JS", author: "Kyle Simpson", publisher: "O'Reilly", isbn: "9781491904158", totalCopies: 3, cost: 29.99 },
    ];
    const people = [
      { name: "Alice Sharma", firstName: "Alice", lastName: "Sharma", department: "Finance", team: "Audit", phone: "555-0101", email: "alice@example.com" },
      { name: "Bob Singh", firstName: "Bob", lastName: "Singh", department: "Tax", team: "Taxation", phone: "555-0102", email: "bob@example.com" },
      { name: "Carol Das", firstName: "Carol", lastName: "Das", department: "Finance", team: "Consulting", phone: "555-0103", email: "carol@example.com" },
    ];
    for (const b of demoBooks) this.addBook(b.title, b);
    const borrowers = people.map((p) => this.repo.addBorrower({ ...p, joinedAt: todayIso(), active: true }));
    const [alice, bob, carol] = borrowers;
    this.repo.insertUser(alice!.id!, "ASH", defaultPassword("ASH"), GROUP_ADMIN, true);
    this.repo.insertUser(bob!.id!, "BSI", defaultPassword("BSI"), "power", true);
    this.repo.insertUser(carol!.id!, "CDA", defaultPassword("CDA"), GROUP_GENERAL, true);
    this.borrow(1, alice!.id!);
    this.borrow(3, bob!.id!);
    const loan = this.borrow(2, carol!.id!);
    this.returnBook(loan.id!, undefined, "coffee stain on pages 40-45");
    this.setDiscontinued(4, true);
  }
}