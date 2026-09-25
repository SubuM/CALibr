import { useEffect, useState } from "react";
import { api } from "../api";
import type { LoanView, User } from "../types";
import { Spinner, fmtDate } from "../components/ui";

export function MyBooks({ user }: { user: User }) {
  const [loans, setLoans] = useState<LoanView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .myLoans()
      .then(({ loans: mine }) => {
        if (!cancelled) setLoans(mine.filter((v) => v.returnDate === null));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!loans) return <Spinner />;

  return (
    <div className="stack">
      <h1>📕 My borrowed books</h1>
      <p className="muted">Signed in as {user.name}</p>
      {loans.length === 0 ? (
        <p className="ok">You have no books borrowed right now.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Book</th>
                <th>Borrow Date</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((v) => (
                <tr key={v.id}>
                  <td>{v.bookTitle}</td>
                  <td>{fmtDate(v.borrowDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}