import type { APIRequestContext } from "@playwright/test";
import { action, expect, json, terminal, test, type ApplicationStack } from "../harness/fixtures.js";

test.use({ discoveryTransport: "jobstreaming", features: "profile,jobs,discovery" });

const search = { queries: ["Synthetic service vacancy"], locations: ["Madrid"], hoursOld: 0, newJobLimit: 2 };
const publicCode = "discovery_provider_authentication_configuration";

type BoardFailure = { unitId: string; boards: string[]; code: string; diagnostic: string; message: string; httpStatus?: number };

async function failuresFor(api: APIRequestContext, app: ApplicationStack, runId: string) {
  expect((await terminal(api, runId)).status).toBe("failed");
  const { runs } = await json<{ runs: { runId: string; failures: BoardFailure[] }[] }>(api, "get", "/v1/discovery/runs");
  const failures = runs.find((row) => row.runId === runId)!.failures;
  const { events } = await json<{ events: { payload: { sourceFailure?: BoardFailure } }[] }>(api, "get",
    `/v1/events?aggregateId=${runId}&type=DiscoveryRunUpdated&stage=board_search`);
  expect(events.map((event) => event.payload.sourceFailure)).toEqual(expect.arrayContaining(failures));
  expect(events).toHaveLength(failures.length);
  const saved = await app.discoveryCheckpoint(runId);
  for (const failure of failures) {
    expect(saved.units.find((unit) => unit.unitId === failure.unitId)).toMatchObject({ status: "failed", result: { failure } });
    expect(failure.code).toBe(publicCode);
  }
  return failures;
}

test("board access diagnostics preserve a missing ZipRecruiter credential and a refused Indeed credential", async ({ api, app }) => {
  const started = await action(api, "discovery.search", { ...search, boards: ["zip_recruiter", "indeed"] });
  const call = await app.external.next();
  expect(call.path).toBe("/jobstreaming/indeed");
  call.respond({ reason: "Synthetic private access refusal" }, 401);
  const failures = await failuresFor(api, app, started.runId);
  expect(failures).toEqual([
    expect.objectContaining({ boards: ["zip_recruiter"], diagnostic: "missing_credential", message: expect.stringContaining("JOBSTREAMING_ZIPRECRUITER_AUTHORIZATION") }),
    expect.objectContaining({ boards: ["indeed"], diagnostic: "provider_access_denied", httpStatus: 401, message: expect.stringContaining("HTTP 401") }),
  ]);
  expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(1);

  const apiRefused = await action(api, "discovery.search", { ...search, boards: ["indeed"] });
  (await app.external.next()).respond({ errors: [{ message: "Unauthorized: synthetic private diagnostic marker" }] });
  const denied = await failuresFor(api, app, apiRefused.runId);
  expect(denied).toEqual([expect.objectContaining({ diagnostic: "provider_access_denied", message: expect.stringContaining("authentication or access error") })]);
  expect(JSON.stringify(denied)).not.toContain("private diagnostic marker");
});

test.describe("Indeed without a key", () => {
  test.use({ discoveryTransport: "jobstreaming-indeed-missing" });

  test("board access diagnostics preserve a missing Indeed key and a ZipRecruiter HTTP denial", async ({ api, app }) => {
    const started = await action(api, "discovery.search", { ...search, boards: ["indeed", "zip_recruiter"] });
    const call = await app.external.next();
    expect(call.path).toContain("/jobstreaming/ziprecruiter/jobs-app/jobs");
    call.respond({}, 403);
    expect(await failuresFor(api, app, started.runId)).toEqual([
      expect.objectContaining({ boards: ["indeed"], diagnostic: "missing_credential", message: expect.stringContaining("JOBSTREAMING_INDEED_API_KEY") }),
      expect.objectContaining({ boards: ["zip_recruiter"], diagnostic: "provider_access_denied", httpStatus: 403, message: expect.stringContaining("HTTP 403") }),
    ]);
    expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(1);
  });
});

test.describe("local TLS failure", () => {
  test.use({ discoveryTransport: "jobstreaming-tls-failure" });

  test("board access diagnostics distinguish a TLS failure from a board credential failure", async ({ api, app }) => {
    const started = await action(api, "discovery.search", { ...search, boards: ["indeed"] });
    expect(await failuresFor(api, app, started.runId)).toEqual([
      expect.objectContaining({ boards: ["indeed"], diagnostic: "tls_configuration", message: expect.stringContaining("TLS configuration") }),
    ]);
    expect(app.external.calls.filter((outbound) => outbound.path.startsWith("/jobstreaming/"))).toHaveLength(0);
  });
});
