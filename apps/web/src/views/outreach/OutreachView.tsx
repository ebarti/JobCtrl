import { useNavigate, useSearch } from "@tanstack/react-router";

import { ContactCreateButton } from "../../contexts/outreach/components/ContactCreateButton.js";
import { ContactImportButton } from "../../contexts/outreach/components/ContactImportButton.js";
import { DueFollowUpsBadge } from "../../contexts/outreach/components/DueFollowUpsBadge.js";
import { DueFollowUpsPanel } from "../../contexts/outreach/components/DueFollowUpsPanel.js";
import {
  useContactsListQuery,
  type ContactsListFilters,
} from "../../contexts/outreach/hooks/useContactsListQuery.js";
import type { OutreachSearch } from "../../routes/-outreach.search.js";
import { Field, FieldGroup, FieldLabel } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { OutreachTable } from "./OutreachTable.js";

function listFilters(search: OutreachSearch): ContactsListFilters {
  const filters: ContactsListFilters = {};
  if (search.jobId) {
    filters.jobId = search.jobId;
  }
  if (search.employer) {
    filters.employer = search.employer;
  }
  return filters;
}

export function OutreachView() {
  const search = useSearch({ from: "/outreach" });
  const navigate = useNavigate({ from: "/outreach" });

  const { data, isFetching, error } = useContactsListQuery(listFilters(search));
  const message = error instanceof Error ? error.message : null;

  const setSearch = (next: Partial<OutreachSearch>) => {
    void navigate({ search: (prev: OutreachSearch) => ({ ...prev, ...next }) });
  };

  return (
    <>
      <PageHead
        eyebrow="Library"
        title="Contacts"
        subtitle={data ? `${data.items.length} shown` : "loading"}
        actions={
          <>
            <DueFollowUpsBadge />
            <ContactImportButton />
            <ContactCreateButton />
          </>
        }
      />
      <DueFollowUpsPanel />
      <section className="card full data-list-card">
        {message ? <div className="banner inline">{message}</div> : null}
        <FieldGroup
          className="contacts-filter-toolbar"
          role="group"
          aria-label="Contact filters"
        >
          <Field className="contacts-filter-field">
            <FieldLabel htmlFor="contacts-employer-filter">Employer</FieldLabel>
            <Input
              id="contacts-employer-filter"
              value={search.employer}
              onChange={(event) => setSearch({ employer: event.target.value })}
            />
          </Field>
          <Field className="contacts-filter-field">
            <FieldLabel htmlFor="contacts-job-filter">Job</FieldLabel>
            <Input
              id="contacts-job-filter"
              value={search.jobId}
              onChange={(event) => setSearch({ jobId: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <OutreachTable
          data={data ?? null}
          loading={isFetching}
          onOpenContact={(contactId) =>
            void navigate({
              to: "/outreach/$contactId",
              params: { contactId },
              search: (prev: OutreachSearch) => prev,
            })
          }
        />
      </section>
    </>
  );
}
