import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";

import { ContactCreateButton } from "../../contexts/outreach/components/ContactCreateButton.js";
import { ContactImportButton } from "../../contexts/outreach/components/ContactImportButton.js";
import { DueFollowUpsBadge } from "../../contexts/outreach/components/DueFollowUpsBadge.js";
import { DueFollowUpsPanel } from "../../contexts/outreach/components/DueFollowUpsPanel.js";
import {
  useContactsListQuery,
  type ContactsListFilters,
} from "../../contexts/outreach/hooks/useContactsListQuery.js";
import type { OutreachSearch } from "../../routes/-outreach.search.js";
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
        actions={<DueFollowUpsBadge />}
      />
      <DueFollowUpsPanel />
      <section className="card full data-list-card">
        {message ? <div className="banner inline">{message}</div> : null}
        <div className="toolbar">
          <label className="field compact">
            <span>Employer</span>
            <input
              value={search.employer}
              onChange={(event) => setSearch({ employer: event.target.value })}
            />
          </label>
          <label className="field compact">
            <span>Job</span>
            <input
              value={search.jobId}
              onChange={(event) => setSearch({ jobId: event.target.value })}
            />
          </label>
          <ContactCreateButton />
          <ContactImportButton />
        </div>
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
      <Outlet />
    </>
  );
}
