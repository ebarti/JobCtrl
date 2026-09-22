import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import type { SavedTableView } from "../contexts/operations/types.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";
import type { DiscoverySourceTableControls } from "../contexts/discovery/components/DiscoveryProductControls.js";
import {
  DISCOVERY_SOURCE_COLUMN_IDS,
  DISCOVERY_SOURCES_TABLE_ID,
  type SavedTablePresentation,
  useSavedTableViewsStore,
} from "../shared/stores/saved-table-views.js";
import { DiscoveryView } from "../views/discovery/DiscoveryView.js";
import {
  DEFAULT_DISCOVERY_SOURCE_FILTERS,
  discoverySearchSchema,
  discoverySourceSortSchema,
  type DiscoverySearch,
} from "./-discovery.search.js";

const DEFAULT_DISCOVERY_SOURCE_PRESENTATION: SavedTablePresentation = {
  columns: {
    order: [...DISCOVERY_SOURCE_COLUMN_IDS],
    hidden: [],
    widths: {},
  },
  density: null,
  grouping: null,
  colorRules: [],
};

function savedViewSearch(view: SavedTableView): DiscoverySearch {
  return {
    sourceFilters:
      view.urlFilters.sourceFilters ?? DEFAULT_DISCOVERY_SOURCE_FILTERS,
    sourceSort: discoverySourceSortSchema.safeParse(view.sort.columnId).success
      ? (view.sort.columnId as DiscoverySearch["sourceSort"])
      : "displayName",
    sourceDir: view.sort.direction,
  };
}

function DiscoveryRouteView() {
  const search = useSearch({ from: "/discovery" });
  const navigate = useNavigate({ from: "/discovery" });
  const presentation =
    useSavedTableViewsStore(
      (state) => state.presentationByTable[DISCOVERY_SOURCES_TABLE_ID],
    ) ?? DEFAULT_DISCOVERY_SOURCE_PRESENTATION;
  const setTablePresentation = useSavedTableViewsStore(
    (state) => state.setTablePresentation,
  );

  const setSearch = useCallback(
    (next: Partial<DiscoverySearch>) => {
      void navigate({
        search: (previous: DiscoverySearch) => ({ ...previous, ...next }),
      });
    },
    [navigate],
  );
  const handlePresentationChange = useCallback(
    (next: SavedTablePresentation) => {
      setTablePresentation(DISCOVERY_SOURCES_TABLE_ID, next);
    },
    [setTablePresentation],
  );
  const handleApplyView = useCallback(
    (view: SavedTableView) => {
      setSearch(savedViewSearch(view));
    },
    [setSearch],
  );
  const sourceSort = useMemo(
    () => ({ columnId: search.sourceSort, direction: search.sourceDir }),
    [search.sourceDir, search.sourceSort],
  );
  const handleFiltersChange = useCallback(
    (sourceFilters: DiscoverySourceTableControls["filters"]) => {
      setSearch({ sourceFilters });
    },
    [setSearch],
  );
  const handleSortChange = useCallback(
    (sort: DiscoverySourceTableControls["sort"]) => {
      setSearch({
        sourceSort: discoverySourceSortSchema.parse(sort.columnId),
        sourceDir: sort.direction,
      });
    },
    [setSearch],
  );
  const sourceTable = useMemo<DiscoverySourceTableControls>(
    () => ({
      filters: search.sourceFilters,
      sort: sourceSort,
      presentation,
      onFiltersChange: handleFiltersChange,
      onSortChange: handleSortChange,
      onPresentationChange: handlePresentationChange,
      onApplyView: handleApplyView,
    }),
    [
      handleApplyView,
      handleFiltersChange,
      handlePresentationChange,
      handleSortChange,
      presentation,
      search.sourceFilters,
      sourceSort,
    ],
  );

  return <DiscoveryView sourceTable={sourceTable} />;
}

export const Route = createFileRoute("/discovery")({
  validateSearch: (search) => discoverySearchSchema.parse(search),
  loader: ({ context }) =>
    context.queryClient.prefetchQuery({
      queryKey: profileKeys.profile(context.tenantId),
      queryFn: () => context.ports.api.profile(),
    }),
  component: DiscoveryRouteView,
});
