import { useState } from "react";
import { api } from "../api";
import type { AppConfig, User } from "../types";
import { Dashboard } from "./Dashboard";
import { Books } from "./Books";
import { Team } from "./Team";
import { Loans } from "./Loans";
import { MyBooks } from "./MyBooks";
import { Flash, Banner, fieldError } from "../components/ui";

type Tab = "dashboard" | "books" | "team" | "loans";

export function MainApp({
  user,
  config,
  refreshUser,
  onLogout,
}: {
  user: User;
  config: AppConfig;
  refreshUser: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [sidebarError, setSidebarError] = useState<string | null>(null);

  const isAdmin = user.groupName === "admin";

  async function changePassword(oldPassword: string, newPassword: string) {
    setSidebarError(null);
    try {
      await api.changePassword(oldPassword, newPassword);
      await refreshUser();
      return true;
    } catch (err) {
      setSidebarError(fieldError(err));
      return false;
    }
  }

  async function purge() {
    const ok = window.confirm(
      'Type "PURGE" in a separate prompt to wipe the whole database permanently.',
    );
    if (ok && window.prompt('Type "PURGE" to confirm') === "PURGE") {
      await api.purge();
      void onLogout();
    }
  }

  // Group "general" sees only their own loans.
  if (user.groupName === "general") {
    return (
      <div className="layout">
        <aside className="sidebar">
          <div className="user-box">
            <div className="user-name">👤 {user.name}</div>
            <div className="user-meta">Group: {user.groupName} · ID: {user.username}</div>
          </div>
          <button type="button" className="ghost" onClick={() => void onLogout()}>
            🚪 Sign out
          </button>
        </aside>
        <main className="content">
          <MyBooks user={user} />
        </main>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="user-box">
          <div className="user-name">👤 {user.name}</div>
          <div className="user-meta">Group: {user.groupName} · ID: {user.username}</div>
        </div>

        <nav className="tabs">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>📊 Dashboard</button>
          <button className={tab === "books" ? "active" : ""} onClick={() => setTab("books")}>📚 Books</button>
          <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>👥 Team</button>
          <button className={tab === "loans" ? "active" : ""} onClick={() => setTab("loans")}>🔁 Loans</button>
        </nav>

        {isAdmin && (
          <details>
            <summary>🧰 Developer tools</summary>
            <p className="muted small">Temporary — remove before production.</p>
            {config.allowDemoData && (
              <button type="button" className="ghost" onClick={() => void api.seedDemo().then(() => window.location.reload())}>
                Seed demo data (only if empty)
              </button>
            )}
            <button type="button" className="danger-ghost" onClick={() => void purge()}>
              🗑️ Purge database
            </button>
          </details>
        )}

        <details>
          <summary>Change my password</summary>
          <PasswordForm onChangePassword={changePassword} />
        </details>

        <Flash error={sidebarError} />
        <button type="button" className="ghost" onClick={() => void onLogout()}>
          🚪 Sign out
        </button>
      </aside>

      <main className="content">
        {tab === "dashboard" && <Dashboard user={user} />}
        {tab === "books" && <Books user={user} config={config} />}
        {tab === "team" && <Team user={user} />}
        {tab === "loans" && <Loans user={user} />}
      </main>
    </div>
  );
}

function PasswordForm({ onChangePassword }: { onChangePassword: (oldPw: string, newPw: string) => Promise<boolean> }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onChangePassword(oldPw, newPw);
    if (ok) {
      setMsg("Password updated.");
      setOldPw("");
      setNewPw("");
    }
  }

  return (
    <form onSubmit={submit} className="form small">
      {msg && <Banner kind="ok">{msg}</Banner>}
      <input type="password" placeholder="Current password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
      <input type="password" placeholder="New password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
      <button type="submit">Update password</button>
    </form>
  );
}