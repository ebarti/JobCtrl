import { ProfileSchema } from "@jobctrl/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sampleProfileResponse,
  sampleResumeTemplateListResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { FakePdfExportPort, buildTestPorts } from "../../../test/testPorts.js";
import { ProfileEditor } from "./ProfileEditor.js";
import { resumeTemplatePreviewStyle } from "./ResumeTemplatePanel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ProfileEditor>", () => {
  it("serializes resume theme tokens without losing print precision", () => {
    const style = resumeTemplatePreviewStyle({
      ...sampleResumeTemplateListResponse.effectiveDefaultVersion.theme,
      accentColor: "#123456",
      fontScale: 1.1,
      headerLayout: "left",
      sectionHeadingStyle: "plain",
    });

    expect(style).toMatchObject({
      "--resume-template-accent": "#123456",
      "--resume-template-body-font-size": "11.385pt",
      "--resume-template-header-justify": "flex-start",
      "--resume-template-header-text-align": "left",
      "--resume-template-heading-rule-border": "none",
      "--resume-template-page-block-size": "297mm",
      "--resume-template-page-inline-size": "210mm",
    });
  });

  it("renders the Profile baseline resume through the Plate editor pane", async () => {
    const user = userEvent.setup();
    const pdfExport = new FakePdfExportPort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `
            <main class="resume-page">
              <section class="resume-section">
                <h1 data-resume-layout-target="profile-name">QA Candidate</h1>
                <p>Platform engineering leader.</p>
              </section>
            </main>
          `,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const ports = buildTestPorts({
      api: {
        profile: async () => sampleProfileResponse,
        profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
        settings: async () => sampleSettingsResponse,
      },
      pdfExport,
    });
    renderWithProviders(<ProfileEditor />, {
      ports,
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Resume data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profile data" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("navigation", { name: "Profile sections" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume editor" }));
    expect(await screen.findByText("Baseline resume editor")).toBeInTheDocument();
    expect(await screen.findByText("Plate HTML/CSS editor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    const plateEditor = await screen.findByRole("textbox", { name: "Baseline resume editor editor" });
    await user.click(plateEditor);
    await user.type(plateEditor, " unsaved export edit");
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(pdfExport.downloadPdf).toHaveBeenCalledTimes(1));
    expect(pdfExport.downloadPdf).toHaveBeenCalledWith({
      filename: "baseline-resume.pdf",
      source: expect.any(HTMLElement),
    });
    const baselineExport = pdfExport.downloadPdf.mock.calls[0]?.[0];
    expect(baselineExport?.source).toHaveClass("resume-plate-document");
    expect(baselineExport?.source).toHaveTextContent("unsaved export edit");
    pdfExport.downloadPdf.mockRejectedValueOnce(new Error("internal renderer path /private/resume"));
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF export failed. Try again.");
    expect(screen.queryByText(/internal renderer path/i)).not.toBeInTheDocument();
    expect(ports.telemetry.event).toHaveBeenCalledWith("resume_pdf_export_failed", {
      operation: "resume_pdf_export",
    });
    expect(ports.telemetry.error).not.toHaveBeenCalled();
    expect(document.querySelector("main.resume-page")).toBeNull();
    expect(document.querySelector("div.resume-page")).toBeInTheDocument();
    const baselineEditor = document.querySelector<HTMLElement>(
      ".profile-resume-plate-editor",
    );
    expect(baselineEditor?.style.getPropertyValue("--resume-template-font-family")).toBe(
      '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
    expect(baselineEditor?.style.getPropertyValue("--resume-template-body-font-size")).toBe(
      "10.35pt",
    );
    expect(baselineEditor?.style.getPropertyValue("--resume-template-page-padding")).toBe(
      "16.5mm 17.5mm 18mm 17.5mm",
    );
    expect(screen.queryByText("Baseline resume preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open PDF/i })).not.toBeInTheDocument();
  });

  it("projects direct Plate bullet edits into the saved structured Profile", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async (body: { profileText: string }) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(body.profileText) as typeof sampleProfileResponse.profile,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `
            <main class="resume-page">
              <h1 data-resume-layout-target="personal:full_name">Jordan Candidate</h1>
              <section class="resume-section">
                <h2 data-resume-layout-target="section:experience">Experience</h2>
                <article class="resume-entry">
                  <ul class="resume-bullets">
                    <li data-resume-layout-target="experience:exp-1:bullet:1">Scaled the platform 10x.</li>
                  </ul>
                </article>
              </section>
            </main>
          `,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          resumeTemplates: async () => sampleResumeTemplateListResponse,
          settings: async () => sampleSettingsResponse,
          updateProfile,
        },
      }),
      withRouter: true,
    });

    await user.click(await screen.findByRole("button", { name: "Resume editor" }));
    const plateBullet = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-resume-layout-target="experience:exp-1:bullet:1"]',
      );
      expect(element).toBeTruthy();
      return element!;
    });
    await user.click(plateBullet);
    await user.type(screen.getByRole("textbox", { name: "Baseline resume editor editor" }), " Updated in Plate.");
    await waitFor(() => expect(plateBullet).toHaveTextContent("Scaled the platform 10x. Updated in Plate."));
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Profile data" }));
    await user.click(screen.getByRole("button", { name: /Experience entries/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Bullet 1")).toHaveValue("Scaled the platform 10x. Updated in Plate."),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(updateProfile.mock.calls[0]![0].profileText).resume.experience_entries[0].bullets[0],
    ).toBe("Scaled the platform 10x. Updated in Plate.");
  });

  it("persists the manually reordered experience sequence through the Profile mutation", async () => {
    const user = userEvent.setup();
    const profileResponse = {
      ...sampleProfileResponse,
      profile: ProfileSchema.parse(sampleProfileResponse.profile),
    };
    const baseEntry = profileResponse.profile.resume.experience_entries[0]!;
    profileResponse.profile.resume.experience_entries = [
      {
        ...baseEntry,
        id: "older",
        title: "Older role",
        date_range: "Jan 2018 - Dec 2020",
      },
      {
        ...baseEntry,
        id: "current",
        title: "Current role",
        date_range: "Mar 2024 - Present",
      },
      {
        ...baseEntry,
        id: "recent",
        title: "Recent role",
        date_range: "Jun 2021 - Feb 2024",
      },
    ];
    profileResponse.profile.resume.tailoring_rules.required_experience_entry_ids = [
      "older",
      "current",
      "recent",
    ];
    const updateProfile = vi.fn(async (body: { profileText: string }) => ({
      ...profileResponse,
      profile: JSON.parse(body.profileText) as typeof profileResponse.profile,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('<main class="resume-page"><p>Resume</p></main>', {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile: async () => profileResponse,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          settings: async () => sampleSettingsResponse,
          updateProfile,
        },
      }),
      withRouter: true,
    });

    await screen.findByLabelText("Full name");
    await user.click(await screen.findByRole("button", { name: /Experience entries/ }));
    await user.click(
      screen.getByRole("button", { name: "Move Initech - Current role up" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));

    expect(
      JSON.parse(updateProfile.mock.calls[0]![0].profileText).resume.experience_entries.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(["current", "older", "recent"]);
  });

  it("renders preferences without the PDF preview pane", async () => {
    const user = userEvent.setup();
    const pdfExport = new FakePdfExportPort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `
            <main class="resume-page">
              <section class="resume-section">
                <h1 data-resume-layout-target="profile-name">QA Candidate</h1>
                <p>Platform engineering leader.</p>
              </section>
            </main>
          `,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    renderWithProviders(<ProfileEditor section="preferences" />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          settings: async () => sampleSettingsResponse,
        },
        pdfExport,
      }),
    });

    expect(
      await screen.findByRole("heading", { name: "Configuration & templates" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Preferences sections" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Application configuration" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Location filter")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Target search" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Quality gates" }));
    expect(screen.getByRole("group", { name: "Revision policy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum fit score")).toHaveValue(8);
    expect(screen.getByLabelText("Must-have coverage (%)")).toHaveValue(85);
    expect(screen.getByLabelText("Revision attempts")).toHaveValue(1);
    expect(screen.queryByText("Baseline resume editor")).not.toBeInTheDocument();
    expect(await screen.findByText("Resume template preview")).toBeInTheDocument();
    const templatePreview = document.querySelector<HTMLElement>(".resume-template-plate-editor");
    expect(templatePreview).toBeTruthy();
    expect(templatePreview?.querySelector(".resume-template-controls")).toBeTruthy();
    expect(templatePreview?.querySelector(".resume-template-actions")).toBeTruthy();
    await user.click(screen.getByLabelText("Density"));
    await user.click(await screen.findByRole("option", { name: "Spacious" }));
    expect(templatePreview?.style.getPropertyValue("--resume-template-line-height")).toBe("1.48");
    expect(templatePreview?.style.getPropertyValue("--resume-template-section-gap")).toBe("7.2mm");
    expect(templatePreview?.style.getPropertyValue("--resume-template-entry-gap")).toBe("5.8mm");
    expect(templatePreview?.style.getPropertyValue("--resume-template-list-gap")).toBe("2.4mm");
    await user.click(screen.getByLabelText("Bullets"));
    await user.click(await screen.findByRole("option", { name: "Loose" }));
    expect(templatePreview?.style.getPropertyValue("--resume-template-bullet-gap")).toBe("2.4mm");
    const fontSelects = screen.getAllByLabelText("Font");
    expect(fontSelects).toHaveLength(2);
    await user.click(fontSelects[0]!);
    expect(await screen.findByRole("option", { name: "Garamond" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(fontSelects[1]!);
    expect(await screen.findByRole("option", { name: "Garamond" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Resume" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Size")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("Size")).toHaveValue(100);
    expect(screen.getByLabelText("Size")).toHaveAccessibleDescription("Percentage of the resume default size.");
    expect(screen.queryByLabelText("Resize profile and resume editor panes")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(pdfExport.downloadPdf).toHaveBeenCalledWith({
        filename: "resume-template-preview.pdf",
        source: expect.any(HTMLElement),
      }),
    );
  });

  it("uses the exact pinned resume template version instead of the latest revision", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    const pinnedVersion = {
      ...sampleResumeTemplateListResponse.effectiveDefaultVersion,
      versionId: "built_in:modern-html:v1-pinned",
      theme: {
        ...sampleResumeTemplateListResponse.effectiveDefaultVersion.theme,
        accentColor: "#123456",
        fontFamily: "georgia" as const,
      },
    };
    const latestVersion = {
      ...pinnedVersion,
      versionId: "built_in:modern-html:v2-latest",
      versionNumber: 2,
      theme: {
        ...pinnedVersion.theme,
        accentColor: "#654321",
        fontFamily: "sans" as const,
      },
    };

    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          resumeTemplates: async () => ({
            ...sampleResumeTemplateListResponse,
            templates: sampleResumeTemplateListResponse.templates.map((template) => ({
              ...template,
              activeVersion: latestVersion,
            })),
            effectiveDefaultVersion: pinnedVersion,
          }),
          settings: async () => sampleSettingsResponse,
        },
      }),
      withRouter: true,
    });

    await screen.findByRole("heading", { name: "Resume data" });
    await user.click(screen.getByRole("button", { name: "Resume editor" }));
    expect(await screen.findByText("Baseline resume editor")).toBeInTheDocument();
    const baselineEditor = document.querySelector<HTMLElement>(
      ".profile-resume-plate-editor",
    );
    expect(baselineEditor?.style.getPropertyValue("--resume-template-font-family")).toBe(
      'Georgia, "Times New Roman", Times, serif',
    );
    expect(baselineEditor?.style.getPropertyValue("--resume-template-accent")).toBe(
      "#123456",
    );
  });

  it("preserves a Profile draft while switching workspace views", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          settings: async () => sampleSettingsResponse,
        },
      }),
      withRouter: true,
    });

    const fullName = await screen.findByLabelText("Full name");
    await user.clear(fullName);
    await user.type(fullName, "Updated Candidate");
    await user.click(screen.getByRole("button", { name: "Resume editor" }));
    await user.click(screen.getByRole("button", { name: "Profile data" }));

    expect(screen.getByLabelText("Full name")).toHaveValue("Updated Candidate");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("preserves the persisted resizable split workspace", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    const ports = buildTestPorts({
      api: {
        profile: async () => sampleProfileResponse,
        profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
        settings: async () => sampleSettingsResponse,
      },
    });
    ports.storage.set("profile-preview-split-width", 70);
    const saveWidth = vi.spyOn(ports.storage, "set");
    const view = renderWithProviders(<ProfileEditor />, { ports, withRouter: true });

    await screen.findByRole("heading", { name: "Resume data" });
    await user.click(screen.getByRole("button", { name: "Split view" }));
    expect(screen.getByLabelText("Full name")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Bold" })).toBeVisible();
    const resizer = screen.getByRole("button", { name: "Resize profile and resume editor panes" });
    const workspace = view.container.querySelector<HTMLElement>(".profile-workspace-content");
    expect(workspace?.style.getPropertyValue("--profile-editor-width")).toBe("70%");

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });

    expect(saveWidth).toHaveBeenLastCalledWith("profile-preview-split-width", 66);
    expect(workspace?.style.getPropertyValue("--profile-editor-width")).toBe("66%");
  });

  it("bounds a Profile load failure with a retry action", async () => {
    const user = userEvent.setup();
    const profile = vi.fn()
      .mockRejectedValueOnce(new Error("Saved profile could not be read."))
      .mockResolvedValue(sampleProfileResponse);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          settings: async () => sampleSettingsResponse,
        },
      }),
      withRouter: true,
    });

    expect(await screen.findByText("Profile unavailable")).toBeInTheDocument();
    expect(screen.getByText("Saved profile could not be read.")).toBeInTheDocument();
    expect(screen.queryByText("Loading profile")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Full name")).toBeInTheDocument();
  });
});
