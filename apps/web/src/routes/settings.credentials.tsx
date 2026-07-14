import { createFileRoute } from "@tanstack/react-router";

import { CredentialsPanel } from "../contexts/profile/components/CredentialsPanel.js";

export const Route = createFileRoute("/settings/credentials")({
  component: CredentialsSettingsRoute,
});

function CredentialsSettingsRoute() {
  return (
    <div className="settings-credentials-sections">
      <header className="settings-subroute-head">
        <h2>Credentials</h2>
        <p>Verify provider readiness without exposing the underlying secret.</p>
      </header>
      <CredentialsPanel />
    </div>
  );
}
