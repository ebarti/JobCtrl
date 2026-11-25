import { expect, modelCall, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { citeSources, modelSources } from "./requirements-data.js";

/** The external provider makes an explicit choice over the offered synthetic sources. */
export type InvalidRoleTarget = "missing_field" | "unknown_verdict" | "foreign_source" | "extra_field" | "nonverbatim" | "title_only";

export function roleTargetStream(app: ApplicationStack): ApplicationStack {
  return { ...app, external: { ...app.external, next: (options) => app.external.next({
    ...options, match: (call) => call.path === "/model" && call.body["operation"] === "discovery.role_target_match",
  }) } };
}

export async function serveRoleTarget(app: ApplicationStack, verdict: "match" | "mismatch" | "unknown", invalid?: InvalidRoleTarget) {
  const call = await modelCall(app, "discovery.role_target_match");
  replyRoleTarget(call, verdict, invalid);
}

export function replyRoleTarget(call: ExternalCall, verdict: "match" | "mismatch" | "unknown", invalid?: InvalidRoleTarget) {
  expect(call.path).toBe("/model");
  expect(call.body["operation"]).toBe("discovery.role_target_match");
  expect(call.body["lane"]).toBe("discovery");
  const sourceIds = modelSources(call).map((source) => source.source_id);
  expect(sourceIds).toEqual(expect.arrayContaining(["target:roles", "posting:title"]));
  expect(sourceIds.every((id) => ["target:roles", "target:tracks", "target:seniority", "target:functions", "target:specializations", "posting:title", "posting:description"].includes(id))).toBe(true);
  const citations = citeSources(call, ["target:roles", "posting:description"]);
  if (invalid === "nonverbatim") citations[1] = { source_id: "posting:description", quote: "A sentence outside the offered description." };
  if (invalid === "foreign_source") citations[1] = { ...citations[1]!, source_id: "another-posting:description" };
  if (invalid === "title_only") citations[1] = citeSources(call, ["posting:title"])[0]!;
  const decision: Record<string, unknown> = { verdict, citations, rationale: "Explicit source-bound choice for this synthetic role review." };
  if (invalid === "missing_field") delete decision["rationale"];
  if (invalid === "unknown_verdict") decision["verdict"] = "outside-the-contract";
  if (invalid === "extra_field") decision["additional_decision"] = true;
  call.reply(decision);
}
