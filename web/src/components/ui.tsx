import type { ReactNode } from "react";

export function Spinner() {
  return <div className="spinner" aria-label="loading" />;
}

export function Banner({ kind, children }: { kind: "error" | "warn" | "info" | "ok"; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Flash({ error }: { error: string | null }) {
  if (!error) return null;
  return <Banner kind="error">{error}</Banner>;
}

export function fieldError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

export function fmtDate(value: string | null): string {
  if (!value) return "--";
  return value.slice(0, 10);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}