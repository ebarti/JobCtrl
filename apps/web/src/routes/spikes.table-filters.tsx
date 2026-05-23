import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/spikes/table-filters")({
  component: TableFilterSpikeRoute,
});

function TableFilterSpikeRoute() {
  useEffect(() => {
    window.location.replace("/spikes/table-filters/index.html");
  }, []);

  return <main className="main empty">Opening table filter spike...</main>;
}
