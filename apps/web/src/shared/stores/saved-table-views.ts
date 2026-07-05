import {
  JOB_APPLY_STATUS_FILTERS,
  JOB_SORT_FIELDS,
  STAGES,
  STAGE_STATES,
  type JobSortField,
  type SavedTableView,
  type SavedTableViewDensity,
  type SavedTableViewGridFilters,
  type SavedTableViewUrlFilters,
  type TableId,
} from "@jobhunter/contracts";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const SAVED_TABLE_VIEW_STORE_VERSION = 1;
export const SAVED_TABLE_VIEW_SCHEMA_VERSION = 1;
export const DEFAULT_SAVED_TABLE_VIEW_ID = "default";
export const JOBS_TABLE_ID = "jobs" satisfies TableId;
export const JOBS_TABLE_COLUMN_IDS = [
  "select",
  "fit_score",
  "title",
  "company",
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "location",
  "current_stage",
  "current_state",
  "resume_template",
  "discovered_at",
  "apply_status",
] as const;

const STAGE_OR_ALL = [...STAGES, "all"] as const;
const STATE_OR_ALL = [...STAGE_STATES, "all"] as const;
const JOB_DELETED_VIEW_FILTERS = ["active", "closed", "deleted", "hidden"] as const;
const DENSITIES = ["compact", "regular", "comfy"] as const;
const COLOR_RULE_OPERATORS = ["eq", "neq", "gte", "lte", "contains"] as const;
const COLOR_RULE_TONES = ["success", "warning", "danger", "info"] as const;

type KnownTableConfig = {
  tableId: TableId;
  columnIds: readonly string[];
  defaultSort: SavedTableView["sort"];
  defaultUrlFilters: SavedTableViewUrlFilters;
};

const TABLE_CONFIGS: Record<string, KnownTableConfig> = {
  [JOBS_TABLE_ID]: {
    tableId: JOBS_TABLE_ID,
    columnIds: JOBS_TABLE_COLUMN_IDS,
    defaultSort: { columnId: "discovered_at", direction: "desc" },
    defaultUrlFilters: {
      q: "",
      stage: "all",
      state: "all",
      applyStatus: "all",
      deleted: "active",
      pageSize: 50,
    },
  },
};

export interface SavedTablePresentation {
  columns: SavedTableView["columns"];
  density: SavedTableViewDensity | null;
  grouping: SavedTableView["grouping"];
  colorRules: SavedTableView["colorRules"];
}

export interface SavedTableViewSnapshot extends SavedTablePresentation {
  sort: SavedTableView["sort"];
  urlFilters: SavedTableViewUrlFilters;
  gridFilters: SavedTableViewGridFilters;
}

interface SavedTableViewsState {
  views: SavedTableView[];
  activeViewIdByTable: Partial<Record<TableId, string>>;
  presentationByTable: Partial<Record<TableId, SavedTablePresentation>>;
  applyView: (tableId: TableId, viewId: string) => void;
  setTablePresentation: (
    tableId: TableId,
    presentation: SavedTablePresentation,
  ) => void;
  createView: (
    tableId: TableId,
    name: string,
    snapshot: SavedTableViewSnapshot,
  ) => string;
  updateActiveView: (tableId: TableId, snapshot: SavedTableViewSnapshot) => boolean;
  renameView: (tableId: TableId, viewId: string, name: string) => boolean;
  deleteView: (tableId: TableId, viewId: string) => boolean;
  reset: () => void;
}

function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const fallbackStorage = createMemoryStorage();

function getStorage(): StateStorage {
  if (typeof window === "undefined") {
    return fallbackStorage;
  }
  const storage = window.localStorage as Partial<StateStorage> | undefined;
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  ) {
    return storage as StateStorage;
  }
  return fallbackStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueKnownStrings(
  value: unknown,
  knownIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !knownIds.has(item) || seen.has(item)) {
      continue;
    }
    seen.add(item);
    next.push(item);
  }
  return next;
}

function normalizeColumns(
  value: unknown,
  config: KnownTableConfig,
): SavedTableView["columns"] {
  const source = isRecord(value) ? value : {};
  const knownIds = new Set(config.columnIds);
  const order = uniqueKnownStrings(source["order"], knownIds);
  for (const columnId of config.columnIds) {
    if (!order.includes(columnId)) {
      order.push(columnId);
    }
  }
  const hidden = uniqueKnownStrings(source["hidden"], knownIds);
  if (hidden.length >= config.columnIds.length) {
    hidden.shift();
  }
  const widths: Record<string, number> = {};
  const rawWidths = isRecord(source["widths"]) ? source["widths"] : {};
  for (const [columnId, width] of Object.entries(rawWidths)) {
    if (!knownIds.has(columnId)) continue;
    const numeric = Number(width);
    if (Number.isFinite(numeric) && numeric >= 24 && numeric <= 2000) {
      widths[columnId] = Math.round(numeric);
    }
  }
  return { order, hidden, widths };
}

function normalizeDensity(value: unknown): SavedTableViewDensity | null {
  return isOneOf(value, DENSITIES) ? value : null;
}

function normalizeSort(
  value: unknown,
  config: KnownTableConfig,
): SavedTableView["sort"] {
  const source = isRecord(value) ? value : {};
  const columnId = source["columnId"];
  const direction = source["direction"];
  if (
    typeof columnId === "string" &&
    config.columnIds.includes(columnId) &&
    isOneOf(columnId, JOB_SORT_FIELDS) &&
    (direction === "asc" || direction === "desc")
  ) {
    return { columnId: columnId as JobSortField, direction };
  }
  return config.defaultSort;
}

function normalizeUrlFilters(value: unknown): SavedTableViewUrlFilters {
  const source = isRecord(value) ? value : {};
  const next: SavedTableViewUrlFilters = {};
  if (typeof source["q"] === "string") next.q = source["q"];
  if (isOneOf(source["stage"], STAGE_OR_ALL)) next.stage = source["stage"];
  if (isOneOf(source["state"], STATE_OR_ALL)) next.state = source["state"];
  if (isOneOf(source["applyStatus"], JOB_APPLY_STATUS_FILTERS)) {
    next.applyStatus = source["applyStatus"];
  }
  if (isOneOf(source["deleted"], JOB_DELETED_VIEW_FILTERS)) {
    next.deleted = source["deleted"];
  }
  for (const key of ["pageSize", "minFitScore", "maxFitScore"] as const) {
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric)) {
      next[key] = Math.round(numeric);
    }
  }
  return next;
}

function normalizeGridFilters(
  value: unknown,
  config: KnownTableConfig,
): SavedTableViewGridFilters {
  const source = isRecord(value) ? value : {};
  const knownIds = new Set(config.columnIds);
  const next: SavedTableViewGridFilters = {};
  for (const [columnId, rawFilter] of Object.entries(source)) {
    if (!knownIds.has(columnId) || !isRecord(rawFilter)) continue;
    const selectedValues = Array.isArray(rawFilter["selectedValues"])
      ? rawFilter["selectedValues"].filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    next[columnId] = {
      operator:
        rawFilter["operator"] === "does_not_contain"
          ? "does_not_contain"
          : "contains",
      text: typeof rawFilter["text"] === "string" ? rawFilter["text"] : "",
      selectedValues,
    };
  }
  return next;
}

function normalizeGrouping(
  value: unknown,
  config: KnownTableConfig,
): SavedTableView["grouping"] {
  if (!isRecord(value)) return null;
  const columnId = value["columnId"];
  return typeof columnId === "string" && config.columnIds.includes(columnId)
    ? { columnId }
    : null;
}

function normalizeColorRules(
  value: unknown,
  config: KnownTableConfig,
): SavedTableView["colorRules"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    if (!isRecord(rule) || !isRecord(rule["predicate"])) return [];
    const columnId = rule["columnId"];
    const op = rule["predicate"]["op"];
    const predicateValue = rule["predicate"]["value"];
    const tone = rule["tone"];
    if (
      typeof columnId !== "string" ||
      !config.columnIds.includes(columnId) ||
      !isOneOf(op, COLOR_RULE_OPERATORS) ||
      !isOneOf(tone, COLOR_RULE_TONES) ||
      (typeof predicateValue !== "string" && typeof predicateValue !== "number")
    ) {
      return [];
    }
    return [{ columnId, predicate: { op, value: predicateValue }, tone }];
  });
}

function defaultView(config: KnownTableConfig): SavedTableView {
  return {
    id: DEFAULT_SAVED_TABLE_VIEW_ID,
    tableId: config.tableId,
    name: "Default",
    builtIn: true,
    columns: normalizeColumns({}, config),
    density: null,
    sort: config.defaultSort,
    urlFilters: config.defaultUrlFilters,
    gridFilters: {},
    grouping: null,
    colorRules: [],
    schemaVersion: SAVED_TABLE_VIEW_SCHEMA_VERSION,
  };
}

function presentationFromView(view: SavedTableView): SavedTablePresentation {
  return {
    columns: view.columns,
    density: view.density,
    grouping: view.grouping,
    colorRules: view.colorRules,
  };
}

function normalizePresentation(
  value: unknown,
  config: KnownTableConfig,
): SavedTablePresentation | null {
  if (!isRecord(value)) return null;
  return {
    columns: normalizeColumns(value["columns"], config),
    density: normalizeDensity(value["density"]),
    grouping: normalizeGrouping(value["grouping"], config),
    colorRules: normalizeColorRules(value["colorRules"], config),
  };
}

function normalizeSnapshot(
  value: SavedTableViewSnapshot,
  config: KnownTableConfig,
): SavedTableViewSnapshot {
  return {
    columns: normalizeColumns(value.columns, config),
    density: normalizeDensity(value.density),
    sort: normalizeSort(value.sort, config),
    urlFilters: normalizeUrlFilters(value.urlFilters),
    gridFilters: normalizeGridFilters(value.gridFilters, config),
    grouping: normalizeGrouping(value.grouping, config),
    colorRules: normalizeColorRules(value.colorRules, config),
  };
}

function viewFromSnapshot(
  tableId: TableId,
  id: string,
  name: string,
  snapshot: SavedTableViewSnapshot,
  config: KnownTableConfig,
): SavedTableView {
  const normalized = normalizeSnapshot(snapshot, config);
  return {
    id,
    tableId,
    name: name.trim() || "Untitled view",
    builtIn: false,
    ...normalized,
    schemaVersion: SAVED_TABLE_VIEW_SCHEMA_VERSION,
  };
}

function normalizeView(
  value: unknown,
  config: KnownTableConfig,
): SavedTableView | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"].trim() : "";
  const name = typeof value["name"] === "string" ? value["name"].trim() : "";
  if (!id || id === DEFAULT_SAVED_TABLE_VIEW_ID) return null;
  return {
    id,
    tableId: config.tableId,
    name: name || "Untitled view",
    builtIn: false,
    columns: normalizeColumns(value["columns"], config),
    density: normalizeDensity(value["density"]),
    sort: normalizeSort(value["sort"], config),
    urlFilters: normalizeUrlFilters(value["urlFilters"]),
    gridFilters: normalizeGridFilters(value["gridFilters"], config),
    grouping: normalizeGrouping(value["grouping"], config),
    colorRules: normalizeColorRules(value["colorRules"], config),
    schemaVersion: SAVED_TABLE_VIEW_SCHEMA_VERSION,
  };
}

export function normalizeSavedTableViewsState(value: unknown): Pick<
  SavedTableViewsState,
  "views" | "activeViewIdByTable" | "presentationByTable"
> {
  const source = isRecord(value) ? value : {};
  const sourceViews = Array.isArray(source["views"]) ? source["views"] : [];
  const activeSource = isRecord(source["activeViewIdByTable"])
    ? source["activeViewIdByTable"]
    : {};
  const presentationSource = isRecord(source["presentationByTable"])
    ? source["presentationByTable"]
    : {};
  const views: SavedTableView[] = [];
  const activeViewIdByTable: Partial<Record<TableId, string>> = {};
  const presentationByTable: Partial<Record<TableId, SavedTablePresentation>> = {};

  for (const config of Object.values(TABLE_CONFIGS)) {
    const tableDefault = defaultView(config);
    const tableViews = [tableDefault];
    const seen = new Set([tableDefault.id]);
    for (const rawView of sourceViews) {
      if (!isRecord(rawView) || rawView["tableId"] !== config.tableId) continue;
      const normalized = normalizeView(rawView, config);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      tableViews.push(normalized);
    }
    const activeCandidate = activeSource[config.tableId];
    const activeView = tableViews.find((view) => view.id === activeCandidate) ?? tableDefault;
    const persistedPresentation = normalizePresentation(
      presentationSource[config.tableId],
      config,
    );
    views.push(...tableViews);
    activeViewIdByTable[config.tableId] = activeView.id;
    presentationByTable[config.tableId] =
      persistedPresentation ?? presentationFromView(activeView);
  }

  return { views, activeViewIdByTable, presentationByTable };
}

const initialState = normalizeSavedTableViewsState({});

function configFor(tableId: TableId): KnownTableConfig {
  const config = TABLE_CONFIGS[tableId];
  if (!config) {
    throw new Error(`Unknown table id: ${tableId}`);
  }
  return config;
}

export const useSavedTableViewsStore = create<SavedTableViewsState>()(
  persist(
    (set, get) => ({
      ...initialState,
      applyView: (tableId, viewId) =>
        set((state) => {
          const config = configFor(tableId);
          const view =
            state.views.find(
              (candidate) =>
                candidate.tableId === tableId && candidate.id === viewId,
            ) ?? defaultView(config);
          return {
            activeViewIdByTable: {
              ...state.activeViewIdByTable,
              [tableId]: view.id,
            },
            presentationByTable: {
              ...state.presentationByTable,
              [tableId]: presentationFromView(view),
            },
          };
        }),
      setTablePresentation: (tableId, presentation) =>
        set((state) => {
          const config = configFor(tableId);
          return {
            presentationByTable: {
              ...state.presentationByTable,
              [tableId]: normalizePresentation(presentation, config) ?? presentation,
            },
          };
        }),
      createView: (tableId, name, snapshot) => {
        const config = configFor(tableId);
        const id = createId();
        const view = viewFromSnapshot(tableId, id, name, snapshot, config);
        set((state) => ({
          views: [...state.views, view],
          activeViewIdByTable: {
            ...state.activeViewIdByTable,
            [tableId]: id,
          },
          presentationByTable: {
            ...state.presentationByTable,
            [tableId]: presentationFromView(view),
          },
        }));
        return id;
      },
      updateActiveView: (tableId, snapshot) => {
        const state = get();
        const activeId =
          state.activeViewIdByTable[tableId] ?? DEFAULT_SAVED_TABLE_VIEW_ID;
        const current = state.views.find(
          (view) => view.tableId === tableId && view.id === activeId,
        );
        if (!current || current.builtIn) return false;
        const config = configFor(tableId);
        const nextView = viewFromSnapshot(
          tableId,
          current.id,
          current.name,
          snapshot,
          config,
        );
        set((currentState) => ({
          views: currentState.views.map((view) =>
            view.tableId === tableId && view.id === activeId ? nextView : view,
          ),
          presentationByTable: {
            ...currentState.presentationByTable,
            [tableId]: presentationFromView(nextView),
          },
        }));
        return true;
      },
      renameView: (tableId, viewId, name) => {
        const normalizedName = name.trim();
        if (!normalizedName) return false;
        const state = get();
        const current = state.views.find(
          (view) => view.tableId === tableId && view.id === viewId,
        );
        if (!current || current.builtIn) return false;
        set((currentState) => ({
          views: currentState.views.map((view) =>
            view.tableId === tableId && view.id === viewId
              ? { ...view, name: normalizedName }
              : view,
          ),
        }));
        return true;
      },
      deleteView: (tableId, viewId) => {
        const state = get();
        const current = state.views.find(
          (view) => view.tableId === tableId && view.id === viewId,
        );
        if (!current || current.builtIn) return false;
        const tableDefault = defaultView(configFor(tableId));
        set((currentState) => ({
          views: currentState.views.filter(
            (view) => !(view.tableId === tableId && view.id === viewId),
          ),
          activeViewIdByTable: {
            ...currentState.activeViewIdByTable,
            [tableId]:
              currentState.activeViewIdByTable[tableId] === viewId
                ? DEFAULT_SAVED_TABLE_VIEW_ID
                : currentState.activeViewIdByTable[tableId],
          },
          presentationByTable: {
            ...currentState.presentationByTable,
            ...(currentState.activeViewIdByTable[tableId] === viewId
              ? { [tableId]: presentationFromView(tableDefault) }
              : {}),
          },
        }));
        return true;
      },
      reset: () => set(normalizeSavedTableViewsState({})),
    }),
    {
      name: "jh:saved-table-views",
      storage: createJSONStorage(getStorage),
      version: SAVED_TABLE_VIEW_STORE_VERSION,
      partialize: ({ views, activeViewIdByTable, presentationByTable }) => ({
        views,
        activeViewIdByTable,
        presentationByTable,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...normalizeSavedTableViewsState(persisted),
      }),
    },
  ),
);
