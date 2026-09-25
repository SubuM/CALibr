import type {
  AppConfig,
  Book,
  BookView,
  Loan,
  LoanView,
  Member,
  MemberJSON,
  Stats,
  SyncPlan,
  TeamSyncSummary,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : "") ||
      `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

function json(method: string) {
  return <T>(url: string, body?: unknown): Promise<T> =>
    request<T>(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

function upload(method: string) {
  return <T>(url: string, file: File): Promise<T> => {
    const form = new FormData();
    form.append("file", file);
    return request<T>(url, { method, body: form });
  };
}

export const api = {
  get: request,
  post: json("POST"),
  put: json("PUT"),
  uploadPost: upload("POST"),

  // bootstrap / auth
  appConfig: () => request<AppConfig>("/api/app/config"),
  me: () => request<{ user: User }>("/api/auth/me"),
  login: (username: string, password: string) =>
    json("POST")<{ user: User }>("/api/auth/login", { username, password }),
  logout: () => json("POST")<{ ok: boolean }>("/api/auth/logout"),
  changePassword: (oldPassword: string, newPassword: string) =>
    json("POST")<{ user: User }>("/api/auth/change-password", { oldPassword, newPassword }),

  // setup
  setupTeam: (file: File) =>
    upload("POST")<{ summary: { added: number; admins: number } }>("/api/setup/team", file),
  setupAdmin: (args: { firstName: string; lastName: string; username: string; password: string }) =>
    json("POST")<{ user: User }>("/api/setup/admin", args),
  teamTemplateUrl: () => "/api/team/template",

  // dashboard
  stats: () => request<{ stats: Stats }>("/api/stats"),

  // books
  books: (search = "") =>
    request<{ books: BookView[] }>(`/api/books?search=${encodeURIComponent(search)}`),
  book: (id: number) => request<{ book: Book; view: BookView }>(`/api/books/${id}`),
  addBook: (body: Partial<Book>) => json("POST")<{ book: Book }>("/api/books", body),
  updateBook: (id: number, body: Partial<Book> & { remarks?: string }) =>
    json("PUT")<{ book: Book }>(`/api/books/${id}`, body),
  clearBorrower: (id: number) =>
    json("POST")<{ closed: number }>(`/api/books/${id}/clear-borrower`),
  seedDemo: () => json("POST")<{ ok: boolean }>("/api/admin/seed-demo"),
  purge: () => json("POST")<{ ok: boolean }>("/api/admin/purge"),

  // loans
  loans: (includeReturned = true) =>
    request<{ loans: LoanView[] }>(
      `/api/loans${includeReturned ? "" : "?includeReturned=false"}`,
    ),
  myLoans: () => request<{ loans: LoanView[] }>("/api/loans/mine"),
  issue: (bookId: number, borrowerId: number, borrowDate: string) =>
    json("POST")<{ loan: Loan }>("/api/loans", { bookId, borrowerId, borrowDate }),
  returnLoan: (id: number, returnDate: string, remarks: string) =>
    json("POST")<{ loan: Loan }>(`/api/loans/${id}/return`, { returnDate, remarks }),
  updateRemarks: (id: number, remarks: string) =>
    json("POST")<{ ok: boolean }>(`/api/loans/${id}/remarks`, { remarks }),

  // team
  team: (search = "") =>
    request<{ members: Member[] }>(`/api/team?search=${encodeURIComponent(search)}`),
  previewTeam: (file: File) =>
    upload("POST")<{ members: MemberJSON[]; plan: SyncPlan }>("/api/team/preview", file),
  syncTeam: (file: File) =>
    upload("POST")<{ summary: TeamSyncSummary }>("/api/team/sync", file),
  resetPassword: (id: number) =>
    json("POST")<{ defaultPassword: string; target: string }>(`/api/team/${id}/reset-password`),
  setGroup: (id: number, group: string) =>
    json("POST")<{ target: string; group: string }>(`/api/team/${id}/group`, { group }),
};