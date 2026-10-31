import type {
  ResumeTemplateListResponse,
  ResumeTemplateLayout,
  ResumeTemplateSummary,
  ResumeTemplateTheme,
  ResumeTemplateVersionSummary,
} from "@jobctrl/contracts";
import { IconDeviceFloppy, IconStar } from "@tabler/icons-react";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";

import { ResumeStandalonePlateEditor } from "../../materials/components/ResumeAuditPins.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldGroup, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  useSaveResumeTemplateMutation,
  useSetDefaultResumeTemplateMutation,
} from "../hooks/useResumeTemplateMutations.js";
import { useResumeTemplatesQuery } from "../hooks/useResumeTemplatesQuery.js";

interface ResumeTemplatePanelProps {
  readonly profileHtmlPreviewUrl: string | null;
}

export type TemplatePreviewStyle = CSSProperties & Record<`--${string}`, string | number>;

const FONT_STACKS: Record<ResumeTemplateTheme["fontFamily"], string> = {
  avenir: '"Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif',
  aptos: '"Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif',
  calibri: '"Calibri", "Aptos", Arial, sans-serif',
  cambria: '"Cambria", Georgia, "Times New Roman", serif',
  charter: '"Charter", "Bitstream Charter", Georgia, serif',
  garamond: '"EB Garamond", "Garamond", Georgia, serif',
  georgia: 'Georgia, "Times New Roman", Times, serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  inter: '"Inter", "Aptos", Arial, sans-serif',
  sans: '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", "Aptos", Arial, sans-serif',
  source_serif: '"Source Serif 4", "Source Serif Pro", Georgia, serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  times: '"Times New Roman", Times, serif',
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

interface TemplateDraft {
  readonly template: ResumeTemplateSummary;
  readonly displayName: string;
  readonly theme: ResumeTemplateTheme;
  readonly layout: ResumeTemplateLayout;
  readonly dirty: boolean;
}

function templateDraft(template: ResumeTemplateSummary): TemplateDraft {
  return {
    template,
    displayName: template.displayName,
    theme: cloneTheme(template.activeVersion.theme),
    layout: { ...template.activeVersion.layout },
    dirty: false,
  };
}

function keepChanged<T>(base: T, draft: T, latest: T): T {
  return JSON.stringify(base) === JSON.stringify(draft) ? latest : draft;
}

function reconcileTemplateDraft(draft: TemplateDraft, latest: ResumeTemplateSummary): TemplateDraft {
  const base = draft.template.activeVersion.theme;
  const edited = draft.theme;
  const saved = latest.activeVersion.theme;
  return {
    ...draft,
    template: latest,
    displayName: keepChanged(draft.template.displayName, draft.displayName, latest.displayName),
    theme: {
      pageSize: keepChanged(base.pageSize, edited.pageSize, saved.pageSize),
      fontFamily: keepChanged(base.fontFamily, edited.fontFamily, saved.fontFamily),
      fontScale: keepChanged(base.fontScale, edited.fontScale, saved.fontScale),
      density: keepChanged(base.density, edited.density, saved.density),
      marginMm: {
        top: keepChanged(base.marginMm.top, edited.marginMm.top, saved.marginMm.top),
        right: keepChanged(base.marginMm.right, edited.marginMm.right, saved.marginMm.right),
        bottom: keepChanged(base.marginMm.bottom, edited.marginMm.bottom, saved.marginMm.bottom),
        left: keepChanged(base.marginMm.left, edited.marginMm.left, saved.marginMm.left),
      },
      headerLayout: keepChanged(base.headerLayout, edited.headerLayout, saved.headerLayout),
      sectionHeadingStyle: keepChanged(base.sectionHeadingStyle, edited.sectionHeadingStyle, saved.sectionHeadingStyle),
      alignment: keepChanged(base.alignment, edited.alignment, saved.alignment),
      bulletSpacing: keepChanged(base.bulletSpacing, edited.bulletSpacing, saved.bulletSpacing),
      accentColor: keepChanged(base.accentColor, edited.accentColor, saved.accentColor),
      sectionOrder: keepChanged(base.sectionOrder, edited.sectionOrder, saved.sectionOrder),
      hiddenSections: keepChanged(base.hiddenSections, edited.hiddenSections, saved.hiddenSections),
    },
    // Layout is not edited by this panel. Keep the current canonical layout.
    layout: { ...latest.activeVersion.layout },
    dirty: true,
  };
}

function draftKey(tenantId: string, templateId: string): string {
  return JSON.stringify([tenantId, templateId]);
}

export function ResumeTemplatePanel({ profileHtmlPreviewUrl }: ResumeTemplatePanelProps): JSX.Element {
  const tenantId = useTenantId();
  const templatesQuery = useResumeTemplatesQuery();
  const saveTemplate = useSaveResumeTemplateMutation();
  const setDefaultTemplate = useSetDefaultResumeTemplateMutation();
  const templates = templatesQuery.data?.templates ?? [];
  const fallbackTemplate = resolveEffectiveResumeTemplateSummary(templatesQuery.data);
  const [selections, setSelections] = useState<Map<string, string>>(() => new Map());
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({});
  const [accepted, setAccepted] = useState<Record<string, ResumeTemplateSummary>>({});
  const [savingTenants, setSavingTenants] = useState<Set<string>>(() => new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string | null>>({});
  const [saveDefaultErrors, setSaveDefaultErrors] = useState<Record<string, string | null>>({});
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const [reviewingTenants, setReviewingTenants] = useState<Set<string>>(() => new Set());
  const observedTemplates = useRef<Record<string, ResumeTemplateSummary>>({});
  const activeTemplateId = selections.get(tenantId) ?? null;
  const selectTemplate = (id: string) => setSelections((previous) => new Map(previous).set(tenantId, id));
  const selectedId = activeTemplateId ?? fallbackTemplate?.templateId ?? null;
  const listed = templates.find((template) => template.templateId === selectedId);
  const key = selectedId ? draftKey(tenantId, selectedId) : null;
  const acknowledged = key ? accepted[key] : undefined;
  const activeTemplate = acknowledged && (!listed || acknowledged.activeVersion.versionNumber >= listed.activeVersion.versionNumber)
    ? acknowledged
    : listed ?? (key ? drafts[key]?.template : undefined) ?? (!selectedId ? fallbackTemplate : null);
  const draft = activeTemplate ? drafts[draftKey(tenantId, activeTemplate.templateId)] : undefined;
  const displayName = draft?.displayName ?? "";
  const theme = draft?.theme ?? null;
  const layout = draft?.layout ?? {};

  useEffect(() => {
    if (!activeTemplateId && fallbackTemplate) {
      setSelections((previous) => new Map(previous).set(tenantId, fallbackTemplate.templateId));
    }
  }, [activeTemplateId, fallbackTemplate, tenantId]);

  useEffect(() => {
    if (!activeTemplate) return;
    observedTemplates.current[draftKey(tenantId, activeTemplate.templateId)] = activeTemplate;
    setDrafts((previous) => {
      const draftId = draftKey(tenantId, activeTemplate.templateId);
      const current = previous[draftId];
      if (current?.dirty) return previous;
      if (current && current.template.activeVersion.versionId === activeTemplate.activeVersion.versionId
        && current.template.displayName === activeTemplate.displayName) return previous;
      return { ...previous, [draftId]: templateDraft(activeTemplate) };
    });
  }, [activeTemplate, tenantId]);

  const previewStyle = useMemo(
    () => (theme ? resumeTemplatePreviewStyle(theme) : undefined),
    [theme],
  );
  const saveError = saveErrors[tenantId] ?? null;
  const defaultError = saveDefaultErrors[tenantId] ?? (setDefaultTemplate.error instanceof Error ? setDefaultTemplate.error.message : null);
  const selectedTemplateCanBeDefault = Boolean(activeTemplate);
  const selectedTemplateIsDefault =
    activeTemplate && templatesQuery.data?.defaultTemplate?.templateId === activeTemplate.templateId
    && templatesQuery.data.defaultTemplate.templateVersionId === activeTemplate.activeVersion.versionId;
  const isSaving = savingTenants.has(tenantId) || reviewingTenants.has(tenantId) || setDefaultTemplate.isPending;
  const needsReview = Boolean((key && conflicts[key]) || (draft?.dirty && activeTemplate && (
    draft.template.activeVersion.versionId !== activeTemplate.activeVersion.versionId
    || draft.template.displayName !== activeTemplate.displayName
  )));
  const selectableTemplates = new Map<string, ResumeTemplateSummary>(templates.map((template) => [template.templateId, template]));
  for (const [savedKey, saved] of Object.entries(accepted)) {
    if (savedKey !== draftKey(tenantId, saved.templateId)) continue;
    const listedTemplate = selectableTemplates.get(saved.templateId);
    if (!listedTemplate || saved.activeVersion.versionNumber >= listedTemplate.activeVersion.versionNumber) {
      selectableTemplates.set(saved.templateId, saved);
    }
  }
  if (activeTemplate && !selectableTemplates.has(activeTemplate.templateId)) {
    selectableTemplates.set(activeTemplate.templateId, activeTemplate);
  }
  const templateSelectItems = [...selectableTemplates.values()].map((template) => ({
    label: template.displayName,
    value: template.templateId,
  }));

  const editDraft = (change: (current: TemplateDraft) => TemplateDraft) => {
    if (!activeTemplate) return;
    setDrafts((previous) => {
      const draftId = draftKey(tenantId, activeTemplate.templateId);
      const current = previous[draftId];
      if (!current) return previous;
      return { ...previous, [draftId]: { ...change(current), dirty: true } };
    });
  };

  const updateTheme = <K extends keyof ResumeTemplateTheme>(key: K, value: ResumeTemplateTheme[K]) => {
    editDraft((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  };
  const updateMargin = (key: keyof ResumeTemplateTheme["marginMm"], value: number) => {
    editDraft((current) => ({
      ...current,
      theme: { ...current.theme, marginMm: { ...current.theme.marginMm, [key]: value } },
    }));
  };
  const saveCurrent = (makeDefault: boolean) => {
    if (!theme || !displayName.trim() || !activeTemplate || needsReview || isSaving) return;
    const sourceKey = draftKey(tenantId, activeTemplate.templateId);
    const submittedTemplate = activeTemplate;
    const editableTemplateId = activeTemplate?.builtIn ? undefined : activeTemplate?.templateId;
    setSavingTenants((previous) => new Set(previous).add(tenantId));
    setSaveErrors((previous) => ({ ...previous, [tenantId]: null }));
    setSaveDefaultErrors((previous) => ({ ...previous, [tenantId]: null }));
    void saveTemplate.mutateAsync({
      body: {
        templateId: editableTemplateId,
        expectedVersionId: editableTemplateId ? submittedTemplate.activeVersion.versionId : undefined,
        displayName: displayName.trim(),
        theme,
        layout,
      },
      makeDefault,
      maySetDefault: (saved) => {
        const observed = observedTemplates.current[sourceKey];
        return !observed || observed.activeVersion.versionId === saved.template.activeVersion.versionId
          || (observed.activeVersion.versionId === submittedTemplate.activeVersion.versionId && observed.displayName === submittedTemplate.displayName);
      },
    }).then(({ saved, defaultError: error }) => {
      const savedKey = draftKey(tenantId, saved.template.templateId);
      const defaultConflict = error?.cause instanceof JobCtrlApiError && error.cause.status === 409;
      setAccepted((previous) => ({ ...previous, [savedKey]: saved.template }));
      setDrafts((previous) => {
        const observed = observedTemplates.current[sourceKey];
        const changedWhileSaving = observed && (
          observed.activeVersion.versionId !== saved.template.activeVersion.versionId && (
            observed.activeVersion.versionId !== submittedTemplate.activeVersion.versionId
            || observed.displayName !== submittedTemplate.displayName
          )
        );
        const submittedDraft = previous[sourceKey];
        return { ...previous, [savedKey]: (changedWhileSaving || defaultConflict) && submittedDraft
          ? { ...submittedDraft, dirty: true }
          : templateDraft(saved.template) };
      });
      if (defaultConflict) setConflicts((previous) => ({ ...previous, [savedKey]: true }));
      setSelections((previous) => new Map(previous).set(tenantId, saved.template.templateId));
      if (error) setSaveDefaultErrors((previous) => ({ ...previous, [tenantId]: error.message }));
    }).catch((error: unknown) => {
      if (error instanceof JobCtrlApiError && error.status === 409) {
        setConflicts((previous) => ({ ...previous, [sourceKey]: true }));
      }
      setSaveErrors((previous) => ({ ...previous, [tenantId]: error instanceof Error ? error.message : String(error) }));
    }).finally(() => {
      setSavingTenants((previous) => { const next = new Set(previous); next.delete(tenantId); return next; });
    });
  };

  const reconcile = async (keepDraft: boolean) => {
    if (!activeTemplate || !key || isSaving) return;
    setReviewingTenants((previous) => new Set(previous).add(tenantId));
    setSaveErrors((previous) => ({ ...previous, [tenantId]: null }));
    try {
      const result = await templatesQuery.refetch();
      const latest = result.isSuccess && !result.error
        ? result.data?.templates.find((item) => item.templateId === activeTemplate.templateId)
        : undefined;
      if (!latest || (acknowledged && (latest.activeVersion.versionNumber < acknowledged.activeVersion.versionNumber
        || (latest.activeVersion.versionNumber === acknowledged.activeVersion.versionNumber
          && latest.activeVersion.versionId !== acknowledged.activeVersion.versionId)))) {
        setSaveErrors((previous) => ({ ...previous, [tenantId]: "Could not load the latest template. Your draft is retained; try again." }));
        return;
      }
      if (latest.activeVersion.versionId !== activeTemplate.activeVersion.versionId || latest.displayName !== activeTemplate.displayName) {
        setConflicts((previous) => ({ ...previous, [key]: true }));
        setSaveErrors((previous) => ({ ...previous, [tenantId]: "The template changed again. Review the latest version before continuing." }));
        return;
      }
      setDrafts((previous) => {
        const current = previous[key];
        if (!current) return previous;
        return { ...previous, [key]: keepDraft ? reconcileTemplateDraft(current, latest) : templateDraft(latest) };
      });
      setConflicts((previous) => ({ ...previous, [key]: false }));
    } catch {
      setSaveErrors((previous) => ({ ...previous, [tenantId]: "Could not load the latest template. Your draft is retained; try again." }));
    } finally {
      setReviewingTenants((previous) => { const next = new Set(previous); next.delete(tenantId); return next; });
    }
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
            disabled={!theme || isSaving || needsReview || !displayName.trim()}
            size="sm"
            type="button"
            onClick={() => saveCurrent(false)}
          >
            <IconDeviceFloppy aria-hidden="true" data-icon="inline-start" />
            {savingTenants.has(tenantId) ? "saving" : "save version"}
          </Button>
          <Button
            disabled={!theme || isSaving || needsReview || !displayName.trim()}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => saveCurrent(true)}
          >
            <IconStar aria-hidden="true" data-icon="inline-start" />
            save default
          </Button>
          <Button
            disabled={!selectedTemplateCanBeDefault || Boolean(selectedTemplateIsDefault) || isSaving || needsReview}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              if (!activeTemplate) return;
              setDefaultTemplate.mutate({
                templateId: activeTemplate.templateId,
                versionId: activeTemplate.activeVersion.versionId,
                expectedActiveVersionId: activeTemplate.activeVersion.versionId,
              }, {
                onError: (error) => {
                  if (error instanceof JobCtrlApiError && error.status === 409) {
                    setConflicts((previous) => ({ ...previous, [draftKey(tenantId, activeTemplate.templateId)]: true }));
                  }
                },
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
            disabled={!templateSelectItems.length || isSaving}
            items={templateSelectItems}
            value={activeTemplate?.templateId ?? null}
            onValueChange={(nextValue) => { if (nextValue !== null) selectTemplate(nextValue); }}
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
            onChange={(event) => {
              const value = event.target.value;
              editDraft((current) => ({ ...current, displayName: value }));
            }}
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
      {acknowledged && activeTemplate && acknowledged.activeVersion.versionId !== activeTemplate.activeVersion.versionId ? (
        <div role="group" aria-label="Saved template version">
          <p>Saved version {acknowledged.activeVersion.versionNumber} is available. The current version is {activeTemplate.activeVersion.versionNumber}.</p>
          <Button type="button" variant="outline" disabled={isSaving || needsReview} onClick={() => {
            setSaveDefaultErrors((previous) => ({ ...previous, [tenantId]: null }));
            setDefaultTemplate.reset();
            setDefaultTemplate.mutate({
              templateId: acknowledged.templateId,
              versionId: acknowledged.activeVersion.versionId,
              expectedActiveVersionId: activeTemplate.activeVersion.versionId,
            }, {
              onError: (error) => {
                if (error instanceof JobCtrlApiError && error.status === 409) {
                  setConflicts((previous) => ({ ...previous, [draftKey(tenantId, activeTemplate.templateId)]: true }));
                }
              },
            });
          }}>Set saved version {acknowledged.activeVersion.versionNumber} as default</Button>
        </div>
      ) : null}
      {needsReview && activeTemplate ? (
        <div role="group" aria-label="Review changed template">
          <p role="status">This template changed while you were editing. Your draft is retained; review the latest version before saving.</p>
          <details>
            <summary>Latest saved template settings</summary>
            <p>{activeTemplate.displayName} · Version {activeTemplate.activeVersion.versionNumber}</p>
            <p>Font: {activeTemplate.activeVersion.theme.fontFamily} · Scale: {activeTemplate.activeVersion.theme.fontScale} · Density: {activeTemplate.activeVersion.theme.density}</p>
            <p>Header: {activeTemplate.activeVersion.theme.headerLayout} · Headings: {activeTemplate.activeVersion.theme.sectionHeadingStyle} · Alignment: {activeTemplate.activeVersion.theme.alignment} · Bullet spacing: {activeTemplate.activeVersion.theme.bulletSpacing}</p>
            <p>Accent: {activeTemplate.activeVersion.theme.accentColor} · Margins: {Object.values(activeTemplate.activeVersion.theme.marginMm).join(" / ")} mm</p>
          </details>
          <p>Keeping your draft applies your changed settings over the latest version. If both versions changed a setting, your draft value is used.</p>
          <Button type="button" variant="outline" disabled={isSaving} onClick={() => void reconcile(true)}>Keep draft and review latest version</Button>
          <Button type="button" variant="outline" disabled={isSaving} onClick={() => void reconcile(false)}>Discard draft and load latest version</Button>
        </div>
      ) : null}
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
          pdfFilename="resume-template-preview.pdf"
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

export function resolveEffectiveResumeTemplateSummary(
  response: ResumeTemplateListResponse | undefined,
): ResumeTemplateSummary | null {
  const templates = response?.templates ?? [];
  return (
    templateByMetadata(templates, response?.defaultTemplate) ??
    templateByMetadata(templates, response?.builtInDefault) ??
    templates[0] ??
    null
  );
}

export function resolveEffectiveResumeTemplateVersion(
  response: ResumeTemplateListResponse | undefined,
): ResumeTemplateVersionSummary | null {
  return response?.effectiveDefaultVersion ?? resolveEffectiveResumeTemplateSummary(response)?.activeVersion ?? null;
}

export function resumeTemplatePreviewStyle(theme: ResumeTemplateTheme): TemplatePreviewStyle {
  const density = DENSITY_TOKENS[theme.density];
  const scaledBodyFontSize = `${Number((10.35 * theme.fontScale).toFixed(3))}pt`;
  const headerTextAlign = theme.headerLayout === "centered" ? "center" : "left";
  const headerJustify = theme.headerLayout === "centered" ? "center" : "flex-start";
  const bodyAlign = theme.alignment === "justified" ? "justify" : "left";
  const pageInlineSize = theme.pageSize === "letter" ? "8.5in" : "210mm";
  const pageBlockSize = theme.pageSize === "letter" ? "11in" : "297mm";
  const headingRuleBorder = theme.sectionHeadingStyle === "rule" ? `0.45pt solid ${theme.accentColor}` : "none";
  const headingBoxBorder = theme.sectionHeadingStyle === "boxed" ? `0.45pt solid ${theme.accentColor}` : "0";
  return {
    "--resume-template-font-family": FONT_STACKS[theme.fontFamily],
    "--resume-template-body-font-size": scaledBodyFontSize,
    "--resume-template-contact-font-size": "8.8pt",
    "--resume-template-entry-meta-font-size": "8.9pt",
    "--resume-template-heading-font-size": "9.5pt",
    "--resume-template-name-font-size": "22pt",
    "--resume-template-accent": theme.accentColor,
    "--resume-template-page-padding": `${theme.marginMm.top}mm ${theme.marginMm.right}mm ${theme.marginMm.bottom}mm ${theme.marginMm.left}mm`,
    "--resume-template-page-inline-size": pageInlineSize,
    "--resume-template-page-block-size": pageBlockSize,
    "--resume-template-header-justify": headerJustify,
    "--resume-template-header-text-align": headerTextAlign,
    "--resume-template-body-align": bodyAlign,
    "--resume-template-heading-rule-border": headingRuleBorder,
    "--resume-template-heading-box-border": headingBoxBorder,
    "--resume-template-heading-padding": theme.sectionHeadingStyle === "boxed" ? "0.8mm 1.2mm" : "0",
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
