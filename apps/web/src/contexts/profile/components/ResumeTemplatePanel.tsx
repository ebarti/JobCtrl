import type {
  ResumeTemplateLayout,
  ResumeTemplateSummary,
  ResumeTemplateTheme,
} from "@jobctrl/contracts";
import { IconDeviceFloppy, IconStar } from "@tabler/icons-react";
import { useEffect, useMemo, useState, type CSSProperties, type JSX } from "react";

import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import {
  useSaveResumeTemplateMutation,
  useSetDefaultResumeTemplateMutation,
} from "../hooks/useResumeTemplateMutations.js";
import { useResumeTemplatesQuery } from "../hooks/useResumeTemplatesQuery.js";

interface ResumeTemplatePanelProps {
  readonly profileHtmlPreviewUrl: string | null;
}

type TemplatePreviewStyle = CSSProperties & Record<`--${string}`, string | number>;

const FONT_STACKS: Record<ResumeTemplateTheme["fontFamily"], string> = {
  avenir: '"Avenir Next", "Avenir", "Nunito Sans", sans-serif',
  aptos: '"Aptos", "Aptos Display", "Arial", sans-serif',
  calibri: '"Calibri", "Aptos", "Arial", sans-serif',
  cambria: '"Cambria", "Georgia", "Times New Roman", serif',
  charter: '"Charter", "Bitstream Charter", "Georgia", serif',
  garamond: '"EB Garamond", "Garamond", "Georgia", serif',
  georgia: '"Georgia", "Times New Roman", serif',
  helvetica: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
  inter: '"Inter", "Aptos", "Arial", sans-serif',
  sans: '"Aptos", "Inter", "Arial", sans-serif',
  serif: '"Charter", "Georgia", serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", "Aptos", "Arial", sans-serif',
  source_serif: '"Source Serif 4", "Source Serif Pro", "Georgia", serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  times: '"Times New Roman", "Times", serif',
};

const FONT_LABELS: Record<ResumeTemplateTheme["fontFamily"], string> = {
  sans: "Sans",
  serif: "Serif",
  system: "System",
  aptos: "Aptos",
  avenir: "Avenir",
  helvetica: "Helvetica",
  inter: "Inter",
  source_sans: "Source Sans",
  calibri: "Calibri",
  georgia: "Georgia",
  garamond: "Garamond",
  charter: "Charter",
  source_serif: "Source Serif",
  times: "Times New Roman",
  cambria: "Cambria",
};

const FONT_OPTIONS = Object.entries(FONT_LABELS) as Array<[ResumeTemplateTheme["fontFamily"], string]>;

const DENSITY_TOKENS: Record<
  ResumeTemplateTheme["density"],
  {
    readonly entryGapMm: number;
    readonly lineHeight: number;
    readonly listGapMm: number;
    readonly metaLineHeight: number;
    readonly sectionGapMm: number;
  }
> = {
  compact: {
    entryGapMm: 1.4,
    lineHeight: 1.2,
    listGapMm: 0.35,
    metaLineHeight: 1.12,
    sectionGapMm: 2.2,
  },
  balanced: {
    entryGapMm: 3.2,
    lineHeight: 1.32,
    listGapMm: 1.1,
    metaLineHeight: 1.22,
    sectionGapMm: 4.1,
  },
  spacious: {
    entryGapMm: 5.8,
    lineHeight: 1.48,
    listGapMm: 2.4,
    metaLineHeight: 1.34,
    sectionGapMm: 7.2,
  },
};

export function ResumeTemplatePanel({ profileHtmlPreviewUrl }: ResumeTemplatePanelProps): JSX.Element {
  const templatesQuery = useResumeTemplatesQuery();
  const saveTemplate = useSaveResumeTemplateMutation();
  const setDefaultTemplate = useSetDefaultResumeTemplateMutation();
  const templates = templatesQuery.data?.templates ?? [];
  const fallbackTemplate =
    templateByMetadata(templates, templatesQuery.data?.defaultTemplate) ??
    templateByMetadata(templates, templatesQuery.data?.builtInDefault) ??
    templates[0] ??
    null;
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const activeTemplate = templates.find((template) => template.templateId === activeTemplateId) ?? fallbackTemplate;
  const [displayName, setDisplayName] = useState("");
  const [theme, setTheme] = useState<ResumeTemplateTheme | null>(null);
  const [layout, setLayout] = useState<ResumeTemplateLayout>({});

  useEffect(() => {
    if (!activeTemplateId && fallbackTemplate) {
      setActiveTemplateId(fallbackTemplate.templateId);
    }
  }, [activeTemplateId, fallbackTemplate]);

  useEffect(() => {
    if (!activeTemplate) return;
    setDisplayName(activeTemplate.displayName);
    setTheme(cloneTheme(activeTemplate.activeVersion.theme));
    setLayout({ ...activeTemplate.activeVersion.layout });
  }, [activeTemplate]);

  const previewStyle = useMemo(
    () => (theme ? previewStyleForTheme(theme) : undefined),
    [theme],
  );
  const saveError = saveTemplate.error instanceof Error ? saveTemplate.error.message : null;
  const defaultError = setDefaultTemplate.error instanceof Error ? setDefaultTemplate.error.message : null;
  const selectedTemplateCanBeDefault = Boolean(activeTemplate);
  const selectedTemplateIsDefault =
    activeTemplate && templatesQuery.data?.defaultTemplate?.templateId === activeTemplate.templateId;
  const isSaving = saveTemplate.isPending || setDefaultTemplate.isPending;

  const updateTheme = <K extends keyof ResumeTemplateTheme>(key: K, value: ResumeTemplateTheme[K]) => {
    setTheme((current) => (current ? { ...current, [key]: value } : current));
  };
  const updateMargin = (key: keyof ResumeTemplateTheme["marginMm"], value: number) => {
    setTheme((current) =>
      current
        ? {
            ...current,
            marginMm: {
              ...current.marginMm,
              [key]: value,
            },
          }
        : current,
    );
  };
  const saveCurrent = (makeDefault: boolean) => {
    if (!theme || !displayName.trim()) return;
    const editableTemplateId = activeTemplate?.builtIn ? undefined : activeTemplate?.templateId;
    saveTemplate.mutate(
      {
        templateId: editableTemplateId,
        displayName: displayName.trim(),
        theme,
        layout,
      },
      {
        onSuccess: (response) => {
          setActiveTemplateId(response.template.templateId);
          if (makeDefault) {
            setDefaultTemplate.mutate({
              templateId: response.template.templateId,
              versionId: response.template.activeVersion.versionId,
            });
          }
        },
      },
    );
  };

  return (
    <section className="form-section resume-template-panel resume-template-workspace" aria-label="Resume templates">
      <h3>Resume templates</h3>
      <div className="resume-template-shell">
        <div className="resume-template-controls">
          <div className="field-grid">
            <label className="field">
              <span>Template</span>
              <select
                disabled={!templates.length || isSaving}
                value={activeTemplate?.templateId ?? ""}
                onChange={(event) => setActiveTemplateId(event.target.value)}
              >
                {templates.map((template) => (
                  <option key={template.templateId} value={template.templateId}>
                    {template.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input
                disabled={!theme || isSaving}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Font</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.fontFamily ?? "sans"}
                onChange={(event) => updateTheme("fontFamily", event.target.value as ResumeTemplateTheme["fontFamily"])}
              >
                {FONT_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Density</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.density ?? "balanced"}
                onChange={(event) => updateTheme("density", event.target.value as ResumeTemplateTheme["density"])}
              >
                <option value="compact">Compact</option>
                <option value="balanced">Balanced</option>
                <option value="spacious">Spacious</option>
              </select>
            </label>
            <label className="field">
              <span>Header</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.headerLayout ?? "centered"}
                onChange={(event) =>
                  updateTheme("headerLayout", event.target.value as ResumeTemplateTheme["headerLayout"])
                }
              >
                <option value="centered">Centered</option>
                <option value="left">Left</option>
                <option value="split">Split</option>
              </select>
            </label>
            <label className="field">
              <span>Headings</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.sectionHeadingStyle ?? "rule"}
                onChange={(event) =>
                  updateTheme("sectionHeadingStyle", event.target.value as ResumeTemplateTheme["sectionHeadingStyle"])
                }
              >
                <option value="rule">Rule</option>
                <option value="plain">Plain</option>
                <option value="boxed">Boxed</option>
              </select>
            </label>
            <label className="field">
              <span>Alignment</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.alignment ?? "justified"}
                onChange={(event) => updateTheme("alignment", event.target.value as ResumeTemplateTheme["alignment"])}
              >
                <option value="justified">Justified</option>
                <option value="left">Left</option>
              </select>
            </label>
            <label className="field">
              <span>Bullets</span>
              <select
                disabled={!theme || isSaving}
                value={theme?.bulletSpacing ?? "normal"}
                onChange={(event) =>
                  updateTheme("bulletSpacing", event.target.value as ResumeTemplateTheme["bulletSpacing"])
                }
              >
                <option value="tight">Tight</option>
                <option value="normal">Normal</option>
                <option value="loose">Loose</option>
              </select>
            </label>
            <label className="field">
              <span>Font scale</span>
              <input
                disabled={!theme || isSaving}
                max={1.2}
                min={0.85}
                step={0.01}
                type="number"
                value={theme?.fontScale ?? 1}
                onChange={(event) => updateTheme("fontScale", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Accent</span>
              <input
                disabled={!theme || isSaving}
                type="color"
                value={theme?.accentColor ?? "#111111"}
                onChange={(event) => updateTheme("accentColor", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Top margin</span>
              <input
                disabled={!theme || isSaving}
                max={28}
                min={8}
                step={0.5}
                type="number"
                value={theme?.marginMm.top ?? 16.5}
                onChange={(event) => updateMargin("top", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Side margin</span>
              <input
                disabled={!theme || isSaving}
                max={28}
                min={8}
                step={0.5}
                type="number"
                value={theme?.marginMm.left ?? 17.5}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  updateMargin("left", value);
                  updateMargin("right", value);
                }}
              />
            </label>
          </div>
          <div className="resume-template-actions">
            <button className="tab on" disabled={!theme || isSaving || !displayName.trim()} type="button" onClick={() => saveCurrent(false)}>
              <IconDeviceFloppy size={14} aria-hidden="true" />
              {saveTemplate.isPending ? "saving" : "save version"}
            </button>
            <button className="tab" disabled={!theme || isSaving || !displayName.trim()} type="button" onClick={() => saveCurrent(true)}>
              <IconStar size={14} aria-hidden="true" />
              save default
            </button>
            <button
              className="tab"
              disabled={!selectedTemplateCanBeDefault || Boolean(selectedTemplateIsDefault) || isSaving}
              type="button"
              onClick={() => {
                if (!activeTemplate) return;
                setDefaultTemplate.mutate({
                  templateId: activeTemplate.templateId,
                  versionId: activeTemplate.activeVersion.versionId,
                });
              }}
            >
              <IconStar size={14} aria-hidden="true" />
              {setDefaultTemplate.isPending ? "setting" : "set default"}
            </button>
            {selectedTemplateIsDefault ? <span className="tag ok">default</span> : null}
          </div>
          {templatesQuery.isLoading ? <div className="banner inline">Loading resume templates.</div> : null}
          {saveError || defaultError ? <div className="banner inline">{saveError ?? defaultError}</div> : null}
        </div>
        <div className="resume-template-preview">
          <ResumeStandalonePlateEditor
            className="resume-template-plate-editor"
            htmlUrl={profileHtmlPreviewUrl}
            previewStyle={previewStyle}
            title="Resume template preview"
            transformKey={theme ? JSON.stringify(theme) : "loading"}
          />
        </div>
      </div>
    </section>
  );
}

function cloneTheme(theme: ResumeTemplateTheme): ResumeTemplateTheme {
  return {
    ...theme,
    marginMm: { ...theme.marginMm },
    sectionOrder: [...theme.sectionOrder],
    hiddenSections: [...theme.hiddenSections],
  };
}

function templateByMetadata(
  templates: readonly ResumeTemplateSummary[],
  metadata: { templateId: string } | null | undefined,
): ResumeTemplateSummary | null {
  return metadata ? templates.find((template) => template.templateId === metadata.templateId) ?? null : null;
}

function previewStyleForTheme(theme: ResumeTemplateTheme): TemplatePreviewStyle {
  const density = DENSITY_TOKENS[theme.density];
  const fontSize = (points: number) => `${Number((points * theme.fontScale).toFixed(2))}pt`;
  const headerTextAlign = theme.headerLayout === "centered" ? "center" : "left";
  const headerJustify = theme.headerLayout === "centered" ? "center" : "flex-start";
  const bodyAlign = theme.alignment === "justified" ? "justify" : "left";
  const headingRuleOpacity = theme.sectionHeadingStyle === "rule" ? "1" : "0";
  const headingBoxBorder = theme.sectionHeadingStyle === "boxed" ? `0.6pt solid ${theme.accentColor}` : "0 solid transparent";
  return {
    "--resume-template-font-family": FONT_STACKS[theme.fontFamily],
    "--resume-template-body-font-size": fontSize(9.6),
    "--resume-template-contact-font-size": fontSize(8.8),
    "--resume-template-entry-meta-font-size": fontSize(8.9),
    "--resume-template-heading-font-size": fontSize(9.5),
    "--resume-template-name-font-size": fontSize(22),
    "--resume-template-accent": theme.accentColor,
    "--resume-template-page-padding": `${theme.marginMm.top}mm ${theme.marginMm.right}mm ${theme.marginMm.bottom}mm ${theme.marginMm.left}mm`,
    "--resume-template-header-justify": headerJustify,
    "--resume-template-header-text-align": headerTextAlign,
    "--resume-template-body-align": bodyAlign,
    "--resume-template-heading-rule-opacity": headingRuleOpacity,
    "--resume-template-heading-box-border": headingBoxBorder,
    "--resume-template-heading-padding": theme.sectionHeadingStyle === "boxed" ? "1mm 1.6mm" : "0",
    "--resume-template-line-height": density.lineHeight,
    "--resume-template-meta-line-height": density.metaLineHeight,
    "--resume-template-section-gap": `${density.sectionGapMm}mm`,
    "--resume-template-entry-gap": `${density.entryGapMm}mm`,
    "--resume-template-list-gap": `${density.listGapMm}mm`,
    "--resume-template-bullet-gap": `${bulletGap(theme.bulletSpacing)}mm`,
  };
}

function bulletGap(value: ResumeTemplateTheme["bulletSpacing"]): number {
  if (value === "tight") return 0.05;
  if (value === "loose") return 2.4;
  return 0.8;
}
