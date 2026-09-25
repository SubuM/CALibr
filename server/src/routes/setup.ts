import type { FastifyInstance } from "fastify";
import type { Library } from "../domain/library.js";
import type { AppConfig } from "../config.js";
import { parseTeamExcel, teamTemplateBytes } from "../domain/team-excel.js";
import { signToken } from "../domain/auth.js";
import { getUploadedFile } from "./upload.js";

export function registerSetupRoutes(
  app: FastifyInstance,
  lib: Library,
  config: Readonly<AppConfig>,
): void {
  // Public bootstrap state: the UI uses this to decide first-run vs login.
  app.get("/api/app/config", async () => {
    return {
      hasUsers: lib.repo.countUsers() > 0,
      hasAdmins: lib.repo.countAdmins() > 0,
      allowDemoData: config.allowDemoData,
      trackIsbn: config.trackIsbn,
      trackCost: config.trackCost,
      trackCopies: config.trackCopies,
      passwordSuffix: "1234o$",
    };
  });

  // First-run preview: parse the team file WITHOUT applying anything.
  app.post("/api/setup/preview", async (req, reply) => {
    const buffer = await getUploadedFile(req);
    const members = await parseTeamExcel(buffer);
    return reply.send({ members: members.map((m) => m.toJSON()) });
  });

  // First-run bootstrap: upload the team file. Only valid when no users exist.
  app.post("/api/setup/team", async (req, reply) => {
    const buffer = await getUploadedFile(req);
    const members = await parseTeamExcel(buffer);
    const summary = lib.setupFirstTeam(members);
    return reply.send({
      summary: {
        added: summary.added,
        admins: members.filter((m) => m.group === "admin").length,
      },
    });
  });

  // Create the very first admin (used when the file has no admin group).
  app.post("/api/setup/admin", async (req, reply) => {
    const body = req.body as {
      firstName?: string;
      lastName?: string;
      username?: string;
      password?: string;
    };
    const user = lib.createFirstAdmin(
      body.firstName ?? "",
      body.lastName ?? "",
      body.username ?? "",
      body.password ?? "",
    );
    const claims = { borrowerId: user.borrowerId, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60 };
    reply.setCookie(config.cookieName, signToken(claims, config.sessionSecret), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return reply.send({ user });
  });

  // Download an Excel template for the team list.
  app.get("/api/team/template", async (_req, reply) => {
    const buf = await teamTemplateBytes();
    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", 'attachment; filename="calibr_team_template.xlsx"')
      .send(buf);
  });
}