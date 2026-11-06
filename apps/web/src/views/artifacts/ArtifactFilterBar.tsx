import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId } from "react";
import { z } from "zod";

import {
  ARTIFACT_STATUSES,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { artifactStatusLabels } from "./columns.js";

const searchSchema = z.object({ q: z.string().max(4000) });
export interface ArtifactFilterBarProps {
  readonly search: ArtifactsSearch;
}
export function ArtifactFilterBar({ search }: ArtifactFilterBarProps) {
  const id = useId();
  const navigate = useNavigate({ from: "/artifacts" });
  const apply = (next: Partial<ArtifactsSearch>) => {
    void navigate({
      search: (previous: ArtifactsSearch) => ({
        ...previous,
        page: 1,
        ...next,
      }),
    });
  };
  const form = useForm({
    defaultValues: { q: search.q },
    validators: {
      onSubmit: ({ value }) =>
        searchSchema.safeParse(value).success
          ? undefined
          : "Search text is too long.",
    },
    onSubmit: ({ value }) => {
      const parsed = searchSchema.safeParse(value);
      if (parsed.success) apply({ q: parsed.data.q });
    },
  });
  useEffect(() => {
    form.reset({ q: search.q });
  }, [form, search.q]);
  return (
    <form
      className="artifact-filter-toolbar flex flex-wrap items-end gap-3"
      aria-label="Artifact filters"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="q">
        {(field) => (
          <label htmlFor={`${id}-q`}>
            Literal search
            <Input
              id={`${id}-q`}
              value={field.state.value}
              maxLength={4000}
              placeholder="Job title, employer, file or source ID"
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <label htmlFor={`${id}-status`}>
        Recorded state
        <select
          id={`${id}-status`}
          value={search.status}
          onChange={(event) => {
            const status = ARTIFACT_STATUSES.find(
              (value) => value === event.target.value,
            );
            if (status) apply({ status });
          }}
        >
          {ARTIFACT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status === "all"
                ? "All recorded states"
                : artifactStatusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" type="submit">
        Search
      </Button>
      {search.q ? (
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            form.reset({ q: "" });
            apply({ q: "" });
          }}
        >
          Clear search
        </Button>
      ) : null}
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) =>
          errors.length ? <p role="alert">Search text is too long.</p> : null
        }
      </form.Subscribe>
    </form>
  );
}
