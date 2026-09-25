import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signToken, verifyToken, type SessionClaims } from "../domain/auth.js";
import type { Library } from "../domain/library.js";
import type { SessionUser } from "../domain/models.js";

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
  interface FastifyInstance {
    requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export interface AuthPluginOptions {
  secret: string;
  cookieName: string;
  lib: Library;
}

export interface AuthUserJSON {
  borrowerId: number;
  username: string;
  name: string;
  groupName: string;
  mustChange: boolean;
}

export function serializeUser(user: SessionUser): AuthUserJSON {
  return {
    borrowerId: user.borrowerId,
    username: user.username,
    name: user.name,
    groupName: user.groupName,
    mustChange: user.mustChange,
  };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as "lax",
    secure: false,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function issueToken(secret: string, borrowerId: number): string {
  const claims: SessionClaims = {
    borrowerId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return signToken(claims, secret);
}

export function registerAuthPlugin(
  app: FastifyInstance,
  { secret, cookieName, lib }: AuthPluginOptions,
): void {
  app.decorateRequest("user", undefined);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const token = req.cookies[cookieName];
    if (!token) {
      req.user = undefined;
      return;
    }
    const claims = verifyToken(token, secret);
    if (!claims) {
      req.user = undefined;
      return;
    }
    const fresh = lib.repo.userByBorrower(claims.borrowerId);
    req.user = fresh ?? undefined;
  });

  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: "not authenticated" });
      return;
    }
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: "not authenticated" });
      return;
    }
    if (req.user.groupName !== "admin") {
      await reply.code(403).send({ error: "admin access required" });
    }
  });

  const cookieOptions = sessionCookieOptions();
  const COOKIE = cookieName;

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, cookieOptions).send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "not authenticated" });
    return reply.send({ user: serializeUser(req.user) });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    const user = lib.loginUser(username ?? "", password ?? "");
    reply.setCookie(COOKIE, issueToken(secret, user.borrowerId), cookieOptions);
    return reply.send({ user: serializeUser(user) });
  });

  app.post(
    "/api/auth/change-password",
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const { oldPassword, newPassword } = req.body as {
        oldPassword?: string;
        newPassword?: string;
      };
      lib.changePassword(req.user!, oldPassword ?? "", newPassword ?? "");
      const fresh = lib.repo.userByBorrower(req.user!.borrowerId)!;
      return reply.send({ user: serializeUser(fresh) });
    },
  );
}