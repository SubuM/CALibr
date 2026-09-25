export type GroupName = "admin" | "power" | "general";

export interface AppConfig {
  hasUsers: boolean;
  hasAdmins: boolean;
  allowDemoData: boolean;
  trackIsbn: boolean;
  trackCost: boolean;
  trackCopies: boolean;
  passwordSuffix: string;
}

export interface User {
  borrowerId: number;
  username: string;
  name: string;
  groupName: GroupName;
  mustChange: boolean;
}

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

export interface Member {
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
  groupName?: string;
}

export interface MemberJSON {
  firstName: string;
  lastName: string;
  department: string;
  team: string;
  group: GroupName;
  fullName: string;
}

export interface Loan {
  id?: number;
  bookId: number;
  borrowerId: number;
  borrowDate: string | null;
  returnDate: string | null;
  remarks: string;
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

export interface Stats {
  books: number;
  totalCopies: number;
  availableCopies: number;
  borrowedCopies: number;
  returnedLoans: number;
  returnsWithRemarks: number;
  discontinuedBooks: number;
  borrowers: number;
  inventoryValue: number;
}

export interface SyncPlan {
  members: number;
  added: number;
  updated: number;
  toRemove: number;
  removedBlocked: Array<{ name: string; books: string[] }>;
}

export interface TeamSyncSummary {
  added: number;
  updated: number;
  removed: number;
  created: Array<{ name: string; username: string; defaultPassword: string }>;
}