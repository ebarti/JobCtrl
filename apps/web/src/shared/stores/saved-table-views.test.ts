import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SAVED_TABLE_VIEW_ID,
  JOBS_TABLE_COLUMN_IDS,
  JOBS_TABLE_ID,
  normalizeSavedTableViewsState,
  useSavedTableViewsStore,
  type SavedTableViewSnapshot,
} from "./saved-table-views.js";

const snapshot: SavedTableViewSnapshot = {
  columns: {
    order: [...JOBS_TABLE_COLUMN_IDS],
    hidden: ["company"],
    widths: { title: 320 },
  },
  density: "compact",
  sort: { columnId: "fit_score", direction: "desc" },
  urlFilters: {
    q: "platform",
    stage: "apply",
    pageSize: 25,
    discoveredSince: "2026-07-01T00:00:00.000Z",
    scoredSince: "2026-07-01T00:00:00.000Z",
  },
  gridFilters: {
    source: { operator: "contains", text: "greenhouse", selectedValues: [] },
  },
  grouping: null,
  colorRules: [],
};

beforeEach(() => {
  window.localStorage.removeItem("jh:saved-table-views");
  useSavedTableViewsStore.getState().reset();
});

describe("saved table views store", () => {
  it("migrates persisted views by dropping unknown columns and reconstructing Default", () => {
    const normalized = normalizeSavedTableViewsState({
      views: [
        {
          id: "legacy",
          tableId: JOBS_TABLE_ID,
          name: "Legacy",
          columns: {
            order: ["company", "ghost", "title"],
            hidden: ["ghost", "source"],
            widths: { company: 222, ghost: 999 },
          },
          sort: { columnId: "ghost", direction: "asc" },
          urlFilters: {
            stage: "apply",
            deleted: "closed",
            discoveredSince: "2026-07-01T00:00:00.000Z",
            scoredSince: "2026-07-01T00:00:00.000Z",
          },
          gridFilters: {
            ghost: {
              operator: "contains",
              text: "bad",
              selectedValues: ["bad"],
            },
            company: {
              operator: "does_not_contain",
              text: "agency",
              selectedValues: [],
            },
          },
          grouping: { columnId: "ghost" },
          colorRules: [
            {
              columnId: "ghost",
              predicate: { op: "eq", value: "x" },
              tone: "danger",
            },
            {
              columnId: "company",
              predicate: { op: "contains", value: "Acme" },
              tone: "info",
            },
          ],
        },
      ],
      activeViewIdByTable: { [JOBS_TABLE_ID]: "legacy" },
      presentationByTable: {
        [JOBS_TABLE_ID]: {
          columns: {
            order: [...JOBS_TABLE_COLUMN_IDS],
            hidden: [],
            widths: {},
          },
          density: "regular",
          grouping: null,
          colorRules: [],
        },
      },
    });

    const defaultView = normalized.views.find(
      (view) => view.id === DEFAULT_SAVED_TABLE_VIEW_ID,
    );
    const legacy = normalized.views.find((view) => view.id === "legacy");

    expect(defaultView).toMatchObject({
      builtIn: true,
      name: "Default",
      tableId: JOBS_TABLE_ID,
    });
    expect(defaultView?.columns.hidden).toEqual([
      "source",
      "compensation_warnings",
    ]);
    expect(legacy).toBeDefined();
    expect(legacy?.columns.order).toContain("company");
    expect(legacy?.columns.order).toContain("title");
    expect(legacy?.columns.order).not.toContain("ghost");
    expect(legacy?.columns.hidden).toEqual(["source"]);
    expect(legacy?.columns.widths).toEqual({ company: 222 });
    expect(legacy?.sort).toEqual({
      columnId: "discovered_at",
      direction: "desc",
    });
    expect(legacy?.urlFilters).toMatchObject({
      stage: "apply",
      deleted: "closed",
      discoveredSince: "2026-07-01T00:00:00.000Z",
      scoredSince: "2026-07-01T00:00:00.000Z",
    });
    expect(legacy?.gridFilters).toEqual({
      company: {
        operator: "does_not_contain",
        text: "agency",
        selectedValues: [],
      },
    });
    expect(legacy?.grouping).toBeNull();
    expect(legacy?.colorRules).toEqual([
      {
        columnId: "company",
        predicate: { op: "contains", value: "Acme" },
        tone: "info",
      },
    ]);
    expect(normalized.activeViewIdByTable[JOBS_TABLE_ID]).toBe("legacy");
    expect(
      normalized.presentationByTable[JOBS_TABLE_ID]?.columns.hidden,
    ).toEqual([]);
  });

  it("reconstructs the built-in Default with its current hidden columns", () => {
    const normalized = normalizeSavedTableViewsState({
      activeViewIdByTable: { [JOBS_TABLE_ID]: DEFAULT_SAVED_TABLE_VIEW_ID },
      presentationByTable: {
        [JOBS_TABLE_ID]: {
          columns: {
            order: [...JOBS_TABLE_COLUMN_IDS],
            hidden: [],
            widths: {},
          },
          density: null,
          grouping: null,
          colorRules: [],
        },
      },
    });

    expect(
      normalized.presentationByTable[JOBS_TABLE_ID]?.columns.hidden,
    ).toEqual(["source", "compensation_warnings"]);
  });

  it("keeps templates unchanged until an explicit save/update action", () => {
    const store = useSavedTableViewsStore.getState();
    const createdId = store.createView(JOBS_TABLE_ID, "Apply review", snapshot);

    expect(
      useSavedTableViewsStore.getState().activeViewIdByTable[JOBS_TABLE_ID],
    ).toBe(createdId);

    useSavedTableViewsStore.getState().setTablePresentation(JOBS_TABLE_ID, {
      ...snapshot,
      columns: { ...snapshot.columns, hidden: ["company", "source"] },
    });
    expect(
      useSavedTableViewsStore
        .getState()
        .views.find((view) => view.id === createdId)?.columns.hidden,
    ).toEqual(["company"]);
    expect(
      useSavedTableViewsStore
        .getState()
        .views.find((view) => view.id === createdId)?.urlFilters,
    ).toMatchObject({
      discoveredSince: "2026-07-01T00:00:00.000Z",
      scoredSince: "2026-07-01T00:00:00.000Z",
    });

    expect(
      useSavedTableViewsStore.getState().updateActiveView(JOBS_TABLE_ID, {
        ...snapshot,
        columns: { ...snapshot.columns, hidden: ["company", "source"] },
      }),
    ).toBe(true);
    expect(
      useSavedTableViewsStore
        .getState()
        .views.find((view) => view.id === createdId)?.columns.hidden,
    ).toEqual(["company", "source"]);

    expect(
      useSavedTableViewsStore
        .getState()
        .renameView(JOBS_TABLE_ID, createdId, "Saved apply"),
    ).toBe(true);
    expect(
      useSavedTableViewsStore.getState().deleteView(JOBS_TABLE_ID, createdId),
    ).toBe(true);
    expect(
      useSavedTableViewsStore.getState().activeViewIdByTable[JOBS_TABLE_ID],
    ).toBe(DEFAULT_SAVED_TABLE_VIEW_ID);
  });
});
