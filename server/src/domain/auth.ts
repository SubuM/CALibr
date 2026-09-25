import crypto from "node:crypto";
import { DEFAULT_PASSWORD_SUFFIX, PBKDF2_ITERATIONS } from "../config.js";
import { ValidationError } from "./errors.js";
import type { TeamMember } from "./models.js";

// --------------------------------------------------------------------------- hashing
export interface PasswordHash {
  salt: string;
  hash: string;
}

export function hashPassword(password: string, saltHex?: string): PasswordHash {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    32,
    "sha256",
  );
  return { salt: salt.toString("hex"), hash: digest.toString("hex") };
}

export function verifyPassword(password: string, saltHex: string, passwordHash: string): boolean {
  try {
    const { hash } = hashPassword(password, saltHex);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(passwordHash, "hex"));
  } catch {
    return false;
  }
}

export function defaultPassword(username: string): string {
  return `${username}${DEFAULT_PASSWORD_SUFFIX}`;
}

// ---------------------------------------------------------------- login IDs
export function initialsUsername(member: { firstName: string; lastName: string }): string {
  const full = `${member.firstName} ${member.lastName}`.trim();
  const first = (member.firstName || full || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  const lastRaw = member.lastName || "";
  let last = lastRaw.trim().toUpperCase();
  if (!last) {
    const alnum = member.firstName.toUpperCase().replace(/[^A-Z0-9]/g, "");
    last = alnum.length > 1 ? alnum.slice(1, 3) : "XX";
  }
  return first + last.slice(0, 2);
}

export function usernameFromNames(first: string, last: string): string {
  return initialsUsername({ firstName: first, lastName: last });
}

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

/**
 * Enforce the password policy on a user-chosen password.
 *
 * Policy: 8-20 characters; at least 1 uppercase, 1 lowercase, 1 digit and 1
 * special character; must not contain the user's first/last name or login ID
 * (case-insensitive), must not contain a well-formed email address, and must
 * not be the initial password or one of the user's last 3 passwords (checked
 * at change time, not here).
 *
 * Exception: the initial password (login ID + suffix) is exempt by design —
 * it is the one password allowed to contain the login ID.
 */
export function validateNewPassword(
  password: string,
  opts: { firstName?: string; lastName?: string; username?: string } = {},
): void {
  const firstName = (opts.firstName ?? "").trim();
  const lastName = (opts.lastName ?? "").trim();
  const username = (opts.username ?? "").trim();
  const problems: string[] = [];

  if (!password) {
    problems.push("password is required");
  } else {
    if (username && password === defaultPassword(username)) {
      return;
    }
    if (password.length < 8 || password.length > 20) {
      problems.push("length must be between 8 and 20 characters");
    }
    if (!/[A-Z]/.test(password)) problems.push("must contain at least 1 uppercase letter");
    if (!/[a-z]/.test(password)) problems.push("must contain at least 1 lowercase letter");
    if (!/[0-9]/.test(password)) problems.push("must contain at least 1 digit");
    if (!/[^A-Za-z0-9]/.test(password)) {
      problems.push("must contain at least 1 special character");
    }
    if (EMAIL_RE.test(password)) problems.push("must not contain an email address");
    const low = password.toLowerCase();
    for (const tag of [firstName, lastName, username]) {
      if (tag.length >= 2 && low.includes(tag.toLowerCase())) {
        problems.push(`must not contain your name or login ID (“${tag}”)`);
      }
    }
  }

  if (problems.length > 0) {
    throw new ValidationError("Invalid password:\n• " + problems.join("\n• "));
  }
}

// ------------------------------------------------------------- token signing
export interface SessionClaims {
  borrowerId: number;
  exp: number;
}

export function signToken(claims: SessionClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.borrowerId !== "number" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}

export interface TeamMemberInput {
  firstName: string;
  lastName: string;
  department: string;
  team: string;
  group: string;
}

export { type TeamMember };