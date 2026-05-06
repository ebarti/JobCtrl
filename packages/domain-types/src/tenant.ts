/**
 * TenantId value object — scopes all domain entities and events.
 *
 * In local-first mode, TenantId is the singleton constant LOCAL_TENANT ("local").
 * In hosted multi-tenant mode, TenantId is the authenticated user's tenant,
 * injected from the JWT claims by API middleware.
 */

declare const __brand: unique symbol;

/** Branded string type for compile-time tenant identity safety. */
export type TenantId = string & { readonly [__brand]: "TenantId" };

/** Create a TenantId from a raw string. Throws if empty. */
export function createTenantId(value: string): TenantId {
  if (!value || value.trim().length === 0) {
    throw new Error("TenantId cannot be empty");
  }
  return value as TenantId;
}

/** Default tenant for single-user local mode. */
export const LOCAL_TENANT: TenantId = "local" as TenantId;
