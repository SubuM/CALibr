import { useState } from "react";
import { api } from "../api";
import type { AppConfig, MemberJSON, User } from "../types";
import { Banner, Flash, Spinner, fieldError } from "../components/ui";

export function FirstRun({
  config,
  onAuthed,
}: {
  config: AppConfig;
  onAuthed: (user: User) => void;
}) {
  const [members, setMembers] = useState<MemberJSON[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(f: File | null) {
    setFile(f);
    setError(null);
    if (!f) return;
    setBusy(true);
    try {
      const res = await api.uploadPost<{ members: MemberJSON[] }>("/api/setup/preview", f);
      setMembers(res.members);
    } catch (err) {
      setMembers(null);
      setError(fieldError(err));
    } finally {
      setBusy(false);
    }
  }

  async function bootstrap() {
    if (!file) {
      setError("Choose the team file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { summary } = await api.setupTeam(file);
      const admins = members?.filter((m) => m.group === "admin").length ?? 0;
      alert(
        `✅ Library set up: ${summary.added} user(s) created, ${admins} of them admin.\n\n` +
          `Sign in with your initial password, e.g. for John Doe the ID is JDO and the initial password is JDO${config.passwordSuffix} (must change on first login).`,
      );
      try {
        const { user } = await api.me();
        if (user) {
          onAuthed(user);
          return;
        }
      } catch {
        /* fall through to login */
      }
      window.location.reload();
    } catch (err) {
      setError(fieldError(err));
      setBusy(false);
    }
  }

  const admins = members?.filter((m) => m.group === "admin") ?? [];

  return (
    <div className="page">
      <h1>🚀 First-time setup</h1>
      <p className="muted">
        Upload the team list (Excel) to set up CALibr. Everyone marked in the <b>admin</b> group of
        the <b>UserGroup</b> column becomes an administrator.
      </p>

      <label className="dropzone">
        Upload team list (.xlsx)
        <input type="file" accept=".xlsx" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
        <a href={api.teamTemplateUrl()} onClick={(e) => e.stopPropagation()} download className="download-link">
          📥 Download Excel template
        </a>
      </label>

      <Flash error={error} />
      {busy && <Spinner />}

      {members && admins.length === 0 && (
        <CreateFirstAdmin onAuthed={onAuthed} />
      )}

      {members && admins.length > 0 && (
        <>
          <h2>Detected members ({members.length})</h2>
          <DataTable
            rows={members.map((m) => ({
              "First Name": m.firstName,
              "Last Name": m.lastName,
              Department: m.department,
              Team: m.team,
              Group: m.group,
            }))}
          />
          <Banner kind="ok">The file looks valid. Click below to create the library and admin accounts.</Banner>
          <button type="button" className="primary" onClick={bootstrap} disabled={!file || busy}>
            ✔️ Create the library & admin accounts
          </button>
        </>
      )}
    </div>
  );
}

function CreateFirstAdmin({
  onAuthed,
}: {
  onAuthed: (user: User) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const suggested = username || suggestedLogin(firstName, lastName);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { user } = await api.setupAdmin({ firstName, lastName, username, password });
      setInfo("Administrator created. Signing you in…");
      onAuthed(user);
    } catch (err) {
      setError(fieldError(err));
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>👑 Create the first administrator</h2>
      <p className="muted">
        No one in the <b>admin</b> group was found in this file — create the first administrator
        below. You can upload the full team list afterwards from the Team tab.
      </p>
      <form onSubmit={submit} className="form">
        <div className="row">
          <label>
            First name *
            <input value={firstName} onChange={(e) => { setFirstName(e.target.value); setUsername(suggestedLogin(e.target.value, lastName)); }} />
          </label>
          <label>
            Last name *
            <input value={lastName} onChange={(e) => { setLastName(e.target.value); setUsername(suggestedLogin(firstName, e.target.value)); }} />
          </label>
        </div>
        <label>
          Login ID * <span className="muted">(suggested: {suggested || "—"})</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Password *
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Confirm password *
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </div>
        {info && <Banner kind="ok">{info}</Banner>}
        <Flash error={error} />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create administrator"}
        </button>
      </form>
      <p className="muted small">
        Password rules: {passwordHelp()}
      </p>
    </div>
  );
}

function suggestedLogin(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (!f && !l) return "";
  const firstLetter = (f || "?").charAt(0).toUpperCase();
  if (!l) {
    const alnum = f.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return firstLetter + (alnum.length > 1 ? alnum.slice(1, 3) : "XX");
  }
  return firstLetter + l.toUpperCase().slice(0, 2);
}

function passwordHelp(): string {
  return `8–20 characters, at least 1 uppercase, 1 lowercase, 1 digit and 1 special character. Must not contain your first or last name or login ID, must not be the initial password, and cannot be one of your last 3 passwords.`;
}

export function DataTable<T extends Record<string, unknown>>({ rows }: { rows: T[] }) {
  if (rows.length === 0) return <p className="muted">No rows.</p>;
  const cols = Object.keys(rows[0] as object);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{String((r as Record<string, unknown>)[c] ?? "--")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}