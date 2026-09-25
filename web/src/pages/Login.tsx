import { useState } from "react";
import { api } from "../api";
import type { AppConfig, User } from "../types";
import { Banner, Flash, fieldError } from "../components/ui";

function passwordHelp(suffix: string): string {
  return `8–20 characters, at least 1 uppercase, 1 lowercase, 1 digit and 1 special character. Must not contain your first or last name or login ID (the initial password is exempt), must not contain an email address, must not be the initial password, and cannot be one of your last 3 passwords. First sign-in uses your ID followed by ${suffix}.`;
}

export function Login({
  config,
  onAuthed,
}: {
  config: AppConfig;
  onAuthed: (user: User) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Enter your login ID and password.");
      return;
    }
    setBusy(true);
    try {
      const { user } = await api.login(username, password);
      onAuthed(user);
    } catch (err) {
      setError(fieldError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page center">
      <div className="card login-card">
        <h1>📚 CALibr — Library Management</h1>
        <p className="muted">No due dates. Register-style tracking with Not Available / discontinued support.</p>
        <h2>🔐 Sign in</h2>
        <form onSubmit={submit} className="form">
          <label>
            Login ID
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. JDO (from the team file)"
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <Flash error={error} />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted small">
          First time? Your login ID is the 1st letter of your first name plus the first 2 letters of
          your last name (e.g. John Doe → <b>JDO</b>). The initial password is your ID followed by{" "}
          <code>{config.passwordSuffix}</code> (e.g. <code>JDO{config.passwordSuffix}</code>). You
          will be asked to set your own password on first sign-in.
        </p>
      </div>
    </div>
  );
}

export function ForcedChange({
  user,
  passwordSuffix,
  onChanged,
  onLogout,
}: {
  user: User;
  passwordSuffix: string;
  onChanged: (user: User) => void;
  onLogout: () => void;
}) {
  const [np1, setNp1] = useState("");
  const [np2, setNp2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (np1 !== np2) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { user: updated } = await api.changePassword(
        `${user.username}${passwordSuffix}`,
        np1,
      );
      onChanged(updated);
    } catch (err) {
      setError(fieldError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page center">
      <div className="card login-card">
        <h2>🔑 Set your own password</h2>
        <Banner kind="warn">
          Welcome, {user.name}! You signed in with the initial password and need to choose a
          personal one.
        </Banner>
        <form onSubmit={submit} className="form">
          <label>
            New password *
            <input type="password" value={np1} onChange={(e) => setNp1(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Confirm new password *
            <input type="password" value={np2} onChange={(e) => setNp2(e.target.value)} autoComplete="new-password" />
          </label>
          <Flash error={error} />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </button>
          <button type="button" className="ghost" onClick={onLogout}>
            Sign out
          </button>
        </form>
        <p className="muted small">{passwordHelp(passwordSuffix)}</p>
      </div>
    </div>
  );
}