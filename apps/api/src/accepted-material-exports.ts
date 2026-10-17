import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  AcceptedMaterialExportParamsSchema,
  AcceptedMaterialExportReceiptSchema,
  AcceptedMaterialExportsSchema,
  RpcMethods,
  type AcceptedMaterialExportRequest,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class MaterialExportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

// Only content-free, owned failure codes cross the worker boundary.
const failures: Readonly<Record<string, number>> = {
  invalid_export_request: 400,
  job_not_found: 404,
  accepted_source_unavailable: 409,
  stale_source_generation: 409,
  stale_export_source: 409,
  source_bytes_or_metadata_unavailable: 409,
  unsupported_source_format: 422,
  source_too_large: 422,
  unsupported_source_locale: 422,
  source_locale_mismatch: 409,
  unsupported_source_kind: 422,
  source_text_empty: 422,
  unsupported_source_characters: 422,
  unsupported_export_settings: 400,
  artifact_path_outside_workspace: 403,
  export_validation_failed: 503,
  export_history_unavailable: 503,
};

export async function acceptedMaterialExports(
  dispatcher: JsonRpcDispatcher,
  context: {
    tenantId: string;
    expectedAppDir: string;
    expectedDbPath: string;
    jobId: string;
  },
  request: AcceptedMaterialExportRequest,
) {
  const params = AcceptedMaterialExportParamsSchema.parse({
    ...context,
    request,
  });
  let response;
  try {
    response = await dispatcher.call(
      RpcMethods.AcceptedMaterialExports,
      params,
    );
  } catch {
    throw new MaterialExportError("export_worker_unavailable", 503);
  }
  if (response.error) {
    const status = Object.hasOwn(failures, response.error.message)
      ? failures[response.error.message]
      : undefined;
    throw new MaterialExportError(
      status ? response.error.message : "export_worker_unavailable",
      status ?? 503,
    );
  }
  const parsed = AcceptedMaterialExportsSchema.safeParse(response.result);
  if (!parsed.success)
    throw new MaterialExportError("invalid_export_worker_result", 503);
  const result = parsed.data;
  if (
    result.tenantId !== context.tenantId ||
    result.jobId !== context.jobId ||
    result.exports.some(
      (row) => row.tenantId !== context.tenantId || row.jobId !== context.jobId,
    )
  ) {
    throw new MaterialExportError("invalid_export_worker_binding", 503);
  }
  if (request.operation === "export") {
    const receipt = result.exports.find(
      (row) => row.artifactId === result.exportedArtifactId,
    );
    if (
      !receipt ||
      receipt.sourceArtifactId !== request.sourceArtifactId ||
      receipt.generation !== request.expectedGeneration ||
      receipt.settings.paper !== request.paper ||
      receipt.sourceSha256 !== request.expectedSourceSha256 ||
      receipt.sourceMetadataSha256 !== request.expectedMetadataSha256
    ) {
      throw new MaterialExportError("invalid_export_worker_binding", 503);
    }
  } else if (result.exportedArtifactId !== null) {
    throw new MaterialExportError("invalid_export_worker_binding", 503);
  }
  return result;
}

/** Read immutable retained bytes; source supersession must not erase an earlier export. */
export function readAcceptedDocx(
  db: SqliteDatabase,
  appDir: string,
  artifactId: string,
) {
  if (!/^[1-9][0-9]*$/.test(artifactId))
    throw new MaterialExportError("export_not_found", 404);
  const row = db
    .prepare(
      "SELECT job_id,path,metadata_json FROM job_artifacts WHERE artifact_id=? AND tenant_id='local' AND stage='export' AND artifact_type='material_docx' AND status='approved'",
    )
    .get(artifactId) as
    | { job_id: string; path: string; metadata_json: string }
    | undefined;
  if (!row) throw new MaterialExportError("export_not_found", 404);
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    throw new MaterialExportError("export_receipt_invalid", 409);
  }
  const parsed = AcceptedMaterialExportReceiptSchema.safeParse({
    ...(metadata as object),
    artifactId,
  });
  if (
    !parsed.success ||
    parsed.data.tenantId !== "local" ||
    parsed.data.jobId !== row.job_id
  ) {
    throw new MaterialExportError("export_receipt_invalid", 409);
  }
  const receipt = parsed.data;
  let descriptor: number | undefined;
  try {
    const root = fs.realpathSync(appDir);
    const absolute = path.resolve(row.path);
    const relative = path.relative(path.resolve(appDir), absolute);
    const resolvedRelative = path.relative(root, absolute);
    const parts = (
      relative.startsWith(`..${path.sep}`) ? resolvedRelative : relative
    ).split(path.sep);
    if (
      !path.isAbsolute(row.path) ||
      parts.length !== 3 ||
      parts[0] !== "generated" ||
      parts[1] !== "material-exports" ||
      !/^[a-f0-9]{32}\.docx$/.test(parts[2] ?? "")
    ) {
      throw new MaterialExportError("export_path_forbidden", 403);
    }
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw new MaterialExportError("export_path_forbidden", 403);
    }
    descriptor = fs.openSync(
      current,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 5_000_000)
      throw new MaterialExportError("export_bytes_invalid", 409);
    const data = fs.readFileSync(descriptor);
    if (createHash("sha256").update(data).digest("hex") !== receipt.sha256) {
      throw new MaterialExportError("export_bytes_changed", 409);
    }
    const kind = receipt.kind === "tailored_resume" ? "resume" : "cover-letter";
    return {
      data,
      filename: `${kind}-g${receipt.generation}-${receipt.settings.paper}.docx`,
    };
  } catch (error) {
    if (error instanceof MaterialExportError) throw error;
    throw new MaterialExportError("export_file_unavailable", 404);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
