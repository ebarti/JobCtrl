import { SEMANTIC_TAXONOMY } from "@jobctrl/contracts";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconSortDescending,
  IconTrash,
} from "@tabler/icons-react";

import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import {
  AdaptiveFieldGrid,
  AdaptiveFieldSpan,
} from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  DisclosureSection,
  type DisclosureSectionProps,
} from "../../../shared/ui/disclosure-section.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { AchievementWordings } from "./WordingLibrary.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Separator } from "../../../shared/ui/separator.js";
import { Textarea } from "../../../shared/ui/textarea.js";

import {
  GoogleAddressSearchField,
  isUnitedStatesAddressCountry,
  type GoogleAddressSelection,
} from "./GoogleAddressSearchField.js";
import {
  asTextArray,
  defaultRepeatItem,
  editableTextArrayAt,
  getPathValue,
  type JsonRecord,
  lines,
  numberOrEmpty,
  recordArrayAt,
  recordAt,
  setPathValue,
  textArrayAt,
  textAt,
  textFrom,
} from "../lib/json-record.js";
import {
  compareProfileDateRangesNewestFirst,
  emptyProfileMonth,
  formatProfileDateRange,
  formatProfileMonth,
  isProfileDateRangeChronological,
  parseProfileDateRange,
  parseProfileMonth,
  PROFILE_MONTHS,
  profileYearOptions,
  type ProfileMonthValue,
} from "../lib/profile-date-fields.js";

interface TargetSearchOption {
  value: string;
  label: string;
}

interface TargetSearchOptionGroup {
  label: string;
  options: readonly TargetSearchOption[];
}

const TARGET_TRACK_GROUPS: readonly TargetSearchOptionGroup[] = [
  {
    label: "Track",
    options: Object.entries(SEMANTIC_TAXONOMY.track).map(([value, label]) => ({
      value,
      label,
    })),
  },
];

const TARGET_SENIORITY_GROUPS: readonly TargetSearchOptionGroup[] = [
  {
    label: "Seniority",
    options: Object.entries(SEMANTIC_TAXONOMY.seniority).map(
      ([value, label]) => ({ value, label }),
    ),
  },
];

const ROLE_AREA_LABEL = "Role areas";
const ROLE_AREA_PLACEHOLDER = "Engineering, security, platform";
const TARGET_LOCATION_LABEL = "Locations and work models";
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "";

type StructuredInputAttributes = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  helperText?: ReactNode;
  valueKind?: "text";
};

type StructuredTextareaAttributes = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "placeholder" | "value"
>;

function editorControlId(
  scope: "profile" | "style",
  path: string,
  suffix = "",
) {
  const normalizedPath = path
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  return `structured-${scope}-${normalizedPath}${suffix ? `-${suffix}` : ""}`;
}

export type ProfileActiveSection =
  "experience" | "skills" | "education" | "personal" | "resume";

/** Peer Profile content remains mounted, without a whole-section disclosure. */
function ProfileSection({
  children,
  title,
  description,
  actions,
  id,
  className,
  hidden,
}: DisclosureSectionProps & { hidden?: boolean }) {
  return (
    <section
      className={`form-section profile-peer-section ${className ?? ""}`}
      id={id}
      hidden={hidden}
    >
      <div className="profile-peer-section__header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{description}</p>
        </div>
        {actions}
      </div>
      <fieldset disabled={hidden} className="profile-editing-boundary">
        {children}
      </fieldset>
    </section>
  );
}

function AchievementSource({
  initiallyEmpty,
  children,
}: {
  initiallyEmpty: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyEmpty);
  return (
    <details
      className="profile-achievement-source"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Achievement source and facts</summary>
      <p className="muted">
        Keep the factual record here. Use Propose revision to change its wording
        while retaining the source and earlier approvals.
      </p>
      {children}
    </details>
  );
}

export interface StructuredProfileEditorProps {
  activeSection?: ProfileActiveSection;
  roleId?: string;
  achievementId?: string;
  achievementContent?: (achievementId: string, roleId: string) => ReactNode;
  achievementWordings?: (achievementId: string, roleId: string) => ReactNode;
  applicationConfigurationFields?: ReactNode;
  mode?: "profile" | "preferences" | "target-search";
  showSectionHeading?: boolean;
  profile: JsonRecord | null;
  style: JsonRecord | null;
  onProfileChange: (value: JsonRecord) => void;
  onStyleChange: (value: JsonRecord) => void;
}

function TargetPreferenceCard({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id: string;
  title: string;
}) {
  return (
    <Card
      aria-labelledby={id}
      className="target-preference-cluster"
      role="region"
      size="sm"
    >
      <CardHeader>
        <CardTitle id={id}>{title}</CardTitle>
      </CardHeader>
      <CardContent className="target-preference-cluster__content">
        {children}
      </CardContent>
    </Card>
  );
}

export function StructuredProfileEditor({
  applicationConfigurationFields,
  activeSection = "experience",
  roleId,
  achievementId,
  achievementContent,
  achievementWordings,
  mode = "profile",
  showSectionHeading = true,
  profile,
  style,
  onProfileChange,
  onStyleChange,
}: StructuredProfileEditorProps) {
  const { requestIdentity, storage } = usePorts();
  const tenantId = useTenantId();
  const roleSelectionKey = `profile-selected-role:v1:${tenantId}`;
  const [selectedRoleId, setSelectedRoleId] = useState(() => {
    try {
      return roleId ?? storage.get<string>(roleSelectionKey) ?? "";
    } catch {
      return roleId ?? "";
    }
  });
  useEffect(() => {
    if (roleId) setSelectedRoleId(roleId);
  }, [roleId]);
  const selectRole = (id: string) => {
    setSelectedRoleId(id);
    try {
      storage.set(roleSelectionKey, id);
    } catch {
      /* Editing remains available without selection persistence. */
    }
  };
  const [identityError, setIdentityError] = useState("");
  const focusTargetsRef = useRef(new Map<string, HTMLElement>());
  const achievementTargetsRef = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (achievementId && activeSection === "experience") {
      const target = achievementTargetsRef.current.get(achievementId);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "center" });
    }
  }, [achievementId, activeSection, selectedRoleId]);
  const pendingFocusKeyRef = useRef<string | null>(null);
  const reservedRepeatIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const focusKey = pendingFocusKeyRef.current;
    if (!focusKey) {
      return;
    }
    const element = focusTargetsRef.current.get(focusKey);
    if (!element) {
      return;
    }
    pendingFocusKeyRef.current = null;
    element.focus();
    if (element instanceof HTMLInputElement) {
      element.select();
    }
  }, [profile]);

  const registerFocusTarget =
    (key: string) => (element: HTMLElement | null) => {
      if (element) {
        focusTargetsRef.current.set(key, element);
      } else {
        focusTargetsRef.current.delete(key);
      }
    };

  const focusAfterDraftUpdate = (key: string) => {
    pendingFocusKeyRef.current = key;
  };

  if (!profile || !style) {
    return (
      <Alert className="banner inline">
        <AlertDescription>
          The structured editor needs valid profile data. Reload the profile
          after fixing the saved data.
        </AlertDescription>
      </Alert>
    );
  }

  const updateProfileDraft = (updater: (draft: JsonRecord) => void) => {
    const draft = structuredClone(profile);
    updater(draft);
    onProfileChange(draft);
  };

  const updateProfilePath = (path: string, value: unknown) => {
    updateProfileDraft((draft) => setPathValue(draft, path, value));
  };

  const updateStylePath = (path: string, value: unknown) => {
    const draft = structuredClone(style);
    setPathValue(draft, path, value);
    onStyleChange(draft);
  };

  const setRequiredBullet = (
    entryId: string,
    bullet: string,
    checked: boolean,
  ) => {
    if (!entryId || !bullet) {
      return;
    }
    updateProfileDraft((draft) => {
      const mapPath =
        "resume.tailoring_rules.required_bullets_by_experience_id";
      const existing = recordAt(draft, mapPath);
      const values = new Set(asTextArray(existing[entryId]));
      if (checked) {
        values.add(bullet);
      } else {
        values.delete(bullet);
      }
      setPathValue(draft, mapPath, {
        ...existing,
        [entryId]: Array.from(values),
      });
    });
  };

  const addRepeatItem = (path: string) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      // Identity is structural and allocated once, never derived from labels.
      // Keep removed draft IDs reserved and avoid imported/required identities.
      for (const entryPath of [
        "resume.experience_entries",
        "resume.education_entries",
        "resume.skill_categories",
      ]) {
        for (const entry of recordArrayAt(draft, entryPath)) {
          reservedRepeatIdsRef.current.add(textFrom(entry["id"]));
        }
      }
      for (const requiredPath of [
        "resume.tailoring_rules.required_experience_entry_ids",
        "resume.tailoring_rules.required_education_entry_ids",
        "resume.tailoring_rules.required_skill_category_ids",
      ]) {
        for (const id of textArrayAt(draft, requiredPath)) {
          reservedRepeatIdsRef.current.add(id);
        }
      }
      for (const requiredMapPath of [
        "resume.tailoring_rules.required_bullets_by_experience_id",
        "resume.tailoring_rules.required_skills_by_category_id",
      ]) {
        for (const id of Object.keys(recordAt(draft, requiredMapPath))) {
          reservedRepeatIdsRef.current.add(id);
        }
      }
      const item = defaultRepeatItem(path, reservedRepeatIdsRef.current);
      // New identities never recycle a removed record after remount/reload.
      // Retained/imported IDs keep their existing value.
      item["id"] = requestIdentity.create();
      if (path === "resume.experience_entries") {
        item["bullets"] = [];
        item["achievement_ids"] = [];
      }
      const id = textFrom(item["id"]);
      if (id) reservedRepeatIdsRef.current.add(id);
      if (path === "resume.experience_entries" && id) selectRole(id);
      setPathValue(draft, path, [...items, item]);
    });
  };

  const removeRepeatItem = (path: string, index: number) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      const removedId = textFrom(items[index]?.["id"]);
      setPathValue(
        draft,
        path,
        items.filter((_, itemIndex) => itemIndex !== index),
      );
      if (path === "resume.experience_entries" && removedId) {
        const requiredPath =
          "resume.tailoring_rules.required_experience_entry_ids";
        setPathValue(
          draft,
          requiredPath,
          textArrayAt(draft, requiredPath).filter((id) => id !== removedId),
        );
        const bulletPath =
          "resume.tailoring_rules.required_bullets_by_experience_id";
        const requiredBullets = { ...recordAt(draft, bulletPath) };
        delete requiredBullets[removedId];
        setPathValue(draft, bulletPath, requiredBullets);
      }
    });
  };

  const moveExperienceEntry = (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= experienceEntries.length) {
      return;
    }
    updateProfileDraft((draft) => {
      const path = "resume.experience_entries";
      const items = recordArrayAt(draft, path);
      const next = [...items];
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      setPathValue(draft, path, next);
    });
  };

  const sortExperienceEntriesNewestFirst = () => {
    const ordered = experienceEntries
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          compareProfileDateRangesNewestFirst(
            textFrom(left.entry["date_range"]),
            textFrom(right.entry["date_range"]),
          ) || left.index - right.index,
      )
      .map(({ entry }) => entry);
    if (ordered.every((entry, index) => entry === experienceEntries[index])) {
      return;
    }
    updateProfileDraft((draft) =>
      setPathValue(draft, "resume.experience_entries", ordered),
    );
  };

  const addBullet = (entryIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      const idsPath = `resume.experience_entries.${entryIndex}.achievement_ids`;
      const bullets = editableTextArrayAt(draft, path);
      const ids = getPathValue(draft, idsPath);
      if (
        !Array.isArray(ids) ||
        ids.length !== bullets.length ||
        ids.some((id) => typeof id !== "string" || !id)
      ) {
        setIdentityError(
          "Achievement identities are unavailable. Reload the saved Profile before changing bullet structure.",
        );
        return;
      }
      setIdentityError("");
      focusAfterDraftUpdate(bulletFocusKey(entryIndex, bullets.length, "text"));
      setPathValue(draft, path, [...bullets, ""]);
      setPathValue(draft, idsPath, [...ids, requestIdentity.create()]);
    });
  };

  const bulletFocusKey = (
    entryIndex: number,
    bulletIndex: number,
    control: "up" | "down" | "text",
  ) => JSON.stringify(["bullet", entryIndex, bulletIndex, control]);

  const moveBullet = (
    entryIndex: number,
    bulletIndex: number,
    offset: -1 | 1,
  ) => {
    const path = `resume.experience_entries.${entryIndex}.bullets`;
    const bullets = editableTextArrayAt(profile, path);
    const idsPath = `resume.experience_entries.${entryIndex}.achievement_ids`;
    const ids = getPathValue(profile, idsPath);
    if (
      !Array.isArray(ids) ||
      ids.length !== bullets.length ||
      ids.some((id) => typeof id !== "string" || !id)
    ) {
      setIdentityError(
        "Achievement identities are unavailable. Reload the saved Profile before changing bullet structure.",
      );
      return;
    }
    const targetIndex = bulletIndex + offset;
    if (targetIndex < 0 || targetIndex >= bullets.length) {
      return;
    }
    const reachedEnd =
      offset === -1 ? targetIndex === 0 : targetIndex === bullets.length - 1;
    focusAfterDraftUpdate(
      bulletFocusKey(
        entryIndex,
        targetIndex,
        reachedEnd ? "text" : offset === -1 ? "up" : "down",
      ),
    );
    [bullets[bulletIndex], bullets[targetIndex]] = [
      bullets[targetIndex]!,
      bullets[bulletIndex]!,
    ];
    const nextIds = [...ids];
    [nextIds[bulletIndex], nextIds[targetIndex]] = [
      nextIds[targetIndex]!,
      nextIds[bulletIndex]!,
    ];
    setIdentityError("");
    updateProfileDraft((draft) => {
      setPathValue(draft, path, bullets);
      setPathValue(draft, idsPath, nextIds);
    });
  };

  const removeBullet = (entryIndex: number, bulletIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      const idsPath = `resume.experience_entries.${entryIndex}.achievement_ids`;
      const bullets = editableTextArrayAt(draft, path);
      const ids = getPathValue(draft, idsPath);
      if (
        !Array.isArray(ids) ||
        ids.length !== bullets.length ||
        ids.some((id) => typeof id !== "string" || !id)
      ) {
        setIdentityError(
          "Achievement identities are unavailable. Reload the saved Profile before changing bullet structure.",
        );
        return;
      }
      setIdentityError("");
      setPathValue(
        draft,
        path,
        bullets.filter((_, index) => index !== bulletIndex),
      );
      setPathValue(
        draft,
        idsPath,
        ids.filter((_, index) => index !== bulletIndex),
      );
    });
  };

  const addSkill = (categoryIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.skill_categories.${categoryIndex}.items`;
      setPathValue(draft, path, [...editableTextArrayAt(draft, path), ""]);
    });
  };

  const removeSkill = (categoryIndex: number, skillIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.skill_categories.${categoryIndex}.items`;
      setPathValue(
        draft,
        path,
        editableTextArrayAt(draft, path).filter(
          (_, index) => index !== skillIndex,
        ),
      );
    });
  };

  const textField = (
    path: string,
    label: string,
    type: InputHTMLAttributes<HTMLInputElement>["type"] = "text",
    attrs: StructuredInputAttributes = {},
  ) => {
    const { helperText, valueKind, ...inputAttrs } = attrs;
    const id = inputAttrs.id ?? editorControlId("profile", path);
    const descriptionId = helperText ? `${id}-description` : undefined;
    const describedBy =
      [inputAttrs["aria-describedby"], descriptionId]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          {...inputAttrs}
          aria-describedby={describedBy}
          id={id}
          type={type}
          value={textAt(profile, path)}
          onChange={(event) =>
            updateProfilePath(
              path,
              type === "number"
                ? constrainedNumberOrEmpty(
                    event.target.value,
                    attrs,
                    valueKind === "text",
                  )
                : event.target.value,
            )
          }
        />
        {helperText ? (
          <FieldDescription id={descriptionId}>{helperText}</FieldDescription>
        ) : null}
      </Field>
    );
  };

  const addressSearchField = () => {
    const applyAddressSelection = (selection: GoogleAddressSelection) => {
      updateProfileDraft((draft) => {
        setPathValue(draft, "personal.address", selection.address);
        setPathValue(draft, "personal.city", selection.city);
        setPathValue(draft, "personal.province_state", selection.provinceState);
        setPathValue(draft, "personal.country", selection.country);
        setPathValue(draft, "personal.postal_code", selection.postalCode);
      });
    };

    return (
      <GoogleAddressSearchField
        apiKey={GOOGLE_MAPS_API_KEY}
        value={textAt(profile, "personal.address")}
        onAddressChange={(value) =>
          updateProfilePath("personal.address", value)
        }
        onAddressSelect={applyAddressSelection}
      />
    );
  };

  const constrainedNumberOrEmpty = (
    value: string,
    attrs: Pick<InputHTMLAttributes<HTMLInputElement>, "max" | "min">,
    keepText = false,
  ) => {
    const parsed = numberOrEmpty(value);
    if (parsed === "" || typeof parsed !== "number") {
      return parsed;
    }
    if (!Number.isFinite(parsed)) {
      return "";
    }
    const min = typeof attrs["min"] === "number" ? attrs["min"] : undefined;
    const max = typeof attrs["max"] === "number" ? attrs["max"] : undefined;
    const constrained = Math.min(
      max ?? parsed,
      Math.max(min ?? parsed, parsed),
    );
    return keepText ? String(constrained) : constrained;
  };

  const years = profileYearOptions();

  const monthSelector = (
    label: string,
    value: ProfileMonthValue,
    onChange: (value: ProfileMonthValue) => void,
    disabled = false,
    controlPrefix = label,
  ) => {
    const emptyMonthValue = "__empty-month__";
    const emptyYearValue = "__empty-year__";
    const monthItems = [
      { label: "Month", value: emptyMonthValue },
      ...PROFILE_MONTHS.map((month) => ({
        label: month.label,
        value: month.value,
      })),
    ];
    const yearItems = [
      { label: "Year", value: emptyYearValue },
      ...years.map((year) => ({ label: year, value: year })),
    ];
    return (
      <FieldSet className="month-selector">
        <FieldLegend variant="label">{label}</FieldLegend>
        <div className="month-selector-controls">
          <Select
            disabled={disabled}
            items={monthItems}
            value={value.month || emptyMonthValue}
            onValueChange={(month) =>
              onChange({
                ...value,
                month: month === null || month === emptyMonthValue ? "" : month,
              })
            }
          >
            <SelectTrigger
              aria-label={`${controlPrefix} month`}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {monthItems.map((month) => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            disabled={disabled}
            items={yearItems}
            value={value.year || emptyYearValue}
            onValueChange={(year) =>
              onChange({
                ...value,
                year: year === null || year === emptyYearValue ? "" : year,
              })
            }
          >
            <SelectTrigger
              aria-label={`${controlPrefix} year`}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {yearItems.map((year) => (
                  <SelectItem key={year.value} value={year.value}>
                    {year.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </FieldSet>
    );
  };

  const monthField = (path: string, label: string, controlPrefix = label) => {
    const value = parseProfileMonth(textAt(profile, path));
    return (
      <Field className="field month-field">
        <div className="month-field-body">
          {monthSelector(
            label,
            value,
            (next) => updateProfilePath(path, formatProfileMonth(next)),
            false,
            controlPrefix,
          )}
          <Button
            disabled={!value.month && !value.year}
            onClick={() => updateProfilePath(path, "")}
            size="sm"
            type="button"
            variant="outline"
          >
            Clear
          </Button>
        </div>
      </Field>
    );
  };

  const dateRangeField = (path: string, label: string) => {
    const value = parseProfileDateRange(textAt(profile, path));
    const hasError = !isProfileDateRangeChronological(value);
    const updateDateRange = (next: Partial<typeof value>) => {
      updateProfilePath(path, formatProfileDateRange({ ...value, ...next }));
    };
    const presentId = editorControlId("profile", path, "present");
    return (
      <Field
        className="field date-range-field wide"
        data-invalid={hasError || undefined}
      >
        <FieldTitle>{label}</FieldTitle>
        <div className={`date-range-body${hasError ? " invalid" : ""}`}>
          {monthSelector("Start", value.start, (start) =>
            updateDateRange({ start }),
          )}
          {value.present
            ? null
            : monthSelector("End", value.end, (end) =>
                updateDateRange({ end, present: false }),
              )}
          <Field className="choice date-range-present" orientation="horizontal">
            <Checkbox
              id={presentId}
              checked={value.present}
              onCheckedChange={(checked) =>
                updateDateRange({
                  end: checked ? emptyProfileMonth() : value.end,
                  present: checked,
                })
              }
            />
            <FieldLabel htmlFor={presentId}>Present</FieldLabel>
          </Field>
          <Button
            disabled={
              !value.start.month &&
              !value.start.year &&
              !value.end.month &&
              !value.end.year &&
              !value.present
            }
            onClick={() => updateProfilePath(path, "")}
            size="sm"
            type="button"
            variant="outline"
          >
            Clear
          </Button>
        </div>
        {hasError ? (
          <FieldError>End date must be after start date.</FieldError>
        ) : null}
      </Field>
    );
  };

  const selectField = (
    path: string,
    label: string,
    options: Array<[string, string]> | string[],
  ) => {
    const id = editorControlId("profile", path);
    const items = options.map((option) => ({
      label: Array.isArray(option) ? option[1] : option,
      value: Array.isArray(option) ? option[0] : option,
    }));
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select
          items={items}
          value={textAt(profile, path)}
          onValueChange={(value) => updateProfilePath(path, value)}
        >
          <SelectTrigger id={id} aria-label={label} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    );
  };

  const checkboxField = (path: string, label: string) => {
    const id = editorControlId("profile", path);
    return (
      <Field className="field check" orientation="horizontal">
        <Checkbox
          id={id}
          checked={Boolean(getPathValue(profile, path))}
          onCheckedChange={(checked) => updateProfilePath(path, checked)}
        />
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </Field>
    );
  };

  const yesNoCheckboxField = (path: string, label: string) => {
    const id = editorControlId("profile", path);
    const descriptionId = `${id}-description`;
    const answer = textAt(profile, path);
    const isUnanswered = answer === "";
    return (
      <Field className="field check" orientation="horizontal">
        <Checkbox
          aria-describedby={descriptionId}
          id={id}
          checked={answer === "Yes"}
          indeterminate={isUnanswered}
          onCheckedChange={(checked) =>
            updateProfilePath(path, checked ? "Yes" : "No")
          }
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription id={descriptionId} aria-live="polite">
            {isUnanswered ? "Not answered" : `Selected: ${answer}`}
          </FieldDescription>
        </FieldContent>
      </Field>
    );
  };

  const numberField = (
    path: string,
    label: string,
    attrs: { min: number; max: number; step: number; defaultValue: number },
  ) => {
    const value = getPathValue(profile, path);
    const displayedValue =
      value === undefined || value === null || value === ""
        ? attrs.defaultValue
        : value;
    const id = editorControlId("profile", path);
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="number"
          min={attrs.min}
          max={attrs.max}
          step={attrs.step}
          value={textFrom(displayedValue)}
          onChange={(event) => {
            const parsed = constrainedNumberOrEmpty(event.target.value, attrs);
            updateProfilePath(
              path,
              typeof parsed === "number" ? Math.round(parsed) : parsed,
            );
          }}
        />
      </Field>
    );
  };

  const percentField = (
    path: string,
    label: string,
    attrs: { min: number; max: number; step: number; defaultValue: number },
  ) => {
    const rawValue = getPathValue(profile, path);
    const ratioValue =
      rawValue === undefined || rawValue === null || rawValue === ""
        ? attrs.defaultValue
        : Number(rawValue);
    const percentValue = Number.isFinite(ratioValue)
      ? Math.round(ratioValue * 100)
      : Math.round(attrs.defaultValue * 100);
    const id = editorControlId("profile", path);
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="number"
          min={attrs.min}
          max={attrs.max}
          step={attrs.step}
          value={textFrom(percentValue)}
          onChange={(event) => {
            const parsed = constrainedNumberOrEmpty(event.target.value, attrs);
            updateProfilePath(
              path,
              typeof parsed === "number" ? Math.round(parsed) / 100 : parsed,
            );
          }}
        />
      </Field>
    );
  };

  const disabledCheckboxField = (label: string, reason: string) => {
    const id = editorControlId("profile", label, "disabled");
    const descriptionId = `${id}-description`;
    return (
      <Field
        className="field check disabled locked-choice"
        data-disabled
        orientation="horizontal"
      >
        <Checkbox
          aria-describedby={descriptionId}
          id={id}
          checked={false}
          disabled
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription id={descriptionId}>{reason}</FieldDescription>
        </FieldContent>
      </Field>
    );
  };

  const textareaField = (
    path: string,
    label: string,
    placeholder = "",
    attrs: StructuredTextareaAttributes = {},
  ) => {
    const id = attrs.id ?? editorControlId("profile", path);
    return (
      <Field className="field wide">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Textarea
          {...attrs}
          id={id}
          placeholder={placeholder}
          value={textAt(profile, path)}
          onChange={(event) => updateProfilePath(path, event.target.value)}
        />
      </Field>
    );
  };

  const listField = (path: string, label: string) => {
    const id = editorControlId("profile", path);
    return (
      <Field className="field wide">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Textarea
          id={id}
          value={textArrayAt(profile, path).join("\n")}
          onChange={(event) =>
            updateProfilePath(path, lines(event.target.value))
          }
        />
      </Field>
    );
  };

  const delimitedListField = (
    path: string,
    label: string,
    addLabel: string,
    options: {
      compact?: boolean;
      hideTitle?: boolean;
      placeholder?: string;
    } = {},
  ) => {
    const values = delimitedListAt(textAt(profile, path));
    const focusKey = (index: number) => `${path}:${index}`;
    const updateValues = (next: string[]) => {
      updateProfilePath(path, next.join("; "));
    };
    const insertValueAfter = (index: number, currentValue: string) => {
      const insertionIndex = index + 1;
      const next = [...values];
      next[index] = currentValue;
      next.splice(insertionIndex, 0, "");
      focusAfterDraftUpdate(focusKey(insertionIndex));
      updateValues(next);
    };
    const appendValue = () => {
      focusAfterDraftUpdate(focusKey(values.length));
      updateValues([...values, ""]);
    };
    return (
      <Field className="field wide inline-list-field">
        <FieldTitle className={options.hideTitle ? "sr-only" : undefined}>
          {label}
        </FieldTitle>
        <div className={`inline-list${options.compact ? " compact" : ""}`}>
          {values.map((value, index) => (
            <div className="inline-list-row" key={`${path}-${index}`}>
              <Input
                aria-label={`${label} ${index + 1}`}
                placeholder={options.placeholder}
                ref={registerFocusTarget(focusKey(index))}
                value={value}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  updateProfilePath(path, next.join("; "));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  insertValueAfter(index, event.currentTarget.value);
                }}
              />
              <Button
                className="icon-button"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                size="icon"
                title="Remove"
                type="button"
                variant="ghost"
                onClick={() =>
                  updateValues(
                    values.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <IconTrash size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            className="add-bullet"
            onClick={appendValue}
            size="sm"
            type="button"
            variant="secondary"
          >
            <IconPlus size={14} aria-hidden="true" />
            {addLabel}
          </Button>
        </div>
      </Field>
    );
  };

  const targetSearchCheckboxGroup = (
    path: string,
    label: string,
    groups: readonly TargetSearchOptionGroup[],
    presentation: { hideLegend?: boolean } = {},
  ) => {
    const options = groups.flatMap((group) => group.options);
    const values = delimitedListAt(textAt(profile, path))
      .map((value) => value.trim())
      .filter(Boolean);
    const selected = new Set(
      values
        .map((value) => normalizeTargetSearchOption(value, options))
        .filter((value): value is string => Boolean(value)),
    );
    const customValues = values.filter(
      (value) => !normalizeTargetSearchOption(value, options),
    );
    const updateSelection = (optionValue: string, checked: boolean) => {
      const next = new Set(selected);
      if (checked) {
        next.add(optionValue);
      } else {
        next.delete(optionValue);
      }
      const orderedKnownValues = options
        .map((option) => option.value)
        .filter((value) => next.has(value));
      updateProfilePath(
        path,
        [...orderedKnownValues, ...customValues].join("; "),
      );
    };
    const removeCustomValue = (customValue: string) => {
      const orderedKnownValues = options
        .map((option) => option.value)
        .filter((value) => selected.has(value));
      updateProfilePath(
        path,
        [
          ...orderedKnownValues,
          ...customValues.filter((value) => value !== customValue),
        ].join("; "),
      );
    };

    return (
      <FieldSet className="field wide checkbox-group-field">
        <FieldLegend
          className={presentation.hideLegend ? "sr-only" : undefined}
        >
          {label}
        </FieldLegend>
        <FieldGroup className="checkbox-group-list">
          {groups.map((group) => {
            const optionFields = (
              <FieldGroup className="checkbox-options">
                {group.options.map((option) => (
                  <Field
                    className="choice target-choice"
                    key={`${path}-${option.value}`}
                    orientation="horizontal"
                  >
                    <Checkbox
                      id={editorControlId("profile", path, option.value)}
                      checked={selected.has(option.value)}
                      onCheckedChange={(checked) =>
                        updateSelection(option.value, checked)
                      }
                    />
                    <FieldLabel
                      htmlFor={editorControlId("profile", path, option.value)}
                    >
                      {option.label}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            );
            return group.label ? (
              <FieldSet
                className="checkbox-option-group"
                key={`${path}-${group.label}`}
              >
                <FieldLegend className="checkbox-group-label" variant="label">
                  {group.label}
                </FieldLegend>
                {optionFields}
              </FieldSet>
            ) : (
              <FieldGroup
                className="checkbox-option-group ungrouped"
                key={`${path}-ungrouped`}
              >
                {optionFields}
              </FieldGroup>
            );
          })}
          {customValues.length > 0 ? (
            <div className="unsupported-target-values">
              <span>Unsupported saved values</span>
              <div className="unsupported-target-value-list">
                {customValues.map((value) => (
                  <Button
                    key={`${path}-${value}`}
                    onClick={() => removeCustomValue(value)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <IconTrash size={14} aria-hidden="true" />
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </FieldGroup>
      </FieldSet>
    );
  };

  const targetLocationWorkModelField = (
    options: { hideTitle?: boolean } = {},
  ) => {
    const locationPath = "experience.target_locations";
    const workModelPath = "experience.target_work_models";
    const locations = delimitedListAt(textAt(profile, locationPath));
    const workModels = delimitedListAt(textAt(profile, workModelPath));
    const rowCount = Math.max(locations.length, workModels.length, 1);
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      location: locations[index] ?? "",
      workModel: workModels[index] ?? "",
    }));
    const locationFocusKey = (index: number) =>
      `${locationPath}:location:${index}`;
    const workModelOptions = Object.entries(SEMANTIC_TAXONOMY.workModel).filter(
      ([code]) => code !== "unknown",
    );

    const updateRows = (
      nextRows: Array<{ location: string; workModel: string }>,
    ) => {
      updateProfileDraft((draft) => {
        setPathValue(
          draft,
          locationPath,
          nextRows.map((row) => row.location).join("; "),
        );
        setPathValue(
          draft,
          workModelPath,
          nextRows.map((row) => row.workModel).join("; "),
        );
      });
    };
    const emptyRow = { location: "", workModel: "" };
    const insertRowAfter = (
      index: number,
      rowPatch: Partial<{ location: string; workModel: string }>,
    ) => {
      const insertionIndex = index + 1;
      const next = [...rows];
      next[index] = { ...(next[index] ?? emptyRow), ...rowPatch };
      next.splice(insertionIndex, 0, emptyRow);
      focusAfterDraftUpdate(locationFocusKey(insertionIndex));
      updateRows(next);
    };
    const appendRow = () => {
      focusAfterDraftUpdate(locationFocusKey(rows.length));
      updateRows([...rows, { location: "", workModel: "" }]);
    };
    const toggleWorkModel = (
      index: number,
      value: string,
      label: string,
      checked: boolean,
    ) => {
      const selected = new Set(commaListAt(rows[index]?.workModel ?? ""));
      selected.delete(value);
      selected.delete(label);
      if (checked) {
        selected.add(value);
      }
      const next = [...rows];
      next[index] = {
        ...(next[index] ?? emptyRow),
        workModel: Array.from(selected).join(", "),
      };
      updateRows(next);
    };

    return (
      <Field className="field wide target-location-model-field">
        <FieldTitle className={options.hideTitle ? "sr-only" : undefined}>
          {TARGET_LOCATION_LABEL}
        </FieldTitle>
        <div className="target-location-model-list">
          {rows.map((row, index) => (
            <div
              className="target-location-model-row"
              key={`${locationPath}-${index}`}
            >
              <Input
                aria-label={`Target location ${index + 1}`}
                ref={registerFocusTarget(locationFocusKey(index))}
                value={row.location}
                placeholder="Location"
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = { ...row, location: event.target.value };
                  updateRows(next);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  insertRowAfter(index, {
                    location: event.currentTarget.value,
                  });
                }}
              />
              <FieldSet className="target-work-model-group">
                <FieldLegend className="sr-only">
                  Target work model {index + 1}
                </FieldLegend>
                <FieldGroup className="target-work-model-options">
                  {[
                    ...workModelOptions,
                    ...Array.from(new Set(commaListAt(row.workModel)))
                      .filter(
                        (value) =>
                          !workModelOptions.some(
                            ([code, label]) =>
                              code === value || label === value,
                          ),
                      )
                      .map((value) => [value, value] as const),
                  ].map(([value, label], optionIndex) => {
                    const checkboxId = `target-work-model-${index}-${optionIndex}`;
                    return (
                      <Field
                        className="target-work-model-option"
                        key={value}
                        orientation="horizontal"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={commaListAt(row.workModel).some(
                            (saved) => saved === value || saved === label,
                          )}
                          onCheckedChange={(checked) =>
                            toggleWorkModel(index, value, label, checked)
                          }
                        />
                        <FieldLabel htmlFor={checkboxId}>{label}</FieldLabel>
                      </Field>
                    );
                  })}
                </FieldGroup>
              </FieldSet>
              <Button
                className="icon-button"
                aria-label={`Remove target location ${index + 1}`}
                size="icon"
                title="Remove"
                type="button"
                variant="ghost"
                onClick={() =>
                  updateRows(rows.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <IconTrash size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            className="add-bullet"
            onClick={appendRow}
            size="sm"
            type="button"
            variant="secondary"
          >
            <IconPlus size={14} aria-hidden="true" />
            Add location
          </Button>
        </div>
      </Field>
    );
  };

  const targetSearchSection = () => (
    <section
      className={
        showSectionHeading ? "form-section" : "target-search-grid-shell"
      }
    >
      {showSectionHeading ? <h3>Target search</h3> : null}
      <FieldGroup className="target-preferences-grid">
        <TargetPreferenceCard
          id="target-tracks-card-title"
          title="Target tracks"
        >
          {targetSearchCheckboxGroup(
            "experience.target_track",
            "Target tracks",
            TARGET_TRACK_GROUPS,
            {
              hideLegend: true,
            },
          )}
          {delimitedListField(
            "experience.target_role",
            "Target roles",
            "Add role",
            { compact: true },
          )}
        </TargetPreferenceCard>
        <TargetPreferenceCard
          id="seniority-floors-card-title"
          title="Seniority floors"
        >
          {targetSearchCheckboxGroup(
            "experience.target_seniority_floor",
            "Seniority floors",
            TARGET_SENIORITY_GROUPS,
            { hideLegend: true },
          )}
        </TargetPreferenceCard>
        <TargetPreferenceCard
          id="role-areas-card-title"
          title={ROLE_AREA_LABEL}
        >
          {delimitedListField(
            "experience.target_functions",
            ROLE_AREA_LABEL,
            "Add role area",
            {
              compact: true,
              hideTitle: true,
              placeholder: ROLE_AREA_PLACEHOLDER,
            },
          )}
          {delimitedListField(
            "experience.target_specializations",
            "Specializations",
            "Add specialization",
            {
              compact: true,
            },
          )}
        </TargetPreferenceCard>
        <TargetPreferenceCard
          id="locations-work-models-card-title"
          title={TARGET_LOCATION_LABEL}
        >
          {targetLocationWorkModelField({ hideTitle: true })}
        </TargetPreferenceCard>
      </FieldGroup>
    </section>
  );

  const styleSelect = (
    path: string,
    label: string,
    options: Array<[string, string]>,
  ) => {
    const id = editorControlId("style", path);
    const items = options.map(([value, text]) => ({ label: text, value }));
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select
          items={items}
          value={textAt(style, path)}
          onValueChange={(value) => updateStylePath(path, value)}
        >
          <SelectTrigger id={id} aria-label={label} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    );
  };

  const styleNumber = (
    path: string,
    label: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const id = editorControlId("style", path);
    return (
      <Field className="field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={textAt(style, path)}
          onChange={(event) =>
            updateStylePath(path, numberOrEmpty(event.target.value))
          }
        />
      </Field>
    );
  };

  const experienceEntries = recordArrayAt(profile, "resume.experience_entries");
  const educationEntries = recordArrayAt(profile, "resume.education_entries");
  const skillCategories = recordArrayAt(profile, "resume.skill_categories");
  const showProvinceStateField = isUnitedStatesAddressCountry(
    textAt(profile, "personal.country"),
  );

  return (
    <div
      className={
        mode === "profile"
          ? "profile-sections profile-sections--card-stack profile-sections--resume-data"
          : mode === "preferences"
            ? "profile-sections profile-sections--card-stack"
            : "profile-sections"
      }
    >
      {identityError ? <p role="alert">{identityError}</p> : null}
      {mode === "profile" ? (
        <>
          <ProfileSection
            className="profile-disclosure profile-disclosure--personal"
            collapsedSummary="Contact · address · professional links"
            defaultOpen
            description="Contact, address, and professional links"
            headingLevel={3}
            id="profile-personal"
            hidden={activeSection !== "personal"}
            title="Personal details"
          >
            <AdaptiveFieldGrid>
              {textField("personal.full_name", "Full name", "text", {
                required: true,
              })}
              {textField("personal.preferred_name", "Preferred name")}
              {textField("personal.email", "Email", "email", {
                required: true,
              })}
              {textField("personal.phone", "Phone", "tel")}
              {addressSearchField()}
              {textField("personal.city", "City", "text", {
                autoComplete: "address-level2",
              })}
              {showProvinceStateField
                ? textField(
                    "personal.province_state",
                    "State / province",
                    "text",
                    {
                      autoComplete: "address-level1",
                    },
                  )
                : null}
              {textField("personal.country", "Country", "text", {
                autoComplete: "country-name",
              })}
              {textField("personal.postal_code", "Postal code", "text", {
                autoComplete: "postal-code",
              })}
              {textField("personal.linkedin_url", "LinkedIn URL", "url")}
              {textField("personal.github_url", "GitHub URL", "url")}
              {textField("personal.portfolio_url", "Portfolio URL", "url")}
              {textField("personal.website_url", "Website URL", "url")}
            </AdaptiveFieldGrid>
          </ProfileSection>

          <ProfileSection
            actions={
              <Button
                onClick={sortExperienceEntriesNewestFirst}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconSortDescending aria-hidden="true" size={14} />
                Sort newest first
              </Button>
            }
            className="profile-disclosure profile-disclosure--experience"
            collapsedSummary={`${experienceEntries.length} ${
              experienceEntries.length === 1 ? "entry" : "entries"
            }`}
            defaultOpen={false}
            description="Roles, dates, optional position summaries and achievements"
            headingLevel={3}
            id="profile-experience"
            hidden={activeSection !== "experience"}
            title="Experience"
          >
            <div className="profile-experience-workspace">
              <nav className="profile-career-list" aria-label="Career roles">
                {experienceEntries.map((entry) => {
                  const id = textFrom(entry["id"]);
                  const selected =
                    id ===
                    (experienceEntries.some(
                      (role) => textFrom(role["id"]) === selectedRoleId,
                    )
                      ? selectedRoleId
                      : textFrom(experienceEntries[0]?.["id"]));
                  return (
                    <Button
                      key={id}
                      type="button"
                      variant="ghost"
                      aria-current={selected ? "true" : undefined}
                      onClick={() => selectRole(id)}
                      className="profile-career-role"
                    >
                      <strong>
                        {textFrom(entry["title"]) || "Untitled role"}
                      </strong>
                      <span>
                        {textFrom(entry["company"]) || "Add employer"}
                      </span>
                      <span>
                        {textFrom(entry["date_range"]) || "Dates not set"}
                      </span>
                      <small>
                        {editableTextArrayAt(entry, "bullets").length}{" "}
                        achievements
                      </small>
                    </Button>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addRepeatItem("resume.experience_entries")}
                >
                  Add role
                </Button>
              </nav>
              <FieldGroup className="repeat-list profile-selected-experience">
                <FieldDescription className="experience-order-description">
                  The resume follows this order. Sort by date, or move
                  individual roles into a custom sequence.
                </FieldDescription>
                <FieldDescription>
                  Every role and achievement remains in the composed resume.
                  Mark a bullet for optional coaching without changing its
                  inclusion.
                </FieldDescription>
                {experienceEntries.map((entry, index) => {
                  const entryId = textFrom(entry["id"]);
                  const entryLabel =
                    [textFrom(entry["company"]), textFrom(entry["title"])]
                      .filter(Boolean)
                      .join(" - ") || `Experience ${index + 1}`;
                  const bullets = editableTextArrayAt(
                    profile,
                    `resume.experience_entries.${index}.bullets`,
                  );
                  const requiredBullets = new Set(
                    asTextArray(
                      recordAt(
                        profile,
                        "resume.tailoring_rules.required_bullets_by_experience_id",
                      )[entryId],
                    ),
                  );
                  return (
                    <Fragment key={entryId || `experience-${index}`}>
                      {index > 0 ? (
                        <Separator className="repeat-section-separator" />
                      ) : null}
                      <FieldSet
                        className="repeat-section experience-repeat-section"
                        hidden={
                          entryId !==
                          (experienceEntries.some(
                            (role) => textFrom(role["id"]) === selectedRoleId,
                          )
                            ? selectedRoleId
                            : textFrom(experienceEntries[0]?.["id"]))
                        }
                      >
                        <FieldLegend className="experience-entry-legend">
                          <span
                            aria-hidden="true"
                            className="experience-order-index"
                          >
                            {index + 1}
                          </span>
                          <span>{entryLabel}</span>
                        </FieldLegend>
                        <div className="repeat-controls">
                          <div
                            aria-label={`Order ${entryLabel}`}
                            className="experience-order-controls"
                            role="group"
                          >
                            <Button
                              aria-label={`Move ${entryLabel} up`}
                              className="experience-order-button"
                              disabled={index === 0}
                              onClick={() => moveExperienceEntry(index, -1)}
                              size="icon"
                              title="Move up"
                              type="button"
                              variant="outline"
                            >
                              <IconArrowUp aria-hidden="true" size={14} />
                            </Button>
                            <Button
                              aria-label={`Move ${entryLabel} down`}
                              className="experience-order-button"
                              disabled={index === experienceEntries.length - 1}
                              onClick={() => moveExperienceEntry(index, 1)}
                              size="icon"
                              title="Move down"
                              type="button"
                              variant="outline"
                            >
                              <IconArrowDown aria-hidden="true" size={14} />
                            </Button>
                          </div>
                          <span>Included in every resume</span>
                          <Button
                            onClick={() =>
                              removeRepeatItem(
                                "resume.experience_entries",
                                index,
                              )
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Remove experience
                          </Button>
                        </div>
                        <AdaptiveFieldGrid>
                          {dateRangeField(
                            `resume.experience_entries.${index}.date_range`,
                            "Date range",
                          )}
                          {textField(
                            `resume.experience_entries.${index}.title`,
                            "Title",
                          )}
                          {textField(
                            `resume.experience_entries.${index}.company`,
                            "Company",
                          )}
                          {textField(
                            `resume.experience_entries.${index}.location`,
                            "Location",
                          )}
                          <AdaptiveFieldSpan span="full">
                            {textareaField(
                              `resume.experience_entries.${index}.summary`,
                              "Position summary (optional)",
                              "Briefly summarize the role, scope, or mandate shown before its achievements.",
                              { rows: 3 },
                            )}
                          </AdaptiveFieldSpan>
                        </AdaptiveFieldGrid>
                        <Separator />
                        <FieldGroup className="bullet-list">
                          <FieldDescription>
                            Keep each achievement and its numbers together. Each
                            bullet keeps its own stable identity.
                          </FieldDescription>
                          {bullets.map((bullet, bulletIndex) => {
                            const requiredBulletId = editorControlId(
                              "profile",
                              `experience-${index}-bullet-${bulletIndex}`,
                              "required",
                            );
                            return (
                              <Field
                                className="bullet-row profile-achievement"
                                key={String(
                                  getPathValue(
                                    profile,
                                    `resume.experience_entries.${index}.achievement_ids.${bulletIndex}`,
                                  ) ?? `${entryId}-${bulletIndex}`,
                                )}
                                tabIndex={-1}
                                ref={(element) => {
                                  const id = getPathValue(
                                    profile,
                                    `resume.experience_entries.${index}.achievement_ids.${bulletIndex}`,
                                  );
                                  if (typeof id === "string") {
                                    if (element)
                                      achievementTargetsRef.current.set(
                                        id,
                                        element,
                                      );
                                    else
                                      achievementTargetsRef.current.delete(id);
                                  }
                                }}
                              >
                                <div className="bullet-row-top">
                                  <FieldTitle className="bullet-label">
                                    Achievement {bulletIndex + 1}
                                  </FieldTitle>
                                  <Field
                                    className="choice bullet-choice"
                                    data-disabled={
                                      !entryId || !bullet || undefined
                                    }
                                    orientation="horizontal"
                                  >
                                    <Checkbox
                                      id={requiredBulletId}
                                      checked={requiredBullets.has(bullet)}
                                      disabled={!entryId || !bullet}
                                      onCheckedChange={(checked) =>
                                        setRequiredBullet(
                                          entryId,
                                          bullet,
                                          checked,
                                        )
                                      }
                                    />
                                    <FieldLabel htmlFor={requiredBulletId}>
                                      Include in coaching
                                    </FieldLabel>
                                  </Field>
                                </div>
                                <AchievementSource
                                  initiallyEmpty={!bullet.trim()}
                                >
                                  <Textarea
                                    aria-label={`Achievement ${bulletIndex + 1}`}
                                    ref={registerFocusTarget(
                                      bulletFocusKey(
                                        index,
                                        bulletIndex,
                                        "text",
                                      ),
                                    )}
                                    value={bullet}
                                    onChange={(event) =>
                                      updateProfilePath(
                                        `resume.experience_entries.${index}.bullets.${bulletIndex}`,
                                        event.target.value,
                                      )
                                    }
                                  />
                                </AchievementSource>
                                <div
                                  aria-label={`Actions for bullet ${bulletIndex + 1} in ${entryLabel}`}
                                  className="bullet-row-actions"
                                  role="group"
                                >
                                  <Button
                                    aria-label={`Move bullet ${bulletIndex + 1} up`}
                                    disabled={bulletIndex === 0}
                                    onClick={() =>
                                      moveBullet(index, bulletIndex, -1)
                                    }
                                    ref={registerFocusTarget(
                                      bulletFocusKey(index, bulletIndex, "up"),
                                    )}
                                    size="icon"
                                    title="Move bullet up"
                                    type="button"
                                    variant="outline"
                                  >
                                    <IconArrowUp
                                      aria-hidden="true"
                                      data-icon="inline-start"
                                    />
                                  </Button>
                                  <Button
                                    aria-label={`Move bullet ${bulletIndex + 1} down`}
                                    disabled={
                                      bulletIndex === bullets.length - 1
                                    }
                                    onClick={() =>
                                      moveBullet(index, bulletIndex, 1)
                                    }
                                    ref={registerFocusTarget(
                                      bulletFocusKey(
                                        index,
                                        bulletIndex,
                                        "down",
                                      ),
                                    )}
                                    size="icon"
                                    title="Move bullet down"
                                    type="button"
                                    variant="outline"
                                  >
                                    <IconArrowDown
                                      aria-hidden="true"
                                      data-icon="inline-start"
                                    />
                                  </Button>
                                  <Button
                                    className="icon-button"
                                    aria-label={`Remove achievement ${bulletIndex + 1}`}
                                    size="icon"
                                    title="Remove achievement"
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      removeBullet(index, bulletIndex)
                                    }
                                  >
                                    <IconTrash size={14} aria-hidden="true" />
                                  </Button>
                                </div>
                                {(() => {
                                  const id = getPathValue(
                                    profile,
                                    `resume.experience_entries.${index}.achievement_ids.${bulletIndex}`,
                                  );
                                  return typeof id === "string" ? (
                                    <>
                                      {achievementContent?.(id, entryId)}
                                      {achievementWordings ? (
                                        achievementWordings(id, entryId)
                                      ) : (
                                        <AchievementWordings
                                          achievementId={id}
                                        />
                                      )}
                                    </>
                                  ) : null;
                                })()}
                              </Field>
                            );
                          })}
                          <Button
                            className="add-bullet"
                            onClick={() => addBullet(index)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            <IconPlus size={14} aria-hidden="true" />
                            Add achievement
                          </Button>
                        </FieldGroup>
                      </FieldSet>
                    </Fragment>
                  );
                })}
              </FieldGroup>
            </div>
          </ProfileSection>

          <ProfileSection
            className="profile-disclosure profile-disclosure--baseline"
            collapsedSummary="Experience · executive profile · bullet limits"
            defaultOpen
            description="Default experience summary and baseline content"
            headingLevel={3}
            id="profile-baseline"
            hidden={activeSection !== "experience"}
            title="Professional summary"
          >
            <AdaptiveFieldGrid>
              {textField(
                "experience.years_of_experience_total",
                "Total years of experience",
                "number",
                {
                  min: 0,
                  step: 1,
                  valueKind: "text",
                },
              )}
              {textField("experience.education_level", "Education level")}
              {textField("experience.current_job_title", "Current job title")}
              {textField("experience.current_company", "Current company")}
            </AdaptiveFieldGrid>
            <AdaptiveFieldGrid>
              <AdaptiveFieldSpan span="full">
                {textareaField(
                  "resume.executive_profile.baseline_text",
                  "Executive profile baseline",
                )}
              </AdaptiveFieldSpan>
            </AdaptiveFieldGrid>
          </ProfileSection>

          <ProfileSection
            className="profile-disclosure profile-disclosure--education"
            collapsedSummary={`${educationEntries.length} ${
              educationEntries.length === 1 ? "entry" : "entries"
            }`}
            defaultOpen={false}
            description="Degrees, institutions and completion dates"
            headingLevel={3}
            id="profile-education"
            hidden={activeSection !== "education"}
            title="Education"
          >
            <FieldGroup className="repeat-list">
              {educationEntries.map((entry, index) => {
                const entryId = textFrom(entry["id"]);
                return (
                  <Fragment key={`${entryId || "education"}-${index}`}>
                    {index > 0 ? (
                      <Separator className="repeat-section-separator" />
                    ) : null}
                    <FieldSet className="repeat-section">
                      <FieldLegend>
                        {textFrom(entry["degree"]) || `Education ${index + 1}`}
                      </FieldLegend>
                      <div className="repeat-controls">
                        <span>Included in every resume</span>
                        <Button
                          onClick={() =>
                            removeRepeatItem("resume.education_entries", index)
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Remove education
                        </Button>
                      </div>
                      <AdaptiveFieldGrid>
                        {monthField(
                          `resume.education_entries.${index}.date`,
                          "Completion month",
                          "Completion",
                        )}
                        {textField(
                          `resume.education_entries.${index}.degree`,
                          "Degree",
                        )}
                        {textField(
                          `resume.education_entries.${index}.institution`,
                          "Institution",
                        )}
                        {textField(
                          `resume.education_entries.${index}.location`,
                          "Location",
                        )}
                      </AdaptiveFieldGrid>
                    </FieldSet>
                  </Fragment>
                );
              })}
              <Button
                onClick={() => addRepeatItem("resume.education_entries")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Add education
              </Button>
            </FieldGroup>
          </ProfileSection>

          <ProfileSection
            className="profile-disclosure profile-disclosure--skills"
            collapsedSummary={`${skillCategories.length} ${
              skillCategories.length === 1 ? "category" : "categories"
            }`}
            defaultOpen={false}
            description="Skill groups and individual skills"
            headingLevel={3}
            id="profile-skills"
            hidden={activeSection !== "skills"}
            title="Skills"
          >
            <FieldGroup className="repeat-list">
              {skillCategories.map((entry, index) => {
                const entryId = textFrom(entry["id"]);
                const skills = editableTextArrayAt(
                  profile,
                  `resume.skill_categories.${index}.items`,
                );
                return (
                  <Fragment key={`${entryId || "skills"}-${index}`}>
                    {index > 0 ? (
                      <Separator className="repeat-section-separator" />
                    ) : null}
                    <FieldSet className="repeat-section">
                      <FieldLegend>
                        {textFrom(entry["label"]) ||
                          `Skill category ${index + 1}`}
                      </FieldLegend>
                      <div className="repeat-controls">
                        <span>Included in every resume</span>
                        <Button
                          onClick={() =>
                            removeRepeatItem("resume.skill_categories", index)
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Remove skill category
                        </Button>
                      </div>
                      <AdaptiveFieldGrid>
                        <AdaptiveFieldSpan span="wide">
                          {textField(
                            `resume.skill_categories.${index}.label`,
                            "Label",
                          )}
                        </AdaptiveFieldSpan>
                      </AdaptiveFieldGrid>
                      <Separator />
                      <FieldGroup className="skill-list">
                        {skills.map((skill, skillIndex) => {
                          const skillId = editorControlId(
                            "profile",
                            `skill-category-${index}-skill-${skillIndex}`,
                          );
                          return (
                            <Field
                              className="skill-row"
                              key={`${entryId}-${skillIndex}`}
                            >
                              <Field className="skill-input field">
                                <FieldLabel htmlFor={skillId}>
                                  Skill {skillIndex + 1}
                                </FieldLabel>
                                <Input
                                  id={skillId}
                                  value={skill}
                                  onChange={(event) =>
                                    updateProfilePath(
                                      `resume.skill_categories.${index}.items.${skillIndex}`,
                                      event.target.value,
                                    )
                                  }
                                />
                              </Field>
                              <Button
                                className="icon-button"
                                aria-label={`Remove skill ${skillIndex + 1}`}
                                size="icon"
                                title="Remove skill"
                                type="button"
                                variant="ghost"
                                onClick={() => removeSkill(index, skillIndex)}
                              >
                                <IconTrash size={14} aria-hidden="true" />
                              </Button>
                            </Field>
                          );
                        })}
                        <Button
                          className="add-bullet"
                          onClick={() => addSkill(index)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          <IconPlus size={14} aria-hidden="true" />
                          Add skill
                        </Button>
                      </FieldGroup>
                    </FieldSet>
                  </Fragment>
                );
              })}
              <Button
                onClick={() => addRepeatItem("resume.skill_categories")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Add skill category
              </Button>
            </FieldGroup>
          </ProfileSection>

          <ProfileSection
            className="profile-disclosure profile-disclosure--eeo"
            collapsedSummary="Gender · race or ethnicity · veteran status · disability status"
            defaultOpen={false}
            description="Optional demographic information"
            headingLevel={3}
            id="profile-eeo"
            hidden={activeSection !== "personal"}
            title="Voluntary EEO"
          >
            <AdaptiveFieldGrid>
              {textField("eeo_voluntary.gender", "Gender")}
              {textField("eeo_voluntary.race_ethnicity", "Race / ethnicity")}
              {textField("eeo_voluntary.veteran_status", "Veteran status")}
              {textField(
                "eeo_voluntary.disability_status",
                "Disability status",
              )}
            </AdaptiveFieldGrid>
          </ProfileSection>
        </>
      ) : mode === "target-search" ? (
        targetSearchSection()
      ) : (
        <>
          <DisclosureSection
            collapsedSummary="Authorization · availability · compensation"
            defaultOpen
            description="Availability, work authorization, and compensation defaults"
            headingLevel={3}
            id="preferences-application"
            title="Application configuration"
          >
            <FieldGroup className="preferences-field-groups">
              {applicationConfigurationFields ? (
                <AdaptiveFieldGrid className="preferences-two-column-grid">
                  {applicationConfigurationFields}
                </AdaptiveFieldGrid>
              ) : null}
              <FieldSet className="preferences-field-group preferences-field-group--authorization">
                <FieldLegend>Work authorization and account</FieldLegend>
                <AdaptiveFieldGrid className="preferences-two-column-grid">
                  {yesNoCheckboxField(
                    "work_authorization.legally_authorized_to_work",
                    "Legally authorized to work",
                  )}
                  {yesNoCheckboxField(
                    "work_authorization.require_sponsorship",
                    "Requires sponsorship",
                  )}
                  {textField(
                    "work_authorization.work_permit_type",
                    "Work permit type",
                    "text",
                    {
                      helperText:
                        "For example, EU citizen, permanent resident, or permit name.",
                    },
                  )}
                  {textField(
                    "personal.password",
                    "Job-site login password",
                    "password",
                    {
                      autoComplete: "new-password",
                      helperText:
                        "Used only for local application workflows that require a saved login.",
                    },
                  )}
                </AdaptiveFieldGrid>
              </FieldSet>
              <FieldSet className="preferences-field-group preferences-field-group--availability">
                <FieldLegend>Availability</FieldLegend>
                <AdaptiveFieldGrid className="preferences-two-column-grid">
                  {textField(
                    "availability.earliest_start_date",
                    "Earliest start date",
                    "date",
                    {
                      helperText:
                        "Leave blank when your start date is flexible.",
                    },
                  )}
                  {yesNoCheckboxField(
                    "availability.available_for_full_time",
                    "Available full-time",
                  )}
                  {yesNoCheckboxField(
                    "availability.available_for_contract",
                    "Available for contract",
                  )}
                </AdaptiveFieldGrid>
              </FieldSet>
              <FieldSet className="preferences-field-group preferences-field-group--compensation">
                <FieldLegend>Compensation</FieldLegend>
                <AdaptiveFieldGrid className="preferences-two-column-grid">
                  {textField(
                    "compensation.salary_expectation",
                    "Salary expectation",
                    "number",
                    {
                      helperText:
                        "Annual gross amount in the selected currency.",
                      inputMode: "numeric",
                      min: 0,
                      step: 1,
                      valueKind: "text",
                    },
                  )}
                  {textField(
                    "compensation.salary_currency",
                    "Salary currency",
                    "text",
                    {
                      autoCapitalize: "characters",
                      helperText:
                        "Three-letter currency code, such as EUR or USD.",
                    },
                  )}
                  {textField(
                    "compensation.salary_range_min",
                    "Salary range min",
                    "number",
                    {
                      helperText:
                        "Annual gross minimum in the selected currency.",
                      inputMode: "numeric",
                      min: 0,
                      step: 1,
                      valueKind: "text",
                    },
                  )}
                  {textField(
                    "compensation.salary_range_max",
                    "Salary range max",
                    "number",
                    {
                      helperText:
                        "Annual gross maximum in the selected currency.",
                      inputMode: "numeric",
                      min: 0,
                      step: 1,
                      valueKind: "text",
                    },
                  )}
                  <AdaptiveFieldSpan span="full">
                    {textField(
                      "compensation.currency_conversion_note",
                      "Currency conversion guidance",
                      "text",
                      {
                        helperText:
                          "Used for salary questions when a job posting lists compensation in a different currency.",
                      },
                    )}
                  </AdaptiveFieldSpan>
                </AdaptiveFieldGrid>
              </FieldSet>
            </FieldGroup>
          </DisclosureSection>

          <DisclosureSection
            className="preferences-disclosure preferences-disclosure--tailoring"
            collapsedSummary="Full baseline · approved wording · review"
            defaultOpen
            description="How resume composition uses your saved Profile"
            headingLevel={3}
            id="preferences-tailoring"
            title="Resume composition"
          >
            <p>
              Every authored role and achievement stays in the composed resume.
              JobCtrl chooses only among wording you have approved and offers
              one advisory coherence review. Baseline copy is available in
              Settings and on each job.
            </p>
          </DisclosureSection>

          <DisclosureSection
            collapsedSummary="Typography · template · page layout"
            defaultOpen={false}
            description="Defaults for generated resumes outside the template workspace"
            headingLevel={3}
            id="preferences-style"
            title="Resume style"
          >
            <AdaptiveFieldGrid>
              {styleSelect("document_font_size", "Text size", [
                ["10pt", "Small"],
                ["11pt", "Regular"],
                ["12pt", "Large"],
              ])}
              {styleSelect("font_family", "Text font", [
                ["sans", "Sans"],
                ["roman", "Serif"],
              ])}
              {styleSelect("body_alignment", "Body alignment", [
                ["justified", "Justified"],
                ["left", "Left aligned"],
              ])}
              {styleSelect("moderncv_style", "Template style", [
                ["banking", "Banking"],
                ["classic", "Classic"],
                ["casual", "Casual"],
                ["oldstyle", "Oldstyle"],
                ["fancy", "Fancy"],
              ])}
              {styleSelect("moderncv_color", "Accent color", [
                ["black", "Black"],
                ["blue", "Blue"],
                ["burgundy", "Burgundy"],
                ["green", "Green"],
                ["grey", "Grey"],
                ["orange", "Orange"],
                ["purple", "Purple"],
                ["red", "Red"],
              ])}
              {styleSelect("paper_size", "Paper", [
                ["a4paper", "A4"],
                ["letterpaper", "Letter"],
              ])}
              {styleNumber("page_scale", "Page scale", 0.7, 1, 0.01)}
              {styleNumber(
                "hints_column_width_cm",
                "Date column width (cm)",
                1.5,
                5,
                0.1,
              )}
            </AdaptiveFieldGrid>
          </DisclosureSection>
        </>
      )}
    </div>
  );
}

function delimitedListAt(value: string): string[] {
  const withoutLegacyLabel = value;
  if (!withoutLegacyLabel) {
    return [""];
  }
  return withoutLegacyLabel
    .split(";")
    .map((item, index) => (index === 0 ? item : item.replace(/^\s+/, "")));
}

function commaListAt(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTargetSearchOption(
  value: string,
  options: readonly TargetSearchOption[],
): string | null {
  return options.find((option) => option.value === value)?.value ?? null;
}
