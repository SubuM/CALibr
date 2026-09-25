import { useEffect, useState } from "react";
import { api } from "../api";
import type { LoanView, Stats, User } from "../types";
import { Metric, Spinner, fmtDate } from "../components/ui";
import { DataTable } from "./FirstRun";

export function Dashboard({ user: _user }: { user: User }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [active, setActive] = useState<LoanView[]>([]);
  const [noted, setNoted] = useState<LoanView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, l] = await Promise.all([api.stats(), api.loans(true)]);
        if (cancelled) return;
        setStats(s.stats);
        const returned = l.loans.filter((x) => x.returnDate !== null);
        setActive(l.loans.filter((x) => x.returnDate === null));
        setNoted(returned.filter((x) => x.remarks.trim()));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!stats) return <Spinner />;

  return (
    <div className="stack">
      <div className="metric-grid">
        <Metric label="Books" value={stats.books} />
        <Metric label="Copies" value={stats.totalCopies} />
        <Metric label="Available" value={stats.availableCopies} />
        <Metric label="Borrowed" value={stats.borrowedCopies} />
        <Metric label="Not Available" value={stats.discontinuedBooks} />
        <Metric label="Borrowers" value={stats.borrowers} />
      </div>

      <div className="two-col">
        <section className="section">
          <h3>📤 Currently out ({active.length})</h3>
          {active.length > 0 ? (
            <DataTable
              rows={active.map((v) => ({
                Book: v.bookTitle,
                Borrower: v.borrowerName,
                "Borrow Date": v.borrowDate,
                "Return Date": fmtDate(v.returnDate),
                Remarks: v.remarks,
              }))}
            />
          ) : (
            <p className="ok">Every copy is on the shelf.</p>
          )}
        </section>

        <section className="section">
          <h3>⚠️ Returns with remarks ({noted.length})</h3>
          {noted.length > 0 ? (
            <DataTable
              rows={noted.map((v) => ({
                Book: v.bookTitle,
                Borrower: v.borrowerName,
                "Return Date": fmtDate(v.returnDate),
                Remarks: v.remarks,
              }))}
            />
          ) : (
            <p className="muted">No remarks on any return.</p>
          )}
        </section>
      </div>

      <section className="section">
        <h3>Inventory value & activity</h3>
        <div className="metric-grid">
          <Metric label="Inventory value" value={stats.inventoryValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} />
          <Metric label="Returned so far" value={stats.returnedLoans} />
          <Metric label="Not available" value={stats.discontinuedBooks} />
        </div>
      </section>
    </div>
  );
}