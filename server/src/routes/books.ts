import type { FastifyInstance } from "fastify";
import type { Library } from "../domain/library.js";
import type { AppConfig } from "../config.js";

export function registerBookRoutes(
  app: FastifyInstance,
  lib: Library,
  config: Readonly<AppConfig>,
): void {
  // Everyone can read the catalog.
  app.get("/api/books", async (req) => {
    const q = req.query as { search?: string };
    return { books: lib.getBooks(q.search ?? "") };
  });

  app.get("/api/books/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { book: lib.getBook(Number(id)), view: lib.getBookView(Number(id)) };
  });

  // Writes require admin ("power" is view-only).
  app.post("/api/books", { preHandler: [app.requireAdmin] }, async (req) => {
    const body = req.body as {
      title?: string;
      author?: string;
      publisher?: string;
      isbn?: string;
      totalCopies?: number;
      cost?: number;
    };
    const book = lib.addBook(body.title ?? "", {
      author: body.author ?? "",
      publisher: body.publisher ?? "",
      isbn: config.trackIsbn ? body.isbn ?? "" : "",
      totalCopies: config.trackCopies ? Number(body.totalCopies ?? 1) : 1,
      cost: config.trackCost ? Number(body.cost ?? 0) : 0,
    });
    return { book };
  });

  app.put("/api/books/:id", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      title?: string;
      author?: string;
      publisher?: string;
      isbn?: string;
      totalCopies?: number;
      cost?: number;
      discontinued?: boolean;
      remarks?: string;
    };
    const book = lib.getBook(Number(id));
    book.title = body.title ?? book.title;
    book.author = body.author ?? book.author;
    book.publisher = body.publisher ?? book.publisher;
    book.isbn = config.trackIsbn ? body.isbn ?? book.isbn : book.isbn;
    book.totalCopies = config.trackCopies ? Number(body.totalCopies ?? book.totalCopies) : book.totalCopies;
    book.cost = config.trackCost ? Number(body.cost ?? book.cost) : book.cost;
    const views = lib.getBooks();
    const view = views.find((v) => v.id === book.id);
    book.discontinued = Boolean(body.discontinued ?? book.discontinued);
    if (body.remarks !== undefined && view && view.loanId !== null) {
      lib.updateRemarks(view.loanId, body.remarks);
    }
    lib.updateBook(book);
    return { book };
  });

  // Mark the currently-issued copy as returned ("borrower becomes --").
  app.post("/api/books/:id/clear-borrower", { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const count = lib.clearBorrower(Number(id));
    return { closed: count };
  });

  app.post("/api/admin/purge", { preHandler: [app.requireAdmin] }, async (_req) => {
    lib.repo.purgeAll();
    return { ok: true };
  });

  app.post("/api/admin/seed-demo", { preHandler: [app.requireAdmin] }, async () => {
    lib.seedDemoData();
    return { ok: true };
  });
}