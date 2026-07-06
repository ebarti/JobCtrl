import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { OutreachDetailDrawer } from "../views/outreach/OutreachDetailDrawer.js";

export const Route = createFileRoute("/outreach/$contactId")({
  component: ContactDrawerRoute,
});

function ContactDrawerRoute() {
  const { contactId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/outreach", search });
  }, [navigate, search]);

  return <OutreachDetailDrawer contactId={contactId} onClose={close} />;
}
