import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import {
  ArtifactListQuerySchema,
  JobListQuerySchema,
} from "./contracts.js";
import { databaseExists, openReadOnlyDatabase } from "./db.js";
import {
  buildDashboardSummary,
  getArtifactDetail,
  getJobDetail,
  listArtifacts,
  listJobs,
  readProfileConfig,
  readSettingsConfig,
} from "./read-model.js";

const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https?:\/\/\[::1\](?::\d+)?$/,
];

export interface BuildAppOptions {
  dbPath: string;
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
  settingsPath: string;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  void app.register(cors, {
    origin: LOCAL_ORIGIN_PATTERNS,
  });

  app.get("/v1/health", async () => ({
    ok: true,
    dbPath: options.dbPath,
    dbExists: databaseExists(options.dbPath),
  }));

  app.get("/v1/dashboard/summary", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => buildDashboardSummary(db)),
  );

  app.get("/v1/jobs", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listJobs(db, JobListQuerySchema.parse(request.query))),
  );

  app.get<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getJobDetail(db, decodeRouteParam(request.params.jobKey));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "job_not_found" };
      }
      return detail;
    }),
  );

  app.get("/v1/artifacts", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listArtifacts(db, ArtifactListQuerySchema.parse(request.query))),
  );

  app.get<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getArtifactDetail(db, decodeRouteParam(request.params.artifactId));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "artifact_not_found" };
      }
      return detail;
    }),
  );

  app.get("/v1/profile", async () =>
    readProfileConfig({
      profilePath: options.profilePath,
      resumeStylePath: options.resumeStylePath,
      resumeTemplatePath: options.resumeTemplatePath,
    }),
  );

  app.get("/v1/settings", async () => readSettingsConfig({ settingsPath: options.settingsPath }));

  return app;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withDb<T>(
  reply: { code: (statusCode: number) => unknown },
  dbPath: string,
  read: (db: ReturnType<typeof openReadOnlyDatabase>) => T,
): T | { ok: false; error: string; message: string } {
  if (!databaseExists(dbPath)) {
    void reply.code(503);
    return { ok: false, error: "db_not_found", message: `No JobHunter database found at ${dbPath}` };
  }
  const db = openReadOnlyDatabase(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
