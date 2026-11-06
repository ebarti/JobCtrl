import { createFileRoute } from "@tanstack/react-router";

import { ApplicationSettingsPanel } from "../contexts/settings/index.js";
import { CompensationSourcePolicyPanel } from "../contexts/compensation/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  const features = useMountedFeatures();
  return (
    <>
      <ApplicationSettingsPanel />
      {features.has("compensation") ? <CompensationSourcePolicyPanel /> : null}
    </>
  );
}
