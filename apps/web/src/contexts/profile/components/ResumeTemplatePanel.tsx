import type {
  ResumeTemplateLayout,
  ResumeTemplateSummary,
  ResumeTemplateTheme,
} from "@jobctrl/contracts";
import { IconDeviceFloppy, IconStar } from "@tabler/icons-react";
import { useEffect, useMemo, useState, type CSSProperties, type JSX } from "react";

import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldGroup, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
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
const FONT_SELECT_ITEMS = FONT_OPTIONS.map(([value, label]) => ({ label, value }));
const DENSITY_SELECT_ITEMS: Array<{ label: string; value: ResumeTemplateTheme["density"] }> = [{ label: "Compact", value: "compact" }, { label: "Balanced", value: "balanced" }, { label: "Spacious", value: "spacious" }];
const HEADER_SELECT_ITEMS: Array<{ label: string; value: ResumeTemplateTheme["headerLayout"] }> = [{ label: "Centered", value: "centered" }, { label: "Left", value: "left" }, { label: "Split", value: "split" }];
const HEADING_SELECT_ITEMS: Array<{ label: string; value: ResumeTemplateTheme["sectionHeadingStyle"] }> = [{ label: "Rule", value: "rule" }, { label: "Plain", value: "plain" }, { label: "Boxed", value: "boxed" }];
const ALIGNMENT_SELECT_ITEMS: Array<{ label: string; value: ResumeTemplateTheme["alignment"] }> = [{ label: "Justified", value: "justified" }, { label: "Left", value: "left" }];
const BULLET_SELECT_ITEMS: Array<{ label: string; value: ResumeTemplateTheme["bulletSpacing"] }> = [{ label: "Tight", value: "tight" }, { label: "Normal", value: "normal" }, { label: "Loose", value: "loose" }];

// These values belong to the generated resume document, not application chrome.
// The visual-role contract keeps this bounded output-fidelity exception explicit.
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
  const templateSelectItems = templates.map((template) => ({ label: template.displayName, value: template.templateId }));

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

  const workspaceControls = (
    <div className="resume-template-controls" aria-label="Template settings" role="group">
      <div className="resume-template-controls-header">
        <div className="resume-template-controls-title">
          <strong>Template settings</strong>
          <span>Typography, spacing, and page layout</span>
        </div>
        <div className="resume-template-actions">
          <Button
            disabled={!theme || isSaving || !displayName.trim()}
            size="sm"
            type="button"
            onClick={() => saveCurrent(false)}
          >
            <IconDeviceFloppy aria-hidden="true" data-icon="inline-start" />
            {saveTemplate.isPending ? "saving" : "save version"}
          </Button>
          <Button
            disabled={!theme || isSaving || !displayName.trim()}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => saveCurrent(true)}
          >
            <IconStar aria-hidden="true" data-icon="inline-start" />
            save default
          </Button>
          <Button
            disabled={!selectedTemplateCanBeDefault || Boolean(selectedTemplateIsDefault) || isSaving}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              if (!activeTemplate) return;
              setDefaultTemplate.mutate({
                templateId: activeTemplate.templateId,
                versionId: activeTemplate.activeVersion.versionId,
              });
            }}
          >
            <IconStar aria-hidden="true" data-icon="inline-start" />
            {setDefaultTemplate.isPending ? "setting" : "set default"}
          </Button>
          {selectedTemplateIsDefault ? (
            <span className="resume-template-default-status" role="status">
              <IconStar aria-hidden="true" />
              default template
            </span>
          ) : null}
        </div>
      </div>
      <FieldGroup className="field-grid">
        <Field className="field">
          <FieldLabel htmlFor="resume-template-selection">Template</FieldLabel>
          <Select
            disabled={!templates.length || isSaving}
            items={templateSelectItems}
            value={activeTemplate?.templateId ?? null}
            onValueChange={(nextValue) => { if (nextValue !== null) setActiveTemplateId(nextValue); }}
          >
            <SelectTrigger id="resume-template-selection" aria-label="Template" className="w-full"><SelectValue placeholder="No templates available" /></SelectTrigger>
            <SelectContent><SelectGroup>{templateSelectItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-name">Name</FieldLabel>
          <Input
            id="resume-template-name"
            disabled={!theme || isSaving}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-font">Font</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={FONT_SELECT_ITEMS}
            value={theme?.fontFamily ?? "sans"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("fontFamily", nextValue); }}
          >
            <SelectTrigger id="resume-template-font" aria-label="Font" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{FONT_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-density">Density</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={DENSITY_SELECT_ITEMS}
            value={theme?.density ?? "balanced"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("density", nextValue); }}
          >
            <SelectTrigger id="resume-template-density" aria-label="Density" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{DENSITY_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-header">Header</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={HEADER_SELECT_ITEMS}
            value={theme?.headerLayout ?? "centered"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("headerLayout", nextValue); }}
          >
            <SelectTrigger id="resume-template-header" aria-label="Header" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{HEADER_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-headings">Headings</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={HEADING_SELECT_ITEMS}
            value={theme?.sectionHeadingStyle ?? "rule"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("sectionHeadingStyle", nextValue); }}
          >
            <SelectTrigger id="resume-template-headings" aria-label="Headings" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{HEADING_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-alignment">Alignment</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={ALIGNMENT_SELECT_ITEMS}
            value={theme?.alignment ?? "justified"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("alignment", nextValue); }}
          >
            <SelectTrigger id="resume-template-alignment" aria-label="Alignment" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{ALIGNMENT_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-bullets">Bullets</FieldLabel>
          <Select
            disabled={!theme || isSaving}
            items={BULLET_SELECT_ITEMS}
            value={theme?.bulletSpacing ?? "normal"}
            onValueChange={(nextValue) => { if (nextValue !== null) updateTheme("bulletSpacing", nextValue); }}
          >
            <SelectTrigger id="resume-template-bullets" aria-label="Bullets" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{BULLET_SELECT_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-font-scale">Font scale</FieldLabel>
          <Input
            id="resume-template-font-scale"
            disabled={!theme || isSaving}
            max={1.2}
            min={0.85}
            step={0.01}
            type="number"
            value={theme?.fontScale ?? 1}
            onChange={(event) => updateTheme("fontScale", Number(event.target.value))}
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-accent">Accent</FieldLabel>
          <Input
            id="resume-template-accent"
            disabled={!theme || isSaving}
            type="color"
            value={theme?.accentColor ?? "#111111"}
            onChange={(event) => updateTheme("accentColor", event.target.value)}
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-top-margin">Top margin</FieldLabel>
          <Input
            id="resume-template-top-margin"
            disabled={!theme || isSaving}
            max={28}
            min={8}
            step={0.5}
            type="number"
            value={theme?.marginMm.top ?? 16.5}
            onChange={(event) => updateMargin("top", Number(event.target.value))}
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="resume-template-side-margin">Side margin</FieldLabel>
          <Input
            id="resume-template-side-margin"
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
      </FieldGroup>
      {templatesQuery.isLoading ? <div className="banner inline">Loading resume templates.</div> : null}
      {saveError || defaultError ? <div className="banner inline">{saveError ?? defaultError}</div> : null}
    </div>
  );

  return (
    <section className="form-section resume-template-panel resume-template-workspace" aria-label="Resume templates">
      <h3>Resume templates</h3>
      <div className="resume-template-shell">
        <ResumeStandalonePlateEditor
          className="resume-template-plate-editor"
          htmlUrl={profileHtmlPreviewUrl}
          previewStyle={previewStyle}
          title="Resume template preview"
          transformKey={theme ? JSON.stringify(theme) : "loading"}
          workspaceControls={workspaceControls}
        />
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
