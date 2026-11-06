import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { test, expect, json } from "../harness/fixtures.js";
import { createBaseline, type Profile } from "./core-data.js";

test.use({ features: "profile,jobs,discovery" });

type Settings = {
  revision: number;
  defaultProvider: string;
  providerModels: Record<string, string>;
};
type Credentials = {
  revision: number;
  credentials: { key: string; configured: boolean; editable: boolean }[];
};
type Discovery = {
  revision: number;
  settings: { queries: string[]; locations: string[] };
};

test("CLI onboarding preserves authored state and saves a hidden key through canonical setup", async ({
  app,
  api,
}) => {
  const { profile } = await createBaseline(api);
  const previousSearch = await json<Discovery>(api, "get", "/v1/discovery/settings");
  const search = await json<Discovery>(api, "patch", "/v1/discovery/settings", {
    expectedRevision: previousSearch.revision,
    queries: ["Synthetic Reliability Engineer"],
    locations: ["Synthetic City"],
  });
  const initialSettings = await json<Settings>(api, "get", "/v1/settings");
  const initialCredentials = await json<Credentials>(api, "get", "/v1/credentials");

  const absentWorkspace = path.join(app.directory, "uncreated-cli-workspace");
  const help = await app.cli(["--workspace", absentWorkspace, "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("setup");
  const version = await app.cli(["--workspace", absentWorkspace, "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.trim()).toMatch(/^jobctrl \d+\.\d+\.\d+/);
  const dryRun = await app.cli([
    "--workspace", absentWorkspace,
    "setup", "--provider", "codex", "--launch-logins", "--dry-run", "--json",
  ]);
  expect(dryRun.exitCode, dryRun.stderr).toBe(0);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({
    dryRun: true,
    codexLoginRequested: true,
    liveValidation: "required_when_applied",
  });
  await expect(lstat(absentWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await json<Settings>(api, "get", "/v1/settings")).toEqual(initialSettings);
  expect((await json<Credentials>(api, "get", "/v1/credentials")).revision).toBe(initialCredentials.revision);

  const initialized = await app.cli(["init"]);
  expect(initialized.exitCode, initialized.stderr).toBe(0);
  const onboarding = JSON.parse(initialized.stdout) as {
    ok: boolean;
    nextSteps: { path?: string; command?: string }[];
  };
  expect(onboarding.ok).toBe(true);
  expect(onboarding.nextSteps.map((step) => step.path)).toEqual(
    expect.arrayContaining(["/profile", "/profile/import", "/discovery", "/settings/credentials"]),
  );
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profile);
  const retainedSearch = await json<Discovery>(api, "get", "/v1/discovery/settings");
  expect(retainedSearch.revision).toBe(search.revision);
  expect(retainedSearch.settings.queries).toEqual(search.settings.queries);
  expect(retainedSearch.settings.locations).toEqual(search.settings.locations);

  // Only the external credential executable receives this generated synthetic
  // value. It is stdin, never argv, a saved settings value or a test attachment.
  const syntheticSecret = "synthetic-not-a-real-key-" + randomUUID();
  const configured = await app.cli(
    ["setup", "--provider", "google", "--skip-doctor"],
    { input: ["y", syntheticSecret, "gemini-3.1-pro-preview", "y", ""].join("\n") },
  );
  expect([configured.stdout, configured.stderr].every((output) => !output.includes(syntheticSecret))).toBe(true);
  expect(configured.exitCode).toBe(0);
  const externalStore = JSON.parse((await app.file("synthetic-credential-store.json")).toString("utf8")) as Record<string, string>;
  expect(externalStore["GEMINI_API_KEY"] === syntheticSecret).toBe(true);
  const credentials = await json<Credentials>(api, "get", "/v1/credentials");
  expect(credentials.revision).toBeGreaterThan(initialCredentials.revision);
  expect(credentials.credentials.find((item) => item.key === "GEMINI_API_KEY")?.configured).toBe(true);
  expect(JSON.stringify(credentials).includes(syntheticSecret)).toBe(false);
  const selected = await json<Settings>(api, "get", "/v1/settings");
  expect(selected.defaultProvider).toBe("google");
  expect(selected.providerModels["google"]).toBe("gemini-3.1-pro-preview");
  expect(JSON.stringify(selected).includes(syntheticSecret)).toBe(false);

  const invalid = await app.cli([
    "setup", "--provider", "google", "--model", "model-not-in-this-live-catalog",
    "--non-interactive", "--skip-doctor", "--json",
  ]);
  expect(invalid.exitCode).not.toBe(0);
  expect([invalid.stdout, invalid.stderr].every((output) => !output.includes(syntheticSecret))).toBe(true);
  expect(await json<Settings>(api, "get", "/v1/settings")).toEqual(selected);
  expect((await json<Credentials>(api, "get", "/v1/credentials")).revision).toBe(credentials.revision);
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profile);
});
