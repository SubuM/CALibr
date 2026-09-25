import type { GroupName } from "../config.js";

export interface Book {
  id?: number;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  totalCopies: number;
  cost: number;
  addedAt: string | null;
  discontinued: boolean;
}

export interface Borrower {
  id?: number;
  name: string;
  firstName: string;
  lastName: string;
  department: string;
  team: string;
  phone: string;
  email: string;
  joinedAt: string | null;
  active: boolean;
}

export interface TeamMember {
  firstName: string;
  lastName: string;
  department: string;
  team: string;
  group: GroupName;

  get fullName(): string;
  get key(): string;
}

export interface SessionUser {
  borrowerId: number;
  username: string;
  name: string;
  groupName: GroupName;
  mustChange: boolean;
}

export interface Loan {
  id?: number;
  bookId: number;
  borrowerId: number;
  borrowDate: string | null;
  returnDate: string | null;
  remarks: string;
}

export interface BookView {
  id: number;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  totalCopies: number;
  borrowedCopies: number;
  cost: number;
  addedAt: string | null;
  discontinued: boolean;
  borrowerNames: string[];
  borrowDate: string | null;
  returnDate: string | null;
  remarks: string;
  loanId: number | null;

  availableCopies: number;
  borrowerLabel: string;
  status: string;
}

export function makeBookView(data: Omit<BookView, "availableCopies" | "borrowerLabel" | "status">): BookView {
  return {
    ...data,
    get availableCopies() {
      return Math.max(this.totalCopies - this.borrowedCopies, 0);
    },
    get borrowerLabel() {
      return this.borrowerNames.length > 0 ? this.borrowerNames.join(", ") : "--";
    },
    get status() {
      if (this.discontinued) return "Not Available";
      if (this.availableCopies > 0) return "Available";
      if (this.borrowedCopies > 0) return "All borrowed";
      return "No copies";
    },
  };
}

export interface LoanView {
  id: number;
  bookId: number;
  bookTitle: string;
  borrowerId: number;
  borrowerName: string;
  borrowDate: string | null;
  returnDate: string | null;
  remarks: string;
}

export type LoanStatus = "active" | "returned";

export function loanStatus(returnDate: string | null): LoanStatus {
  return returnDate === null ? "active" : "returned";
}

/** Date-only strings are stored/transported as YYYY-MM-DD; helpers keep them tidy. */
export function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const t = value.trim();
  if (!t) return null;
  return t.slice(0, 10);
}

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}