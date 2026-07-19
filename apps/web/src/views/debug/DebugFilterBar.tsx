import { useEffect, useState } from "react";

import type { DebugSearch } from "../../routes/-debug.search.js";
import { useIsMobile } from "../../shared/hooks/use-mobile.js";
import { Button } from "../../shared/ui/button.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";

const ACTIVITY_LEVEL_ITEMS = [
  { value: null, label: "All levels" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warning" },
  { value: "error", label: "Error" },
] as const;

export interface DebugFilterBarProps {
  search: DebugSearch;
  onChange: (next: Partial<DebugSearch>) => void;
}

export function DebugFilterBar({ search, onChange }: DebugFilterBarProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState(search.q);
  const hasFilters = Boolean(
    search.q || search.level || search.stage || search.eventType,
  );

  useEffect(() => {
    setQuery(search.q);
  }, [search.q]);

  return (
    <details
      className="debug-filter-disclosure"
      open={!isMobile || hasFilters ? true : undefined}
    >
      <summary data-typography="control">
        Filter activity{hasFilters ? " (active)" : ""}
      </summary>
      <form
        className="debug-filter-bar"
        aria-label="Activity filters"
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ q: query.trim(), page: 1 });
        }}
      >
        <Field className="debug-filter-field debug-filter-field--search">
          <FieldLabel htmlFor="activity-search-filter">
            Search activity
          </FieldLabel>
          <Input
            aria-label="Activity search"
            id="activity-search-filter"
            placeholder="Events, jobs, or companies"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Field className="debug-filter-field">
          <FieldLabel htmlFor="activity-level-filter">Level</FieldLabel>
          <Select
            items={ACTIVITY_LEVEL_ITEMS}
            value={search.level || null}
            onValueChange={(level) => onChange({ level: level ?? "", page: 1 })}
          >
            <SelectTrigger
              aria-label="Activity level"
              id="activity-level-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {ACTIVITY_LEVEL_ITEMS.map((item) => (
                  <SelectItem key={item.value ?? "all"} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="debug-filter-field">
          <FieldLabel htmlFor="activity-stage-filter">Stage</FieldLabel>
          <Input
            aria-label="Activity stage"
            id="activity-stage-filter"
            placeholder="e.g. score"
            value={search.stage}
            onChange={(event) =>
              onChange({ stage: event.target.value.trim(), page: 1 })
            }
          />
        </Field>
        <Field className="debug-filter-field debug-filter-field--event">
          <FieldLabel htmlFor="activity-event-type-filter">
            Event type
          </FieldLabel>
          <Input
            aria-label="Activity event type"
            id="activity-event-type-filter"
            placeholder="e.g. JobScored"
            value={search.eventType}
            onChange={(event) =>
              onChange({ eventType: event.target.value.trim(), page: 1 })
            }
          />
        </Field>
        <div className="debug-filter-actions">
          <Button size="sm" type="submit">
            Search
          </Button>
          {hasFilters ? (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setQuery("");
                onChange({
                  q: "",
                  level: "",
                  stage: "",
                  eventType: "",
                  page: 1,
                });
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
