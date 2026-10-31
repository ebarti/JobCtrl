import type { ContactDetail } from "@jobctrl/contracts";

/** Demo adapter boundary: include canonical facts and its persisted publication token.
 * Older saved demo workspaces without a token are still readable/editable.
 */
export async function demoContactFingerprint(contact: ContactDetail): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["demo-contact-edit-v1", contact]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
