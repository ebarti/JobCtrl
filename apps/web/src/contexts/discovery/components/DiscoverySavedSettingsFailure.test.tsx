import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { discoveryKeys } from "../queryKeys.js";
import { DiscoveryAutomationSettingsPanel } from "./DiscoveryAutomationSettingsPanel.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

const message = "Saved Discovery settings are invalid. Preserve the workspace and restore a verified backup, then retry Discovery.";
const failure = () => HttpResponse.json(
  { ok: false, error: "invalid_saved_search", message },
  { status: 409 },
);

describe.each([
  { label: "runtime", Panel: DiscoveryRuntimeSettingsPanel, field: "Results per board", edited: "17" },
  { label: "automation", Panel: DiscoveryAutomationSettingsPanel, field: "Minimum fit score", edited: "8" },
])("$label settings recovery", ({ label, Panel, field, edited }) => {
  it("shows the recovery message without claiming it is still loading", async () => {
    let patches = 0;
    server.use(
      http.get("*/v1/discovery/settings", failure),
      http.patch("*/v1/discovery/settings", () => { patches += 1; return failure(); }),
    );
    renderWithProviders(<Panel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(`Loading ${label} settings.`)).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: field })).not.toBeInTheDocument();
    expect(patches).toBe(0);
  });

  it("keeps cached settings and the dirty draft when a later read fails", async () => {
    let failed = false;
    let patches = 0;
    server.use(
      http.get("*/v1/discovery/settings", () => failed ? failure() : HttpResponse.json(sampleDiscoverySettingsResponse)),
      http.patch("*/v1/discovery/settings", () => { patches += 1; return failure(); }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<Panel />);
    const input = await screen.findByRole("spinbutton", { name: field });
    await user.clear(input);
    await user.type(input, edited);
    expect(input).toHaveValue(Number(edited));

    failed = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: discoveryKeys.settings(LOCAL_TENANT), exact: true });
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(screen.getByRole("spinbutton", { name: field })).toHaveValue(Number(edited));
    expect(queryClient.getQueryData(discoveryKeys.settings(LOCAL_TENANT))).toEqual(sampleDiscoverySettingsResponse);
    expect(patches).toBe(0);
  });
});
