import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "library.db");

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  sessionSecret: string;
  cookieName: string;
  allowDemoData: boolean;
  trackIsbn: boolean;
  trackCost: boolean;
  trackCopies: boolean;
  trackBorrowerContact: boolean;
  webDistDir: string;
}

export const GROUPS = ["admin", "power", "general"] as const;
export type GroupName = (typeof GROUPS)[number];
export const GROUP_ADMIN: GroupName = "admin";
export const GROUP_POWER: GroupName = "power";
export const GROUP_GENERAL: GroupName = "general";

export const DEFAULT_PASSWORD_SUFFIX = "1234o$";
export const PBKDF2_ITERATIONS = 200_000;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? DEFAULT_DB_PATH,
    sessionSecret:
      env.SESSION_SECRET ??
      "dev-only-secret-change-me-please-use-at-least-32-random-characters",
    cookieName: env.COOKIE_NAME ?? "calibr_session",
    allowDemoData: bool(env.ALLOW_DEMO_DATA, true),
    trackIsbn: bool(env.TRACK_ISBN, true),
    trackCost: bool(env.TRACK_COST, true),
    trackCopies: bool(env.TRACK_COPIES, true),
    trackBorrowerContact: bool(env.TRACK_BORROWER_CONTACT, true),
    webDistDir:
      env.WEB_DIST_DIR ?? path.resolve(__dirname, "..", "..", "web", "dist"),
  };
}