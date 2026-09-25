import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppConfig, Book, BookView, User } from "../types";
import { Banner, Flash, Spinner, fieldError, fmtDate } from "../components/ui";
import { DataTable } from "./FirstRun";

export function Books({ user, config }: { user: User; config: AppConfig }) {
  const canEdit = user.groupName === "admin";
  const [books, setBooks] = useState<BookView[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const { books: b } = await api.books(search);
    setBooks(b);
  }, [search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setNotice(null);
  }, [search, books]);

  const filtered = useMemo(() => books ?? [], [books]);

  async function run(fn: () => Promise<unknown>, success?: string, warn?: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      await reload();
      if (success) setNotice({ kind: warn ? "warn" : "ok", text: warn ?? success });
      else if (success) setNotice({ kind: "ok", text: success });
    } catch (err) {
      setError(fieldError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!books) return <Spinner />;

  return (
    <div className="stack">
      {error && <Flash error={error} />}
      {notice && <Banner kind={notice.kind}>{notice.text}</Banner>}

      {canEdit && (
        <AddBookForm
          config={config}
          onSubmit={(body) =>
            void run(() => api.addBook(body), "Book added.")
          }
        />
      )}

      <section className="section">
        <h3>🗂️ Register</h3>
        <input
          className="search"
          placeholder="Search title / author / publisher / ISBN / borrower"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {busy && <span className="muted">Working…</span>}
        {filtered.length === 0 ? (
          <p className="muted">No books match your search.</p>
        ) : (
          <DataTable
            rows={filtered.map((b) => ({
              ID: b.id,
              Title: b.title,
              Author: b.author,
              Publisher: b.publisher,
              ISBN: b.isbn,
              Copies: b.totalCopies,
              Status: b.status,
              Borrower: b.borrowerLabel,
              "Borrow Date": b.borrowDate,
              "Return Date": fmtDate(b.returnDate),
              Remarks: b.remarks,
              Cost: b.cost,
            }))}
          />
        )}
        {canEdit && filtered.length > 0 && (
          <EditBook
            books={filtered}
            config={config}
            onSave={(id, body) =>
              void run(() => api.updateBook(id, body), "Saved.")
            }
            onClear={(id) =>
              void run(
                () => api.clearBorrower(id),
                "Closed loan(s). Borrower is now --.",
              )
            }
          />
        )}
      </section>
    </div>
  );
}

function AddBookForm({ config, onSubmit }: { config: AppConfig; onSubmit: (body: Partial<Book>) => void }) {
  const empty = { title: "", author: "", publisher: "", isbn: "", totalCopies: 1, cost: 0 };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!f.title.trim()) {
      setErr("Title is required");
      return;
    }
    onSubmit({
      ...f,
      totalCopies: config.trackCopies ? f.totalCopies : 1,
      isbn: config.trackIsbn ? f.isbn : "",
    });
    setF(empty);
  }

  return (
    <section className="section">
      <h3>➕ Add book</h3>
      <form onSubmit={submit} className="form">
        <div className="row">
          <label>
            Title *
            <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label>
            Author
            <input value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>
            Publisher
            <input value={f.publisher} onChange={(e) => setF({ ...f, publisher: e.target.value })} />
          </label>
          {config.trackIsbn && (
            <label>
              ISBN
              <input value={f.isbn} onChange={(e) => setF({ ...f, isbn: e.target.value })} />
            </label>
          )}
        </div>
        <div className="row">
          {config.trackCopies && (
            <label>
              Total copies
              <input type="number" min={0} value={f.totalCopies} onChange={(e) => setF({ ...f, totalCopies: Number(e.target.value) })} />
            </label>
          )}
          {config.trackCost && (
            <label>
              Cost
              <input type="number" min={0} step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: Number(e.target.value) })} />
            </label>
          )}
        </div>
        {err && <Flash error={err} />}
        <button type="submit" className="primary">Add</button>
      </form>
    </section>
  );
}

function EditBook({
  books,
  config,
  onSave,
  onClear,
}: {
  books: BookView[];
  config: AppConfig;
  onSave: (id: number, body: Partial<Book> & { remarks?: string }) => void;
  onClear: (id: number) => void;
}) {
  const options = books.map((b) => ({ label: `#${b.id} · ${b.title}`, id: b.id }));
  const [selectedId, setSelectedId] = useState<number>(options[0]?.id ?? 0);
  const view = books.find((b) => b.id === selectedId) ?? books[0];
  const [f, setF] = useState<Partial<Book>>({});
  const [discontinued, setDiscontinued] = useState<boolean>(false);
  const [remarks, setRemarks] = useState<string>("");

  useEffect(() => {
    if (view) {
      setF({
        title: view.title,
        author: view.author,
        publisher: view.publisher,
        isbn: view.isbn,
        totalCopies: view.totalCopies,
        cost: view.cost,
      });
      setDiscontinued(view.discontinued);
      setRemarks(view.remarks);
    }
  }, [view?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return null;

  const canEditRemarks = view.loanId !== null;

  return (
    <details className="section">
      <summary>✏️ Edit book · mark Not Available · update remarks</summary>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(view.id, {
            ...f,
            discontinued,
            remarks: canEditRemarks ? remarks : undefined,
          });
        }}
      >
        <label>
          Select book
          <select value={selectedId} onChange={(e) => setSelectedId(Number(e.target.value))}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <div className="row">
          <label>
            Title
            <input value={f.title ?? ""} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label>
            Author
            <input value={f.author ?? ""} onChange={(e) => setF({ ...f, author: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>
            Publisher
            <input value={f.publisher ?? ""} onChange={(e) => setF({ ...f, publisher: e.target.value })} />
          </label>
          {config.trackIsbn && (
            <label>
              ISBN
              <input value={f.isbn ?? ""} onChange={(e) => setF({ ...f, isbn: e.target.value })} />
            </label>
          )}
        </div>
        <div className="row">
          {config.trackCopies && (
            <label>
              Total copies
              <input type="number" min={0} disabled={discontinued} value={f.totalCopies ?? 0} onChange={(e) => setF({ ...f, totalCopies: Number(e.target.value) })} />
            </label>
          )}
          {config.trackCost && (
            <label>
              Cost
              <input type="number" min={0} step="0.01" value={f.cost ?? 0} onChange={(e) => setF({ ...f, cost: Number(e.target.value) })} />
            </label>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={discontinued} onChange={(e) => setDiscontinued(e.target.checked)} />
          Discontinued / Not Available (sets copies to 0)
        </label>
        {discontinued && (
          <Banner kind="warn">
            This book will be marked Not Available with 0 copies. Any copy still out stays with
            its borrower until physically returned.
          </Banner>
        )}
        <p className="muted small">
          <b>Current borrower:</b> {view.borrowerLabel}
          {view.borrowDate ? ` · borrowed ${view.borrowDate}` : ""}
        </p>
        {canEditRemarks && (
          <label>
            Remarks / live operations note (e.g. damage, follow-up)
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </label>
        )}
        <button type="submit" className="primary">💾 Save changes</button>
      </form>
      {canEditRemarks && (
        <button type="button" className="primary" onClick={() => onClear(view.id)} style={{ marginLeft: 8 }}>
          ✅ Copy returned — mark borrower as --
        </button>
      )}
    </details>
  );
}