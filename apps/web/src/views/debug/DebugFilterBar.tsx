import { useEffect, useState } from "react";

import type { DebugSearch } from "../../routes/-debug.search.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { SelectField } from "../../shared/ui/select-field.js";
import { ToolRow } from "../../shared/ui/tool-row.js";

export interface DebugFilterBarProps {
  search: DebugSearch;
  onChange: (next: Partial<DebugSearch>) => void;
}

export function DebugFilterBar({ search, onChange }: DebugFilterBarProps) {
  const [query, setQuery] = useState(search.q);

  useEffect(() => {
    setQuery(search.q);
  }, [search.q]);

  return (
    <form
      className="debug-filter-form"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ q: query.trim(), page: 1 });
      }}
    >
      <ToolRow
        className="data-surface__tools"
        primary={
          <>
            <Input
              className="tool-row__search"
              aria-label="Activity search"
              placeholder="Filter events, jobs, companies..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <SelectField
              className="tool-row__field"
              label="Level"
              value={search.level || "all"}
              onValueChange={(value) =>
                onChange({
                  level: (value === "all" ? "" : value) as DebugSearch["level"],
                  page: 1,
                })
              }
              options={[
                { value: "all", label: "All levels" },
                { value: "info", label: "Info" },
                { value: "warn", label: "Warning" },
                { value: "error", label: "Error" },
              ]}
            />
            <Input
              className="tool-row__compact-input"
              aria-label="Activity stage"
              placeholder="Stage"
              value={search.stage}
              onChange={(event) => onChange({ stage: event.target.value.trim(), page: 1 })}
            />
            <Input
              className="tool-row__compact-input"
              aria-label="Activity event type"
              placeholder="Event type"
              value={search.eventType}
              onChange={(event) => onChange({ eventType: event.target.value.trim(), page: 1 })}
            />
          </>
        }
        secondary={
          <>
            <Button type="submit" size="sm">Search</Button>
            {search.q || search.level || search.stage || search.eventType ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQuery("");
                  onChange({ q: "", level: "", stage: "", eventType: "", page: 1 });
                }}
              >
                Clear
              </Button>
            ) : null}
          </>
        }
      />
    </form>
  );
}
