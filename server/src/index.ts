import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { Repository } from "./db/repository.js";
import { Library } from "./domain/library.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/errors.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerBookRoutes } from "./routes/books.js";
import { registerLoanRoutes } from "./routes/loans.js";
import { registerTeamRoutes } from "./routes/team.js";

export interface BuildOptions {
  config?: AppConfig;
  dbPath?: string;
  log?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<{
  app: FastifyInstance;
  lib: Library;
  config: AppConfig;
}> {
  const config = options.config ?? loadConfig();
  const dbPath = options.dbPath ?? config.dbPath;

  const repo = new Repository(dbPath);
  const lib = new Library(repo);

  const app = Fastify({
    logger: options.log === false ? false : { level: "info" },
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  registerErrorHandler(app);
  registerAuthPlugin(app, {
    secret: config.sessionSecret,
    cookieName: config.cookieName,
    lib,
  });

  registerSetupRoutes(app, lib, config);
  registerBookRoutes(app, lib, config);
  registerLoanRoutes(app, lib);
  registerTeamRoutes(app, lib);

  app.get("/health", async () => ({ ok: true, api: "calibr" }));

  // SPA middleware: serve the built React app, falling back to index.html.
  const distDir = config.webDistDir;
  if (fs.existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: "/",
      wildcard: false,
      index: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.type("text/html").send(
        fs.readFileSync(path.join(distDir, "index.html")),
      );
    });
  } else {
    app.log.warn(`web/dist not found at ${distDir} — serving API only`);
  }

  return { app, lib, config };
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp({ config });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Start only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}