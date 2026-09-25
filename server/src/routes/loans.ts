import type { FastifyInstance } from "fastify";
import type { Library } from "../domain/library.js";

export function registerLoanRoutes(app: FastifyInstance, lib: Library): void {
  app.get("/api/loans", async (req) => {
    const q = req.query as { includeReturned?: string };
    const includeReturned = q.includeReturned !== "false";
    return {
      loans: includeReturned ? lib.getLoanHistory() : lib.getActiveLoans(),
    };
  });

  app.get("/api/loans/mine", { preHandler: [app.requireAuth] }, async (req) => {
    return { loans: lib.ownLoans(req.user!.borrowerId) };
  });

  app.post("/api/loans", { preHandler: [app.requireAdmin] }, async (req) => {
    const body = req.body as { bookId?: number; borrowerId?: number; borrowDate?: string };
    const loan = lib.borrow(
      Number(body.bookId),
      Number(body.borrowerId),
      body.borrowDate,
    );
    return { loan };
  });

  app.post("/api/loans/:id/return", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { returnDate?: string; remarks?: string };
    const loan = lib.returnBook(Number(id), body.returnDate, body.remarks ?? "");
    return { loan };
  });

  app.post("/api/loans/:id/remarks", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { remarks?: string };
    lib.updateRemarks(Number(id), body.remarks ?? "");
    return { ok: true };
  });

  app.get("/api/stats", async () => {
    return { stats: lib.stats() };
  });
}