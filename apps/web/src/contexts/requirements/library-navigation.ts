import { z } from "zod";

import { REQUIREMENTS_TABLE_COLUMN_IDS } from "../../shared/stores/saved-table-views.js";

const columnFilterSchema = z.object({
  operator: z.enum(["contains", "does_not_contain"]),
  text: z.string().max(2400),
  selectedValues: z.array(z.string().max(2400)).max(200),
}).strict();
const columnFiltersSchema = z.partialRecord(z.enum(REQUIREMENTS_TABLE_COLUMN_IDS), columnFilterSchema)
  .refine((value) => JSON.stringify(value).length <= 16000, "Requirement filters exceed the URL limit.");

export const requirementsLibrarySearchSchema = z.object({
  q: z.string().max(10000).default("").catch(""),
  requirement: z.string().min(1).max(200).optional().catch(undefined),
  sort: z.enum(REQUIREMENTS_TABLE_COLUMN_IDS).default("name").catch("name"),
  dir: z.enum(["asc", "desc"]).default("asc").catch("asc"),
  page: z.coerce.number().int().min(1).max(100000).default(1).catch(1),
  pageSize: z.coerce.number().int().refine((value) => [25, 50, 100, 200].includes(value)).default(25).catch(25),
  column_filters: columnFiltersSchema.optional().catch(undefined),
});

export type RequirementsLibrarySearch = z.infer<typeof requirementsLibrarySearchSchema>;
export type RequirementsTableState = Omit<RequirementsLibrarySearch, "requirement">;

export const requirementsReturnTableSchema = z.string().max(30000).refine((value) => {
  try { return requirementsLibrarySearchSchema.safeParse(JSON.parse(value)).success; }
  catch { return false; }
}).optional().catch(undefined);

export function requirementTableReturnState(state: RequirementsTableState): string {
  const { requirement: _selection, ...table } = requirementsLibrarySearchSchema.parse(state);
  return JSON.stringify(table);
}

export function requirementsReturnSearch(requirement: string, q = "", table?: string): RequirementsLibrarySearch {
  let parsed: unknown = {};
  const result = requirementsReturnTableSchema.safeParse(table);
  if (result.success && result.data) {
    try { parsed = JSON.parse(result.data); } catch { /* A missing return context uses the ordinary table defaults. */ }
  }
  return { ...requirementsLibrarySearchSchema.parse(parsed), requirement, q };
}
