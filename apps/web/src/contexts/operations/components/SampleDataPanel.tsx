import { IconDatabaseImport, IconTrash } from "@tabler/icons-react";
import { useState } from "react";

import {
  useClearSampleDataMutation,
  useLoadSampleDataMutation,
} from "../hooks/useSampleDataMutations.js";
import { useSampleDataStatusQuery } from "../hooks/useSampleDataQuery.js";

interface SampleDataPanelProps {
  readonly compact?: boolean;
}

export function SampleDataPanel({ compact = false }: SampleDataPanelProps) {
  const status = useSampleDataStatusQuery();
  const loadSampleData = useLoadSampleDataMutation();
  const clearSampleData = useClearSampleDataMutation();
  const [confirmClear, setConfirmClear] = useState(false);
  const data = status.data;
  const message =
    loadSampleData.data?.message ||
    clearSampleData.data?.message ||
    (loadSampleData.error instanceof Error ? loadSampleData.error.message : null) ||
    (clearSampleData.error instanceof Error ? clearSampleData.error.message : null);

  if (!data || data.state === "blocked") {
    return null;
  }

  const busy = loadSampleData.isPending || clearSampleData.isPending;
  const title =
    data.state === "loaded"
      ? `${data.sampleJobCount} sample job${data.sampleJobCount === 1 ? "" : "s"} loaded`
      : "Load first-run sample data";
  const detail =
    data.state === "loaded"
      ? "Synthetic records are marked as sample data and cannot be submitted."
      : data.message;

  return (
    <section className={`sample-data-panel${compact ? " compact" : ""}`} aria-label="Sample data">
      <div>
        <span className="eyebrow">Sample data</span>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      <div className="sample-data-actions">
        {data.canLoad ? (
          <button
            className="tab"
            disabled={busy}
            type="button"
            onClick={() => loadSampleData.mutate()}
          >
            <IconDatabaseImport aria-hidden="true" size={16} />
            <span>{loadSampleData.isPending ? "loading sample data" : "load sample data"}</span>
          </button>
        ) : null}
        {data.canClear ? (
          <button
            className="tab danger-action"
            disabled={busy}
            type="button"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              clearSampleData.mutate(undefined, {
                onSettled: () => setConfirmClear(false),
              });
            }}
          >
            <IconTrash aria-hidden="true" size={16} />
            <span>
              {clearSampleData.isPending
                ? "clearing sample data"
                : confirmClear
                  ? "confirm clear sample data"
                  : "clear sample data"}
            </span>
          </button>
        ) : null}
        {confirmClear ? (
          <button className="tab" disabled={busy} type="button" onClick={() => setConfirmClear(false)}>
            cancel
          </button>
        ) : null}
      </div>
      {message ? <div className="status-line">{message}</div> : null}
    </section>
  );
}
