import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleResumeTemplateListResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ResumeTemplatePanel } from "./ResumeTemplatePanel.js";

describe("<ResumeTemplatePanel>", () => {
  it("keeps compact controls above the real full-width Plate preview", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ResumeTemplatePanel profileHtmlPreviewUrl={null} />,
    );

    expect(await screen.findByRole("heading", { name: "Resume templates" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Template" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Font" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Modern HTML"),
    );

    const workbench = container.querySelector<HTMLElement>(
      ".preview-workbench.resume-template-panel",
    );
    const primaryGrid = container.querySelector<HTMLElement>(
      ".resume-template-primary-controls .adaptive-field-grid",
    );
    const secondaryControls = container.querySelector<HTMLElement>(
      ".resume-template-secondary-controls",
    );
    const previewRegion = container.querySelector<HTMLElement>(
      ".preview-workbench__document",
    );
    const plateEditor = container.querySelector<HTMLElement>(
      ".resume-template-plate-editor",
    );

    expect(workbench).toBeTruthy();
    expect(primaryGrid).toHaveAttribute("data-columns", "3");
    expect(secondaryControls).toBeTruthy();
    expect(previewRegion).toContainElement(plateEditor);
    expect(plateEditor?.parentElement).toBe(previewRegion);
    expect(
      secondaryControls!.compareDocumentPosition(previewRegion!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const density = screen.getByRole("group", { name: "Density" });
    await user.click(within(density).getByRole("button", { name: "Spacious" }));
    expect(plateEditor?.style.getPropertyValue("--resume-template-line-height")).toBe("1.48");
    expect(plateEditor?.style.getPropertyValue("--resume-template-section-gap")).toBe("7.2mm");

    const bullets = screen.getByRole("group", { name: "Bullets" });
    await user.click(within(bullets).getByRole("button", { name: "Loose" }));
    expect(plateEditor?.style.getPropertyValue("--resume-template-bullet-gap")).toBe("2.4mm");
  });

  it("clones a built-in theme before chaining save default to the new version", async () => {
    const user = userEvent.setup();
    const sourceTemplate = sampleResumeTemplateListResponse.templates[0]!;
    const savedTemplate = {
      ...sourceTemplate,
      templateId: "custom:executive",
      displayName: "Executive",
      builtIn: false,
      activeVersion: {
        ...sourceTemplate.activeVersion,
        templateId: "custom:executive",
        versionId: "custom:executive:v1",
        displayName: "Executive",
      },
    };
    const saveResumeTemplate = vi.fn(async () => ({
      ok: true as const,
      template: savedTemplate,
    }));
    const setDefaultResumeTemplate = vi.fn(async () => ({
      ok: true as const,
      defaultTemplate: {
        ...sampleResumeTemplateListResponse.builtInDefault,
        templateId: savedTemplate.templateId,
        templateVersionId: savedTemplate.activeVersion.versionId,
        templateName: savedTemplate.displayName,
        assignmentSource: "profile_default" as const,
      },
    }));

    renderWithProviders(<ResumeTemplatePanel profileHtmlPreviewUrl={null} />, {
      ports: buildTestPorts({
        api: {
          saveResumeTemplate,
          setDefaultResumeTemplate,
        },
      }),
    });

    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveValue("Modern HTML"));
    await user.clear(name);
    await user.type(name, "Executive");
    await user.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() =>
      expect(saveResumeTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: undefined,
          displayName: "Executive",
          layout: {},
          theme: expect.objectContaining({
            fontFamily: sourceTemplate.activeVersion.theme.fontFamily,
            marginMm: { ...sourceTemplate.activeVersion.theme.marginMm },
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(setDefaultResumeTemplate).toHaveBeenCalledWith({
        templateId: savedTemplate.templateId,
        versionId: savedTemplate.activeVersion.versionId,
      }),
    );
  });
});
