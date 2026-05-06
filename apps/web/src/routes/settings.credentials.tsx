import { createFileRoute } from "@tanstack/react-router";

import { CredentialsPanel } from "../contexts/profile/components/CredentialsPanel.js";

export const Route = createFileRoute("/settings/credentials")({
  component: CredentialsPanel,
});
