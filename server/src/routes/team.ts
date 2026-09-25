import type { FastifyInstance } from "fastify";
import type { Library } from "../domain/library.js";
import { parseTeamExcel } from "../domain/team-excel.js";
import { getUploadedFile } from "./upload.js";
import { GROUPS } from "../config.js";

export function registerTeamRoutes(app: FastifyInstance, lib: Library): void {
  app.get("/api/team", async (req) => {
    const q = req.query as { search?: string; activeOnly?: string };
    const borrowers = lib.getBorrowers(q.search ?? "", q.activeOnly === "true");
    const groupByBorrower = new Map<number, string>();
    for (const b of borrowers) {
      const u = lib.repo.userByBorrower(b.id!);
      groupByBorrower.set(b.id!, u?.groupName ?? "");
    }
    return {
      members: borrowers.map((b) => ({
        id: b.id,
        name: b.name,
        firstName: b.firstName,
        lastName: b.lastName,
        department: b.department,
        team: b.team,
        phone: b.phone,
        email: b.email,
        joinedAt: b.joinedAt,
        active: b.active,
        groupName: groupByBorrower.get(b.id!) ?? "",
      })),
    };
  });

  // Preview what an upload would add/update/remove without applying anything.
  app.post("/api/team/preview", { preHandler: [app.requireAdmin] }, async (req) => {
    const buffer = await getUploadedFile(req);
    const members = await parseTeamExcel(buffer);
    return {
      members: members.map((m) => m.toJSON()),
      plan: lib.planSync(members),
    };
  });

  // Apply the team sync.
  app.post("/api/team/sync", { preHandler: [app.requireAdmin] }, async (req) => {
    const buffer = await getUploadedFile(req);
    const members = await parseTeamExcel(buffer);
    const summary = lib.syncTeam(members, req.user!.borrowerId);
    return { summary };
  });

  // Admin: password reset + group change for a borrower.
  app.post("/api/team/:id/reset-password", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const targetId = Number(id);
    const target = lib.getBorrower(targetId);
    if (targetId === req.user!.borrowerId) {
      return { error: "you cannot reset your own password here" };
    }
    const defaultPw = lib.adminResetPassword(targetId);
    return { defaultPassword: defaultPw, target: target.name };
  });

  app.post("/api/team/:id/group", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { group?: string };
    const targetId = Number(id);
    const target = lib.getBorrower(targetId);
    if (targetId === req.user!.borrowerId) {
      return { error: "you cannot change your own group here" };
    }
    if (!(GROUPS as readonly string[]).includes(body.group ?? "")) {
      return { error: "unknown group" };
    }
    lib.adminSetGroup(targetId, body.group as (typeof GROUPS)[number]);
    return { target: target.name, group: body.group };
  });
}