import { describe, expect, it, vi } from "vitest";

import { validatePublicHttpUrl } from "../src/public-url-safety.js";

describe("validatePublicHttpUrl", () => {
  it.each([
    "http://127.0.0.1/private",
    "http://127.1/private",
    "http://2130706433/private",
    "http://[::1]/private",
    "http://192.168.1.23/jobs/internal",
    "http://10.0.0.2/jobs/internal",
    "http://169.254.169.254/latest/meta-data",
    "http://[fc00::1]/private",
  ])("rejects a private literal before DNS: %s", async (url) => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);

    await expect(validatePublicHttpUrl(url, resolver)).resolves.toMatchObject({
      allowed: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any resolved address is private", async () => {
    await expect(
      validatePublicHttpUrl("https://jobs.example/role", async () => [
        "93.184.216.34",
        "10.0.0.5",
      ]),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    "localhost",
    "localhost.",
    "jobs.local",
    "jobs.internal",
    "jobs.lan",
  ])("rejects a local network alias before DNS: %s", async (hostname) => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);

    await expect(
      validatePublicHttpUrl(`https://${hostname}/role`, resolver),
    ).resolves.toMatchObject({
      allowed: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects embedded credentials before DNS", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);

    await expect(
      validatePublicHttpUrl(
        "https://user:password@jobs.example/role",
        resolver,
      ),
    ).resolves.toMatchObject({ allowed: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("accepts a hostname only when every resolved address is public", async () => {
    await expect(
      validatePublicHttpUrl("https://jobs.example/role", async () => [
        "93.184.216.34",
        "2606:4700:4700::1111",
      ]),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed when DNS resolution is unavailable", async () => {
    await expect(
      validatePublicHttpUrl("https://jobs.example/role", async () => {
        throw new Error("DNS unavailable");
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
