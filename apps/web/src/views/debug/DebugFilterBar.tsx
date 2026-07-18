import { useEffect, useState } from "react";

import type { DebugSearch } from "../../routes/-debug.search.js";
import { Button } from "../../shared/ui/button.js";
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
  { value: null, label: "all levels" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
] as const;

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
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ q: query.trim(), page: 1 });
      }}
    >
      <Input
        aria-label="Activity search"
        placeholder="Filter events, jobs, companies..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Select
        items={ACTIVITY_LEVEL_ITEMS}
        value={search.level || null}
        onValueChange={(level) => onChange({ level: level ?? "", page: 1 })}
      >
        <SelectTrigger aria-label="Activity level" className="min-w-32">
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
      <Input
        aria-label="Activity stage"
        placeholder="stage"
        value={search.stage}
        onChange={(event) =>
          onChange({ stage: event.target.value.trim(), page: 1 })
        }
      />
      <Input
        aria-label="Activity event type"
        placeholder="event type"
        value={search.eventType}
        onChange={(event) =>
          onChange({ eventType: event.target.value.trim(), page: 1 })
        }
      />
      <Button type="submit">Search</Button>
      {search.q || search.level || search.stage || search.eventType ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setQuery("");
            onChange({ q: "", level: "", stage: "", eventType: "", page: 1 });
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
