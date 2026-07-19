import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  ARTIFACT_STATUSES,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";

export interface ArtifactFilterBarProps {
  search: ArtifactsSearch;
}

export function ArtifactFilterBar({ search }: ArtifactFilterBarProps) {
  const navigate = useNavigate({ from: "/artifacts" });
  const [query, setQuery] = useState(search.q);
  useEffect(() => setQuery(search.q), [search.q]);
  const statusItems = ARTIFACT_STATUSES.map((status) => ({
    value: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
  }));
  const apply = (next: Partial<ArtifactsSearch>) => {
    void navigate({
      search: (prev: ArtifactsSearch) => ({ ...prev, page: 1, ...next }),
    });
  };
  return (
    <form
      className="artifact-filter-toolbar"
      aria-label="Artifact filters"
      onSubmit={(event) => {
        event.preventDefault();
        apply({ q: query.trim() });
      }}
    >
      <Field className="artifact-search-field">
        <FieldLabel htmlFor="artifact-search-filter">Search</FieldLabel>
        <Input
          id="artifact-search-filter"
          placeholder="Title, company, or type"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <Field className="field">
        <FieldLabel htmlFor="artifact-status-filter">Status</FieldLabel>
        <Select
          items={statusItems}
          value={search.status}
          onValueChange={(status) => {
            if (status !== null) apply({ status });
          }}
        >
          <SelectTrigger
            aria-label="Status"
            className="w-full min-w-40"
            id="artifact-status-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <div className="artifact-filter-actions">
        <Button size="sm" type="submit">
          Search
        </Button>
        {search.q ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setQuery("");
              apply({ q: "" });
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}
