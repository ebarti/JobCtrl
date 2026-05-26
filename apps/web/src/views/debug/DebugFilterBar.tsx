import { useEffect, useState } from "react";

import type { DebugSearch } from "../../routes/-debug.search.js";

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
      <input
        aria-label="Activity search"
        placeholder="Filter events, jobs, companies..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        aria-label="Activity level"
        value={search.level}
        onChange={(event) => onChange({ level: event.target.value, page: 1 })}
      >
        <option value="">all levels</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <input
        aria-label="Activity stage"
        placeholder="stage"
        value={search.stage}
        onChange={(event) => onChange({ stage: event.target.value.trim(), page: 1 })}
      />
      <input
        aria-label="Activity event type"
        placeholder="event type"
        value={search.eventType}
        onChange={(event) => onChange({ eventType: event.target.value.trim(), page: 1 })}
      />
      <button type="submit">search</button>
      {search.q || search.level || search.stage || search.eventType ? (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            onChange({ q: "", level: "", stage: "", eventType: "", page: 1 });
          }}
        >
          clear
        </button>
      ) : null}
    </form>
  );
}
