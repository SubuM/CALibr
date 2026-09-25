import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BookView, LoanView, Member, User } from "../types";
import { Banner, Flash, Spinner, fieldError, fmtDate } from "../components/ui";
import { DataTable } from "./FirstRun";

export function Loans({ user }: { user: User }) {
  const canEdit = user.groupName === "admin";
  const [active, setActive] = useState<LoanView[] | null>(null);
  const [history, setHistory] = useState<LoanView[]>([]);
  const [books, setBooks] = useState<BookView[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "info"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [loansRes, booksRes, peopleRes] = await Promise.all([
      api.loans(true),
      api.books(),
      api.team(),
    ]);
    setActive(loansRes.loans.filter((v) => v.returnDate === null));
    setHistory(loansRes.loans);
    setBooks(booksRes.books);
    setPeople(peopleRes.members.filter((m) => m.active));
  }, []);

  useEffect(() => {
    void reload().catch((e) => setError(fieldError(e)));
  }, [reload]);

  async function run(fn: () => Promise<{ warn?: string; ok?: string }>) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await fn();
      await reload();
      if (result.warn) setNotice({ kind: "warn", text: result.warn });
      else if (result.ok) setNotice({ kind: "ok", text: result.ok });
    } catch (e) {
      setError(fieldError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!active) return <Spinner />;

  return (
    <div className="stack">
      {error && <Flash error={error} />}
      {notice && <Banner kind={notice.kind}>{notice.text}</Banner>}
      {busy && <Spinner />}

      {canEdit && (
        <IssueForm
          books={books}
          people={people}
          onSubmit={(bookId, borrowerId, borrowDate) =>
            void run(async () => {
              await api.issue(bookId, borrowerId, borrowDate);
              return { ok: "Book issued." };
            })
          }
        />
      )}

      <section className="section">
        <h3>🔁 Active loans</h3>
        {active.length === 0 ? (
          <p className="muted">No active loans.</p>
        ) : (
          <>
            <DataTable
              rows={active.map((v) => ({
                ID: v.id,
                Book: v.bookTitle,
                Borrower: v.borrowerName,
                "Borrow Date": v.borrowDate,
                "Return Date": fmtDate(v.returnDate),
                Remarks: v.remarks,
              }))}
            />
            {canEdit && (
              <ReturnForm
                loans={active}
                onReturn={(id, returnDate, remarks) =>
                  void run(async () => {
                    const loan = await api.returnLoan(id, returnDate, remarks);
                    return loan.loan.remarks
                      ? { warn: `Returned with remarks: ${loan.loan.remarks}` }
                      : { ok: "Returned. Borrower is now --." };
                  })
                }
              />
            )}
          </>
        )}
      </section>

      <details className="section">
        <summary>📜 Full loan history</summary>
        {history.length === 0 ? (
          <p className="muted">No loan history yet.</p>
        ) : (
          <DataTable
            rows={history.map((v) => ({
              ID: v.id,
              Book: v.bookTitle,
              Borrower: v.borrowerName,
              "Borrow Date": v.borrowDate,
              "Return Date": fmtDate(v.returnDate),
              Remarks: v.remarks,
            }))}
          />
        )}
      </details>
    </div>
  );
}

function IssueForm({
  books,
  people,
  onSubmit,
}: {
  books: BookView[];
  people: Member[];
  onSubmit: (bookId: number, borrowerId: number, borrowDate: string) => void;
}) {
  const [bookId, setBookId] = useState<number>(0);
  const [borrowerId, setBorrowerId] = useState<number>(0);
  const [date, setDate] = useState<string>(today());
  const [err, setErr] = useState<string | null>(null);

  const available = books.filter((b) => b.availableCopies > 0 && !b.discontinued);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (bookId === 0 || borrowerId === 0) {
      setErr("Pick both a book and a borrower.");
      return;
    }
    onSubmit(bookId, borrowerId, date);
  }

  if (available.length === 0 || people.length === 0) {
    return (
      <Banner kind="warn">
        No books available, or no active team members yet — upload the team list in the Team tab.
      </Banner>
    );
  }

  return (
    <section className="section">
      <h3>📤 Issue a book</h3>
      <form onSubmit={submit} className="form">
        <div className="row">
          <label>
            Book
            <select value={bookId} onChange={(e) => setBookId(Number(e.target.value))}>
              <option value={0}>— choose —</option>
              {available.map((b) => (
                <option key={b.id} value={b.id}>
                  #{b.id} · {b.title} ({b.availableCopies} avail.)
                </option>
              ))}
            </select>
          </label>
          <label>
            Borrower
            <select value={borrowerId} onChange={(e) => setBorrowerId(Number(e.target.value))}>
              <option value={0}>— choose —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} · {p.name} ({p.department} · {p.team})
                </option>
              ))}
            </select>
          </label>
          <label>
            Borrow date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {err && <Flash error={err} />}
        <button type="submit" className="primary">Issue</button>
      </form>
    </section>
  );
}

function ReturnForm({
  loans,
  onReturn,
}: {
  loans: LoanView[];
  onReturn: (id: number, returnDate: string, remarks: string) => void;
}) {
  const [loanId, setLoanId] = useState<number>(loans[0]?.id ?? 0);
  const [date, setDate] = useState<string>(today());
  const [remarks, setRemarks] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  const loan = loans.find((l) => l.id === loanId) ?? loans[0];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!loan) {
      setErr("No loan selected.");
      return;
    }
    onReturn(loan.id, date, remarks);
  }

  if (!loan) return null;

  return (
    <section className="section">
      <h4>↩️ Return a book</h4>
      <form onSubmit={submit} className="form">
        <div className="row">
          <label>
            Loan
            <select value={loan.id} onChange={(e) => setLoanId(Number(e.target.value))}>
              {loans.map((l) => (
                <option key={l.id} value={l.id}>
                  #{l.id} · {l.bookTitle} → {l.borrowerName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Return date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label>
          Remarks (damage found on return, etc.)
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>
        {err && <Flash error={err} />}
        <button type="submit" className="primary">Return book</button>
      </form>
    </section>
  );
}

function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}