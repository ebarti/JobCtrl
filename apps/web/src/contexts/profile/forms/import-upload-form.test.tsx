import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportUploadForm } from "./import-upload-form.js";

beforeEach(() => {
  useProfileImportStore.getState().reset();
});

describe("<ImportUploadForm>", () => {
  it("keeps continuation disabled until upload state is complete", async () => {
    renderWithProviders(<ImportUploadForm />, { withRouter: true });

    expect(
      await screen.findByRole("button", { name: "Continue to options" }),
    ).toBeDisabled();
  });
});
