import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { AppConfig, User } from "./types";
import { Login, ForcedChange } from "./pages/Login";
import { FirstRun } from "./pages/FirstRun";
import { MainApp } from "./pages/MainApp";
import { Spinner } from "./components/ui";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const refreshUser = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.appConfig();
        if (cancelled) return;
        setConfig(cfg);
        await refreshUser();
      } catch (err) {
        console.error("failed to reach API", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  if (!ready || !config) {
    return (
      <div className="page center thin">
        <Spinner />
        <p className="muted">Connecting to CALibr…</p>
      </div>
    );
  }

  // Fresh DB with no accounts yet → guided first-run setup.
  if (!config.hasUsers) {
    return <FirstRun config={config} onAuthed={(u) => setUser(u)} />;
  }

  if (!user) {
    return <Login config={config} onAuthed={(u) => setUser(u)} />;
  }

  if (user.mustChange) {
    return (
      <ForcedChange
        user={user}
        passwordSuffix={config.passwordSuffix}
        onChanged={(updated) => setUser({ ...updated, mustChange: false })}
        onLogout={() => {
          void api.logout();
          setUser(null);
        }}
      />
    );
  }

  return (
    <MainApp
      user={user}
      config={config}
      refreshUser={refreshUser}
      onLogout={async () => {
        try {
          await api.logout();
        } catch (err) {
          void err;
        }
        setUser(null);
      }}
    />
  );
}

export { ApiError };