import type {
  ResumeTemplateLayout,
  ResumeTemplateSummary,
  ResumeTemplateTheme,
} from "@jobctrl/contracts";
import { IconDeviceFloppy, IconStar } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type JSX,
} from "react";

import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import { AdaptiveFieldGrid } from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { PreviewWorkbench } from "../../../shared/ui/preview-workbench.js";
import { SegmentedField } from "../../../shared/ui/segmented-field.js";
import { SelectField } from "../../../shared/ui/select-field.js";
import { StatusLabel } from "../../../shared/ui/status-label.js";
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

const FONT_OPTIONS = Object.entries(FONT_LABELS) as Array<
  [ResumeTemplateTheme["fontFamily"], string]
>;

const FONT_SELECT_OPTIONS = FONT_OPTIONS.map(([value, label]) => ({ value, label }));

const DENSITY_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "balanced", label: "Balanced" },
  { value: "spacious", label: "Spacious" },
] as const;

const HEADER_LAYOUT_OPTIONS = [
  { value: "centered", label: "Centered" },
  { value: "left", label: "Left" },
  { value: "split", label: "Split" },
] as const;

const HEADING_STYLE_OPTIONS = [
  { value: "rule", label: "Rule" },
  { value: "plain", label: "Plain" },
  { value: "boxed", label: "Boxed" },
] as const;

const ALIGNMENT_OPTIONS = [
  { value: "justified", label: "Justified" },
  { value: "left", label: "Left" },
] as const;

const BULLET_SPACING_OPTIONS = [
  { value: "tight", label: "Tight" },
  { value: "normal", label: "Normal" },
  { value: "loose", label: "Loose" },
] as const;

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
  const fieldIdPrefix = useId();
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
    <PreviewWorkbench
      className="resume-template-panel"
      aria-label="Resume templates"
      title="Resume templates"
      status={
        selectedTemplateIsDefault ? (
          <StatusLabel className="resume-template-default-state" tone="ok">
            Default template
          </StatusLabel>
        ) : undefined
      }
      primaryControls={
        <AdaptiveFieldGrid
          className="resume-template-primary-controls"
          columns={3}
          density="compact"
          minColumnWidth={168}
        >
          <SelectField
            label="Template"
            disabled={!templates.length || isSaving}
            options={templates.map((template) => ({
              value: template.templateId,
              label: template.displayName,
            }))}
            value={activeTemplate?.templateId ?? ""}
            onValueChange={setActiveTemplateId}
          />
          <Field data-disabled={!theme || isSaving}>
            <FieldLabel htmlFor={`${fieldIdPrefix}-name`}>Name</FieldLabel>
            <Input
              id={`${fieldIdPrefix}-name`}
              disabled={!theme || isSaving}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <SelectField
            label="Font"
            disabled={!theme || isSaving}
            options={FONT_SELECT_OPTIONS}
            value={theme?.fontFamily ?? "sans"}
            onValueChange={(value) =>
              updateTheme("fontFamily", value as ResumeTemplateTheme["fontFamily"])
            }
          />
        </AdaptiveFieldGrid>
      }
      secondaryControls={
        <div className="resume-template-secondary-controls">
          <AdaptiveFieldGrid
            className="resume-template-style-controls"
            columns={3}
            density="compact"
            minColumnWidth={238}
          >
            <SegmentedField
              label="Density"
              disabled={!theme || isSaving}
              options={DENSITY_OPTIONS}
              value={theme?.density ?? "balanced"}
              onValueChange={(value) =>
                updateTheme("density", value as ResumeTemplateTheme["density"])
              }
            />
            <SegmentedField
              label="Header"
              disabled={!theme || isSaving}
              options={HEADER_LAYOUT_OPTIONS}
              value={theme?.headerLayout ?? "centered"}
              onValueChange={(value) =>
                updateTheme("headerLayout", value as ResumeTemplateTheme["headerLayout"])
              }
            />
            <SegmentedField
              label="Headings"
              disabled={!theme || isSaving}
              options={HEADING_STYLE_OPTIONS}
              value={theme?.sectionHeadingStyle ?? "rule"}
              onValueChange={(value) =>
                updateTheme(
                  "sectionHeadingStyle",
                  value as ResumeTemplateTheme["sectionHeadingStyle"],
                )
              }
            />
            <SegmentedField
              label="Alignment"
              disabled={!theme || isSaving}
              options={ALIGNMENT_OPTIONS}
              value={theme?.alignment ?? "justified"}
              onValueChange={(value) =>
                updateTheme("alignment", value as ResumeTemplateTheme["alignment"])
              }
            />
            <SegmentedField
              label="Bullets"
              disabled={!theme || isSaving}
              options={BULLET_SPACING_OPTIONS}
              value={theme?.bulletSpacing ?? "normal"}
              onValueChange={(value) =>
                updateTheme("bulletSpacing", value as ResumeTemplateTheme["bulletSpacing"])
              }
            />
            <Field data-disabled={!theme || isSaving}>
              <FieldLabel htmlFor={`${fieldIdPrefix}-font-scale`}>Font scale</FieldLabel>
              <Input
                id={`${fieldIdPrefix}-font-scale`}
                disabled={!theme || isSaving}
                max={1.2}
                min={0.85}
                step={0.01}
                type="number"
                value={theme?.fontScale ?? 1}
                onChange={(event) => updateTheme("fontScale", Number(event.target.value))}
              />
            </Field>
            <Field data-disabled={!theme || isSaving}>
              <FieldLabel htmlFor={`${fieldIdPrefix}-accent`}>Accent</FieldLabel>
              <Input
                id={`${fieldIdPrefix}-accent`}
                className="resume-template-accent-input"
                disabled={!theme || isSaving}
                type="color"
                value={theme?.accentColor ?? "#111111"}
                onChange={(event) => updateTheme("accentColor", event.target.value)}
              />
            </Field>
            <Field data-disabled={!theme || isSaving}>
              <FieldLabel htmlFor={`${fieldIdPrefix}-top-margin`}>Top margin</FieldLabel>
              <Input
                id={`${fieldIdPrefix}-top-margin`}
                disabled={!theme || isSaving}
                max={28}
                min={8}
                step={0.5}
                type="number"
                value={theme?.marginMm.top ?? 16.5}
                onChange={(event) => updateMargin("top", Number(event.target.value))}
              />
            </Field>
            <Field data-disabled={!theme || isSaving}>
              <FieldLabel htmlFor={`${fieldIdPrefix}-side-margin`}>Side margin</FieldLabel>
              <Input
                id={`${fieldIdPrefix}-side-margin`}
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
            </Field>
          </AdaptiveFieldGrid>
          {templatesQuery.isLoading ? (
            <div className="banner inline">Loading resume templates.</div>
          ) : null}
          {saveError || defaultError ? (
            <div className="banner inline" role="alert">
              {saveError ?? defaultError}
            </div>
          ) : null}
        </div>
      }
      actions={
        <>
          <Button
            disabled={!theme || isSaving || !displayName.trim()}
            size="sm"
            type="button"
            onClick={() => saveCurrent(false)}
          >
            <IconDeviceFloppy aria-hidden="true" data-icon="inline-start" />
            {saveTemplate.isPending ? "Saving…" : "Save version"}
          </Button>
          <Button
            disabled={!theme || isSaving || !displayName.trim()}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => saveCurrent(true)}
          >
            <IconStar aria-hidden="true" data-icon="inline-start" />
            Save default
          </Button>
          <Button
            disabled={
              !selectedTemplateCanBeDefault || Boolean(selectedTemplateIsDefault) || isSaving
            }
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              if (!activeTemplate) return;
              setDefaultTemplate.mutate({
                templateId: activeTemplate.templateId,
                versionId: activeTemplate.activeVersion.versionId,
              });
            }}
          >
            <IconStar aria-hidden="true" data-icon="inline-start" />
            {setDefaultTemplate.isPending ? "Setting…" : "Set default"}
          </Button>
        </>
      }
      previewLabel="Resume template preview"
    >
      <ResumeStandalonePlateEditor
        className="resume-template-plate-editor"
        htmlUrl={profileHtmlPreviewUrl}
        previewStyle={previewStyle}
        title="Resume template preview"
        transformKey={theme ? JSON.stringify(theme) : "loading"}
      />
    </PreviewWorkbench>
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
