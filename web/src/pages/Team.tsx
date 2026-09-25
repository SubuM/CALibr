import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { LoanView, Member, MemberJSON, SyncPlan, TeamSyncSummary, User } from "../types";
import { Banner, Flash, Spinner, fieldError } from "../components/ui";
import { DataTable } from "./FirstRun";

export function Team({ user }: { user: User }) {
  const canEdit = user.groupName === "admin";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [activeLoans, setActiveLoans] = useState<LoanView[]>([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "info"; text: string } | null>(null);

  const reload = useCallback(async () => {
    const [teamRes, loansRes] = await Promise.all([api.team(), api.loans(false)]);
    setMembers(teamRes.members);
    setActiveLoans(loansRes.loans);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, search]);

  if (!members) return <Spinner />;

  return (
    <div className="stack">
      {notice && <Banner kind={notice.kind}>{notice.text}</Banner>}

      {canEdit && (
        <TeamUpload
          onApplied={(summary, created) => {
            setNotice({
              kind: "ok",
              text:
                `Team updated: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed.` +
                (created.length
                  ? " New login accounts:\n" +
                    created
                      .map(
                        (c) =>
                          `• ${c.name} → ID ${c.username}, initial password ${c.defaultPassword} (must change on first login)`,
                      )
                      .join("\n")
                  : ""),
            });
            void reload();
          }}
        />
      )}

      <section className="section">
        <h3>Current team</h3>
        <p className="muted small">
          Borrowers = team members from the uploaded Excel file, each with a login ID, a group
          (admin / power / general) and an initial password. Re-uploading updates membership — a
          member with borrowed books cannot be removed.
        </p>
        <input
          className="search"
          placeholder="Search name / department / team"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {members.length === 0 ? (
          <p className="muted">No team members yet — upload the team Excel file above.</p>
        ) : (
          <DataTable
            rows={members.map((p) => {
              const borrowed = activeLoans
                .filter((v) => v.borrowerId === p.id)
                .map((v) => v.bookTitle);
              return {
                ID: p.id,
                Name: p.name,
                Department: p.department,
                Team: p.team,
                Borrowed: borrowed.length ? borrowed.join(", ") : "--",
                Status: p.active ? "Active" : "Removed",
              };
            })}
          />
        )}
      </section>

      {canEdit && <AdminMaintenance user={user} onChanged={() => void reload()} />}
    </div>
  );
}

function TeamUpload({
  onApplied,
}: {
  onApplied: (summary: TeamSyncSummary, created: TeamSyncSummary["created"]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ members: MemberJSON[]; plan: SyncPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function handleFile(f: File | null) {
    setFile(f);
    setErr(null);
    if (!f) return;
    setBusy(true);
    void api
      .previewTeam(f)
      .then((res) => setPreview(res))
      .catch((e) => setErr(fieldError(e)))
      .finally(() => setBusy(false));
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const { summary } = await api.syncTeam(file);
      onApplied(summary, summary.created);
      setPreview(null);
      setFile(null);
    } catch (e) {
      setErr(fieldError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = preview?.plan.removedBlocked ?? [];

  return (
    <section className="section">
      <h3>👥 Team members (valid borrowers & login users)</h3>
      <div className="row">
        <label className="dropzone inline">
          Upload team list (.xlsx)
          <input type="file" accept=".xlsx" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
        </label>
        <a className="ghost download-link" href={api.teamTemplateUrl()} download>
          📥 Download Excel template
        </a>
      </div>
      {busy && <Spinner />}
      {err && <Flash error={err} />}
      {preview && (
        <>
          <p>
            📄 {preview.plan.members} member(s) read — <b>{preview.plan.added}</b> new,{" "}
            <b>{preview.plan.updated}</b> updated, <b>{preview.plan.toRemove}</b> removed.
          </p>
          <DataTable
            rows={preview.members.map((m) => ({
              "First Name": m.firstName,
              "Last Name": m.lastName,
              Department: m.department,
              Team: m.team,
              Group: m.group,
            }))}
          />
          {blocked.length > 0 ? (
            <Banner kind="error">
              This update cannot be applied. The following members still have borrowed books and
              cannot be removed:{" "}
              {blocked.map((n) => `${n.name} (${n.books.join(", ")})`).join("; ")}. Return the
              book(s) first, then upload the file again.
            </Banner>
          ) : (
            <button type="button" className="primary" onClick={apply} disabled={busy}>
              ✔️ Apply team update
            </button>
          )}
        </>
      )}
    </section>
  );
}

function AdminMaintenance({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [group, setGroup] = useState<string>("general");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.team().then(({ members: m }) => setMembers(m));
  }, []);

  const active = members?.filter((m) => m.active) ?? [];
  const target = active.find((m) => m.id === targetId) ?? active[0];

  useEffect(() => {
    if (target && (target.groupName ?? "") !== group) {
      setGroup(target.groupName ?? "general");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  async function run(fn: () => Promise<{ msg: string }>) {
    setErr(null);
    setMsg(null);
    try {
      const res = await fn();
      setMsg(res.msg);
    } catch (e) {
      setErr(fieldError(e));
    }
  }

  return (
    <section className="section">
      <details>
        <summary>⚙️ Admin: user maintenance (reset password · change group)</summary>
        {active.length === 0 ? (
          <p className="muted">No active users to maintain.</p>
        ) : (
          target && (
            <>
              <div className="row">
                <label>
                  User
                  <select
                    value={target.id ?? ""}
                    onChange={(e) => setTargetId(Number(e.target.value))}
                  >
                    {active.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.id} · {p.name} ({p.department} · {p.team})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Group
                  <select value={group} onChange={(e) => setGroup(e.target.value)}>
                    <option value="admin">admin</option>
                    <option value="power">power</option>
                    <option value="general">general</option>
                  </select>
                </label>
              </div>
              {target.id === user.borrowerId && (
                <Banner kind="info">You cannot change your own group or reset your own password here.</Banner>
              )}
              {msg && <Banner kind="ok">{msg}</Banner>}
              {err && <Flash error={err} />}
              <div className="row">
                <button
                  type="button"
                  className="ghost"
                  disabled={target.id === user.borrowerId}
                  onClick={() =>
                    void run(async () => {
                      const res = await api.resetPassword(target.id!);
                      return {
                        msg: `Password reset for ${res.target} to ${res.defaultPassword} — they must change it on next login.`,
                      };
                    })
                  }
                >
                  🔁 Reset password to default
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={target.id === user.borrowerId || group === (target.groupName ?? "general")}
                  onClick={() =>
                    void run(async () => {
                      const res = await api.setGroup(target.id!, group);
                      onChanged();
                      return { msg: `${res.target} is now in the ${res.group} group.` };
                    })
                  }
                >
                  💾 Save group
                </button>
              </div>
            </>
          )
        )}
      </details>
    </section>
  );
}