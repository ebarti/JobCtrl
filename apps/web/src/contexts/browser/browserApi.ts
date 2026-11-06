import { BrowserCapabilitiesResponseSchema, ExtensionCapabilityTokenResponseSchema } from "@jobctrl/contracts";
import { z } from "zod";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";

const bridgeSchema = z.object({
  ok: z.literal(true), connected: z.boolean(), installationBound: z.boolean(),
  installationIdSuffix: z.string().nullable(), lastSeenAt: z.string().nullable(),
  extensionVersion: z.string().nullable(), pendingTasks: z.number().int().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
}).strict();

export function parseBrowserCapabilities(value: unknown) {
  const parsed = BrowserCapabilitiesResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Browser capability status returned an invalid response.");
  return parsed.data;
}
export function parseExtensionToken(value: unknown) {
  const parsed = ExtensionCapabilityTokenResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("The extension pairing response is invalid.");
  return parsed.data;
}
export function parseBrowserCapabilitiesWrite(value: unknown, path: string) {
  try { return parseBrowserCapabilities(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}
export function parseExtensionTokenWrite(value: unknown, path: string) {
  try { return parseExtensionToken(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}
export function parseBrowserBridge(value: unknown) {
  const parsed = bridgeSchema.safeParse(value);
  if (!parsed.success) throw new Error("Extension status returned an invalid response.");
  return parsed.data;
}
