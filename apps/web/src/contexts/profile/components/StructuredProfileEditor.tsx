import {
  Fragment,
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { IconExternalLink, IconPlus, IconTrash } from "@tabler/icons-react";

import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import {
  AdaptiveFieldGrid,
  AdaptiveFieldSpan,
} from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../shared/ui/tabs.js";
import { Textarea } from "../../../shared/ui/textarea.js";

import {
  GoogleAddressSearchField,
  isUnitedStatesAddressCountry,
  type GoogleAddressSelection,
} from "./GoogleAddressSearchField.js";
import {
  asTextArray,
  cloneJsonRecord,
  defaultRepeatItem,
  editableTextArrayAt,
  getPathValue,
  type JsonRecord,
  lines,
  numberOrEmpty,
  parseJsonRecord,
  recordArrayAt,
  recordAt,
  setPathValue,
  textArrayAt,
  textAt,
  textFrom,
} from "../lib/json-record.js";
import {
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
  aliases?: readonly string[];
}

interface TargetSearchOptionGroup {
  label: string;
  options: readonly TargetSearchOption[];
}

const TARGET_TRACK_GROUPS: readonly TargetSearchOptionGroup[] = [
  {
    label: "",
    options: [
      {
        value: "ic",
        label: "Individual Contributor",
        aliases: ["individual contributor", "individual_contributor", "staff plus", "staff_plus"],
      },
      {
        value: "management",
        label: "Management",
        aliases: ["manager", "people manager", "people_manager"],
      },
      {
        value: "executive",
        label: "Executive",
        aliases: ["exec", "leadership"],
      },
    ],
  },
];

const TARGET_SENIORITY_GROUPS: readonly TargetSearchOptionGroup[] = [
  {
    label: "IC",
    options: [
      { value: "junior", label: "Junior Engineer" },
      { value: "engineer", label: "Engineer", aliases: ["mid engineer", "mid-level engineer"] },
      { value: "senior", label: "Senior Engineer" },
      { value: "staff", label: "Staff Engineer" },
      { value: "principal", label: "Principal Engineer" },
    ],
  },
  {
    label: "Management",
    options: [
      { value: "manager", label: "Engineering Manager" },
      {
        value: "senior_manager",
        label: "Senior Engineering Manager / Head of Engineering",
        aliases: ["senior manager", "senior engineering manager", "head of engineering"],
      },
      { value: "director", label: "Director of Engineering" },
    ],
  },
  {
    label: "Executive",
    options: [
      { value: "vp", label: "VP of Engineering", aliases: ["vice president engineering", "vp engineering"] },
      { value: "svp", label: "SVP Engineering", aliases: ["senior vice president engineering"] },
      { value: "cto", label: "CTO", aliases: ["chief technology officer"] },
    ],
  },
];

const BASELINE_NON_INVENTING_CLAIM_MODE = "adjacent_translation";
const INVENTED_ADJACENT_CLAIM_MODE = "draft_requires_confirmation";
const DEFAULT_AUTO_APPROVABLE_CLAIM_MODES = ["verified_only", "evidence_reframing"] as const;
const CLAIM_MODE_PATH = "resume.tailoring_rules.tailoring_policy.claim_mode";
const AUTO_APPROVABLE_CLAIM_MODES_PATH =
  "resume.tailoring_rules.tailoring_policy.auto_approvable_claim_modes";
const ALLOW_MINOR_INFERENCE_PATH = "resume.tailoring_rules.tailoring_policy.allow_minor_inference";
const ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH =
  "resume.tailoring_rules.tailoring_policy.allow_adjacent_achievement_drafts";

const KEYWORD_EMPHASIS_OPTIONS: Array<[string, string]> = [
  ["natural", "Natural"],
  ["moderate", "Moderate"],
  ["high", "High"],
];

const BULLET_STANDARD_OPTIONS: Array<[string, string]> = [
  ["impact", "Impact"],
  ["technical_depth", "Technical depth"],
  ["leadership", "Leadership"],
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

function editorControlId(scope: "profile" | "style", path: string, suffix = "") {
  const normalizedPath = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `structured-${scope}-${normalizedPath}${suffix ? `-${suffix}` : ""}`;
}

export interface StructuredProfileEditorProps {
  applicationConfigurationFields?: ReactNode;
  mode?: "profile" | "preferences" | "target-search";
  showSectionHeading?: boolean;
  profileText: string;
  styleText: string;
  onProfileTextChange: (value: string) => void;
  onStyleTextChange: (value: string) => void;
}

export function StructuredProfileEditor({
  applicationConfigurationFields,
  mode = "profile",
  showSectionHeading = true,
  profileText,
  styleText,
  onProfileTextChange,
  onStyleTextChange,
}: StructuredProfileEditorProps) {
  const profile = parseJsonRecord(profileText);
  const style = parseJsonRecord(styleText);
  const focusTargetsRef = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const pendingFocusKeyRef = useRef<string | null>(null);

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
  }, [profileText]);

  const registerFocusTarget = (key: string) => (element: HTMLInputElement | HTMLSelectElement | null) => {
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
          The structured editor needs valid profile data. Reload the profile after fixing the saved data.
        </AlertDescription>
      </Alert>
    );
  }

  const normalizePreferencesClaimPolicy = (draft: JsonRecord) => {
    if (mode !== "preferences") {
      return;
    }
    const allowsInventedAdjacent =
      Boolean(getPathValue(draft, ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH)) ||
      textAt(draft, CLAIM_MODE_PATH) === INVENTED_ADJACENT_CLAIM_MODE;
    setPathValue(
      draft,
      CLAIM_MODE_PATH,
      allowsInventedAdjacent ? INVENTED_ADJACENT_CLAIM_MODE : BASELINE_NON_INVENTING_CLAIM_MODE,
    );
    setPathValue(draft, ALLOW_MINOR_INFERENCE_PATH, true);
    setPathValue(draft, ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH, allowsInventedAdjacent);
    setPathValue(draft, AUTO_APPROVABLE_CLAIM_MODES_PATH, [...DEFAULT_AUTO_APPROVABLE_CLAIM_MODES]);
  };

  const updateProfileDraft = (updater: (draft: JsonRecord) => void) => {
    const draft = cloneJsonRecord(profile);
    updater(draft);
    normalizePreferencesClaimPolicy(draft);
    onProfileTextChange(JSON.stringify(draft, null, 2));
  };

  const updateProfilePath = (path: string, value: unknown) => {
    updateProfileDraft((draft) => setPathValue(draft, path, value));
  };

  const updateStylePath = (path: string, value: unknown) => {
    const draft = cloneJsonRecord(style);
    setPathValue(draft, path, value);
    onStyleTextChange(JSON.stringify(draft, null, 2));
  };

  const setRequiredId = (path: string, id: string, checked: boolean) => {
    if (!id) {
      return;
    }
    updateProfileDraft((draft) => {
      const values = new Set(textArrayAt(draft, path));
      if (checked) {
        values.add(id);
      } else {
        values.delete(id);
      }
      setPathValue(draft, path, Array.from(values));
    });
  };

  const setRequiredBullet = (entryId: string, bullet: string, checked: boolean) => {
    if (!entryId || !bullet) {
      return;
    }
    updateProfileDraft((draft) => {
      const mapPath = "resume.tailoring_rules.required_bullets_by_experience_id";
      const existing = recordAt(draft, mapPath);
      const values = new Set(asTextArray(existing[entryId]));
      if (checked) {
        values.add(bullet);
      } else {
        values.delete(bullet);
      }
      setPathValue(draft, mapPath, { ...existing, [entryId]: Array.from(values) });
    });
  };

  const setRequiredSkill = (categoryId: string, skill: string, checked: boolean) => {
    if (!categoryId || !skill) {
      return;
    }
    updateProfileDraft((draft) => {
      const mapPath = "resume.tailoring_rules.required_skills_by_category_id";
      const existing = recordAt(draft, mapPath);
      const values = new Set(asTextArray(existing[categoryId]));
      if (checked) {
        values.add(skill);
      } else {
        values.delete(skill);
      }
      setPathValue(draft, mapPath, { ...existing, [categoryId]: Array.from(values) });
    });
  };

  const allowsInventedAdjacentExperience = () =>
    Boolean(getPathValue(profile, ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH)) ||
    textAt(profile, CLAIM_MODE_PATH) === INVENTED_ADJACENT_CLAIM_MODE;

  const setInventedAdjacentExperienceAllowed = (checked: boolean) => {
    updateProfileDraft((draft) => {
      setPathValue(
        draft,
        CLAIM_MODE_PATH,
        checked ? INVENTED_ADJACENT_CLAIM_MODE : BASELINE_NON_INVENTING_CLAIM_MODE,
      );
      setPathValue(draft, ALLOW_MINOR_INFERENCE_PATH, true);
      setPathValue(draft, ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH, checked);
      setPathValue(draft, AUTO_APPROVABLE_CLAIM_MODES_PATH, [...DEFAULT_AUTO_APPROVABLE_CLAIM_MODES]);
    });
  };

  const addRepeatItem = (path: string) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      setPathValue(draft, path, [...items, defaultRepeatItem(path)]);
    });
  };

  const removeRepeatItem = (path: string, index: number) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      setPathValue(
        draft,
        path,
        items.filter((_, itemIndex) => itemIndex !== index),
      );
    });
  };

  const addBullet = (entryIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      setPathValue(draft, path, [...editableTextArrayAt(draft, path), ""]);
    });
  };

  const removeBullet = (entryIndex: number, bulletIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      setPathValue(
        draft,
        path,
        editableTextArrayAt(draft, path).filter((_, index) => index !== bulletIndex),
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
        editableTextArrayAt(draft, path).filter((_, index) => index !== skillIndex),
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
    const describedBy = [inputAttrs["aria-describedby"], descriptionId].filter(Boolean).join(" ") || undefined;
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
                ? constrainedNumberOrEmpty(event.target.value, attrs, valueKind === "text")
                : event.target.value,
            )
          }
        />
        {helperText ? <FieldDescription id={descriptionId}>{helperText}</FieldDescription> : null}
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
        onAddressChange={(value) => updateProfilePath("personal.address", value)}
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
    const constrained = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    return keepText ? String(constrained) : constrained;
  };

  const years = profileYearOptions();

  const monthSelector = (
    label: string,
    value: ProfileMonthValue,
    onChange: (value: ProfileMonthValue) => void,
    disabled = false,
  ) => {
    const emptyMonthValue = "__empty-month__";
    const emptyYearValue = "__empty-year__";
    const monthItems = [
      { label: "Month", value: emptyMonthValue },
      ...PROFILE_MONTHS.map((month) => ({ label: month.label, value: month.value })),
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
          <SelectTrigger aria-label={`${label} month`} className="w-full">
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
          <SelectTrigger aria-label={`${label} year`} className="w-full">
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

  const monthField = (path: string, label: string) => {
    const value = parseProfileMonth(textAt(profile, path));
    return (
      <Field className="field month-field">
        <FieldTitle>{label}</FieldTitle>
        <div className="month-field-body">
          {monthSelector(label, value, (next) => updateProfilePath(path, formatProfileMonth(next)))}
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
      <Field className="field date-range-field wide" data-invalid={hasError || undefined}>
        <FieldTitle>{label}</FieldTitle>
        <div className={`date-range-body${hasError ? " invalid" : ""}`}>
          {monthSelector("Start", value.start, (start) => updateDateRange({ start }))}
          {value.present
            ? null
            : monthSelector("End", value.end, (end) => updateDateRange({ end, present: false }))}
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
        {hasError ? <FieldError>End date must be after start date.</FieldError> : null}
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

  const inventedAdjacentExperienceField = () => {
    const id = editorControlId("profile", ALLOW_ADJACENT_ACHIEVEMENT_DRAFTS_PATH);
    return (
    <Field className="field check" orientation="horizontal">
      <Checkbox
        id={id}
        checked={allowsInventedAdjacentExperience()}
        onCheckedChange={setInventedAdjacentExperienceAllowed}
      />
      <FieldLabel htmlFor={id}>Enable profile enhancement</FieldLabel>
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
        onCheckedChange={(checked) => updateProfilePath(path, checked ? "Yes" : "No")}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription id={descriptionId} aria-live="polite">
          {isUnanswered ? "Not answered" : answer}
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
    const displayedValue = value === undefined || value === null || value === "" ? attrs.defaultValue : value;
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
            updateProfilePath(path, typeof parsed === "number" ? Math.round(parsed) : parsed);
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
    const ratioValue = rawValue === undefined || rawValue === null || rawValue === "" ? attrs.defaultValue : Number(rawValue);
    const percentValue = Number.isFinite(ratioValue) ? Math.round(ratioValue * 100) : Math.round(attrs.defaultValue * 100);
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
            updateProfilePath(path, typeof parsed === "number" ? Math.round(parsed) / 100 : parsed);
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
        <Checkbox aria-describedby={descriptionId} id={id} checked={false} disabled />
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
        onChange={(event) => updateProfilePath(path, lines(event.target.value))}
      />
    </Field>
    );
  };

  const delimitedListField = (
    path: string,
    label: string,
    addLabel: string,
    options: { compact?: boolean; placeholder?: string } = {},
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
        <FieldTitle>{label}</FieldTitle>
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
                onClick={() => updateValues(values.filter((_, itemIndex) => itemIndex !== index))}
              >
                <IconTrash size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button className="add-bullet" onClick={appendValue} size="sm" type="button" variant="secondary">
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
  ) => {
    const options = groups.flatMap((group) => group.options);
    const values = delimitedListAt(textAt(profile, path)).map((value) => value.trim()).filter(Boolean);
    const selected = new Set(
      values.map((value) => normalizeTargetSearchOption(value, options)).filter((value): value is string => Boolean(value)),
    );
    const customValues = values.filter((value) => !normalizeTargetSearchOption(value, options));
    const updateSelection = (optionValue: string, checked: boolean) => {
      const next = new Set(selected);
      if (checked) {
        next.add(optionValue);
      } else {
        next.delete(optionValue);
      }
      const orderedKnownValues = options.map((option) => option.value).filter((value) => next.has(value));
      updateProfilePath(path, [...orderedKnownValues, ...customValues].join("; "));
    };
    const removeCustomValue = (customValue: string) => {
      const orderedKnownValues = options.map((option) => option.value).filter((value) => selected.has(value));
      updateProfilePath(
        path,
        [...orderedKnownValues, ...customValues.filter((value) => value !== customValue)].join("; "),
      );
    };

    return (
      <FieldSet className="field wide checkbox-group-field">
        <FieldLegend>{label}</FieldLegend>
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
                      onCheckedChange={(checked) => updateSelection(option.value, checked)}
                    />
                    <FieldLabel htmlFor={editorControlId("profile", path, option.value)}>
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

  const targetLocationWorkModelField = () => {
    const locationPath = "experience.target_locations";
    const workModelPath = "experience.target_work_models";
    const locations = delimitedListAt(textAt(profile, locationPath));
    const workModels = delimitedListAt(textAt(profile, workModelPath));
    const rowCount = Math.max(locations.length, workModels.length, 1);
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      location: locations[index] ?? "",
      workModel: workModels[index] ?? "",
    }));
    const locationFocusKey = (index: number) => `${locationPath}:location:${index}`;
    const workModelOptions = ["Remote", "Hybrid", "On-site"];

    const updateRows = (nextRows: Array<{ location: string; workModel: string }>) => {
      updateProfileDraft((draft) => {
        setPathValue(draft, locationPath, nextRows.map((row) => row.location).join("; "));
        setPathValue(draft, workModelPath, nextRows.map((row) => row.workModel).join("; "));
      });
    };
    const emptyRow = { location: "", workModel: "" };
    const insertRowAfter = (index: number, rowPatch: Partial<{ location: string; workModel: string }>) => {
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
    const toggleWorkModel = (index: number, value: string, checked: boolean) => {
      const selected = new Set(commaListAt(rows[index]?.workModel ?? ""));
      if (checked) {
        selected.add(value);
      } else {
        selected.delete(value);
      }
      const next = [...rows];
      next[index] = { ...(next[index] ?? emptyRow), workModel: Array.from(selected).join(", ") };
      updateRows(next);
    };

    return (
      <Field className="field wide target-location-model-field">
        <FieldTitle>{TARGET_LOCATION_LABEL}</FieldTitle>
        <div className="target-location-model-list">
          {rows.map((row, index) => (
            <div className="target-location-model-row" key={`${locationPath}-${index}`}>
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
                  insertRowAfter(index, { location: event.currentTarget.value });
                }}
              />
              <FieldSet className="target-work-model-group">
                <FieldLegend className="sr-only">Target work model {index + 1}</FieldLegend>
                <FieldGroup className="target-work-model-options">
                  {workModelOptions.map((value) => {
                    const checkboxId = `target-work-model-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                    return (
                      <Field
                        className="target-work-model-option"
                        key={value}
                        orientation="horizontal"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={commaListAt(row.workModel).includes(value)}
                          onCheckedChange={(checked) => toggleWorkModel(index, value, checked)}
                        />
                        <FieldLabel htmlFor={checkboxId}>{value}</FieldLabel>
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
                onClick={() => updateRows(rows.filter((_, itemIndex) => itemIndex !== index))}
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

  const bulletStandardsField = () => (
    <FieldSet className="field wide checkbox-group-field bullet-standards-group">
      <FieldLegend>Bullet standards</FieldLegend>
      <a
        className="configuration-help-link"
        data-typography="control"
        href="https://jobctrl.dev/architecture/tailoring#inputs-to-tailoring"
        rel="noreferrer"
        target="_blank"
      >
        Guide
        <IconExternalLink aria-hidden="true" size={12} />
      </a>
      <FieldGroup className="checkbox-options">
        {BULLET_STANDARD_OPTIONS.map(([value, label]) => {
          const id = editorControlId("profile", "bullet-standard", value);
          const descriptionId = `${id}-description`;
          return (
            <Field
              className="choice target-choice required-choice locked-choice"
              data-disabled
              key={value}
              orientation="horizontal"
            >
              <Checkbox
                aria-describedby={descriptionId}
                id={id}
                checked
                disabled
                name="bullet-standard"
                value={value}
              />
              <FieldContent>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <FieldDescription id={descriptionId}>
                  Required for evidence-quality resumes and cannot be disabled.
                </FieldDescription>
              </FieldContent>
            </Field>
          );
        })}
      </FieldGroup>
      <FieldDescription>
        Required evidence-quality standards; these cannot be disabled.
      </FieldDescription>
    </FieldSet>
  );

  const adjacentExperienceClaimsGroup = () => (
    <FieldSet className="field wide checkbox-group-field tailoring-control-group">
      <FieldLegend>Adjacent experience claims</FieldLegend>
      <AdaptiveFieldGrid>
        <AdaptiveFieldSpan span="wide">
          {inventedAdjacentExperienceField()}
        </AdaptiveFieldSpan>
      </AdaptiveFieldGrid>
    </FieldSet>
  );

  const generationPermissionsGroup = () => (
    <FieldSet className="field wide checkbox-group-field tailoring-control-group">
      <FieldLegend>Generation permissions</FieldLegend>
      <FieldGroup className="checkbox-options vertical">
        {checkboxField(
          "resume.tailoring_rules.tailoring_policy.allow_summary_rewrite",
          "Rewrite executive summary",
        )}
        {checkboxField(
          "resume.tailoring_rules.tailoring_policy.allow_achievement_rewriting",
          "Rewrite achievement bullets",
        )}
        {checkboxField(
          "resume.tailoring_rules.tailoring_policy.allow_skill_reordering",
          "Select and order existing skills",
        )}
        {disabledCheckboxField(
          "Change experience titles",
          "Experience titles remain fixed to profile evidence during tailoring.",
        )}
      </FieldGroup>
    </FieldSet>
  );

  const writingStyleGroup = () => (
    <FieldSet className="field wide checkbox-group-field tailoring-control-group tailoring-writing-style-group">
      <FieldLegend>Writing style</FieldLegend>
      <AdaptiveFieldGrid>
        {selectField("resume.tailoring_rules.writing_style.tone", "Writing tone", [
          ["direct", "Direct"],
          ["executive", "Executive"],
          ["technical", "Technical"],
          ["confident", "Confident"],
          ["warm", "Warm"],
        ])}
        {selectField("resume.tailoring_rules.writing_style.verbosity", "Verbosity", [
          ["concise", "Concise"],
          ["balanced", "Balanced"],
          ["detailed", "Detailed"],
        ])}
        {selectField("resume.tailoring_rules.writing_style.keyword_density", "Keyword emphasis", KEYWORD_EMPHASIS_OPTIONS)}
        {checkboxField(
          "resume.tailoring_rules.writing_style.avoid_first_person",
          "Avoid first-person language",
        )}
      </AdaptiveFieldGrid>
    </FieldSet>
  );

  const revisionPolicyGroup = () => (
    <FieldSet className="field wide checkbox-group-field tailoring-control-group revision-policy-group">
      <FieldLegend>Revision policy</FieldLegend>
      <AdaptiveFieldGrid>
        {numberField("resume.tailoring_rules.revision_gates.min_fit_score", "Minimum fit score", {
          min: 1,
          max: 10,
          step: 1,
          defaultValue: 8,
        })}
        {percentField("resume.tailoring_rules.revision_gates.must_have_coverage", "Must-have coverage (%)", {
          min: 0,
          max: 100,
          step: 1,
          defaultValue: 0.85,
        })}
        {numberField("resume.tailoring_rules.revision_gates.max_revision_attempts", "Revision attempts", {
          min: 0,
          max: 10,
          step: 1,
          defaultValue: 1,
        })}
      </AdaptiveFieldGrid>
    </FieldSet>
  );

  const additionalGuidanceGroup = () => (
    <AdaptiveFieldGrid className="tailoring-additional-guidance-group">
      <AdaptiveFieldSpan span="full">
        {textareaField(
          "resume.tailoring_rules.custom_tailoring_prompt",
          "Additional guidance",
          "Writing and positioning guidance; evidence rules still apply.",
          { maxLength: 1200 },
        )}
      </AdaptiveFieldSpan>
    </AdaptiveFieldGrid>
  );

  const targetSearchSection = () => (
    <section className="form-section">
      {showSectionHeading ? <h3>Target search</h3> : null}
      <FieldGroup className="target-preferences-grid">
        <FieldGroup className="target-preference-cluster">
          {targetSearchCheckboxGroup("experience.target_track", "Target tracks", TARGET_TRACK_GROUPS)}
          {delimitedListField("experience.target_role", "Target roles", "Add role", { compact: true })}
        </FieldGroup>
        <FieldGroup className="target-preference-cluster">
          {targetSearchCheckboxGroup(
            "experience.target_seniority_floor",
            "Seniority floors",
            TARGET_SENIORITY_GROUPS,
          )}
        </FieldGroup>
        <FieldGroup className="target-preference-cluster">
          {delimitedListField("experience.target_functions", ROLE_AREA_LABEL, "Add role area", {
            compact: true,
            placeholder: ROLE_AREA_PLACEHOLDER,
          })}
          {delimitedListField("experience.target_specializations", "Specializations", "Add specialization", {
            compact: true,
          })}
        </FieldGroup>
        <FieldGroup className="target-preference-cluster">
          {targetLocationWorkModelField()}
        </FieldGroup>
      </FieldGroup>
    </section>
  );

  const styleSelect = (path: string, label: string, options: Array<[string, string]>) => {
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

  const styleNumber = (path: string, label: string, min: number, max: number, step: number) => {
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
        onChange={(event) => updateStylePath(path, numberOrEmpty(event.target.value))}
      />
    </Field>
    );
  };

  const experienceEntries = recordArrayAt(profile, "resume.experience_entries");
  const educationEntries = recordArrayAt(profile, "resume.education_entries");
  const skillCategories = recordArrayAt(profile, "resume.skill_categories");
  const requiredExperienceIds = new Set(
    textArrayAt(profile, "resume.tailoring_rules.required_experience_entry_ids"),
  );
  const requiredEducationIds = new Set(
    textArrayAt(profile, "resume.tailoring_rules.required_education_entry_ids"),
  );
  const requiredSkillIds = new Set(
    textArrayAt(profile, "resume.tailoring_rules.required_skill_category_ids"),
  );
  const showProvinceStateField = isUnitedStatesAddressCountry(textAt(profile, "personal.country"));

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
      {mode === "profile" ? (
        <>
          <DisclosureSection
            className="profile-disclosure profile-disclosure--personal"
            collapsedSummary="Contact · address · professional links"
            defaultOpen
            description="Contact, address, and professional links"
            headingLevel={3}
            title="Personal information"
          >
            <AdaptiveFieldGrid>
              {textField("personal.full_name", "Full name", "text", { required: true })}
              {textField("personal.preferred_name", "Preferred name")}
              {textField("personal.email", "Email", "email", { required: true })}
              {textField("personal.phone", "Phone", "tel")}
              {addressSearchField()}
              {textField("personal.city", "City", "text", { autoComplete: "address-level2" })}
              {showProvinceStateField
                ? textField("personal.province_state", "State / province", "text", {
                    autoComplete: "address-level1",
                  })
                : null}
              {textField("personal.country", "Country", "text", { autoComplete: "country-name" })}
              {textField("personal.postal_code", "Postal code", "text", { autoComplete: "postal-code" })}
              {textField("personal.linkedin_url", "LinkedIn URL", "url")}
              {textField("personal.github_url", "GitHub URL", "url")}
              {textField("personal.portfolio_url", "Portfolio URL", "url")}
              {textField("personal.website_url", "Website URL", "url")}
            </AdaptiveFieldGrid>
          </DisclosureSection>

          <DisclosureSection
            className="profile-disclosure profile-disclosure--baseline"
            collapsedSummary="Experience · executive profile · verified metrics"
            defaultOpen
            description="Default experience summary and verified evidence"
            headingLevel={3}
            title="Resume baseline"
          >
            <AdaptiveFieldGrid>
              {textField("experience.years_of_experience_total", "Total years of experience", "number", {
                min: 0,
                step: 1,
                valueKind: "text",
              })}
              {textField("experience.education_level", "Education level")}
              {textField("experience.current_job_title", "Current job title")}
              {textField("experience.current_company", "Current company")}
              {textField(
                "resume.tailoring_rules.max_experience_bullets",
                "Max bullets per role",
                "number",
                { min: 1, max: 99, step: 1 },
              )}
            </AdaptiveFieldGrid>
            <AdaptiveFieldGrid>
              <AdaptiveFieldSpan span="full">
                {textareaField("resume.executive_profile.baseline_text", "Executive profile baseline")}
              </AdaptiveFieldSpan>
              <AdaptiveFieldSpan span="full">
                {listField("resume_constraints.real_metrics", "Verified resume metrics")}
              </AdaptiveFieldSpan>
            </AdaptiveFieldGrid>
          </DisclosureSection>

          <DisclosureSection
            className="profile-disclosure profile-disclosure--experience"
            collapsedSummary={`${experienceEntries.length} ${
              experienceEntries.length === 1 ? "entry" : "entries"
            }`}
            defaultOpen={false}
            description="Roles, dates, bullets, and required content"
            headingLevel={3}
            title="Experience entries"
          >
            <FieldGroup className="repeat-list">
              {experienceEntries.map((entry, index) => {
                const entryId = textFrom(entry["id"]);
                const bullets = editableTextArrayAt(profile, `resume.experience_entries.${index}.bullets`);
                const requiredBullets = new Set(
                  asTextArray(
                    recordAt(profile, "resume.tailoring_rules.required_bullets_by_experience_id")[entryId],
                  ),
                );
                const requiredEntryId = editorControlId("profile", `experience-${index}`, "required");
                return (
                  <Fragment key={`${entryId || "experience"}-${index}`}>
                    {index > 0 ? <Separator className="repeat-section-separator" /> : null}
                    <FieldSet className="repeat-section">
                      <FieldLegend>
                        {textFrom(entry["title"]) || `Experience ${index + 1}`}
                      </FieldLegend>
                      <div className="repeat-controls">
                        <Field
                          className="choice"
                          data-disabled={!entryId || undefined}
                          orientation="horizontal"
                        >
                          <Checkbox
                            id={requiredEntryId}
                            checked={requiredExperienceIds.has(entryId)}
                            disabled={!entryId}
                            onCheckedChange={(checked) =>
                              setRequiredId(
                                "resume.tailoring_rules.required_experience_entry_ids",
                                entryId,
                                checked,
                              )
                            }
                          />
                          <FieldLabel htmlFor={requiredEntryId}>Must appear in final resume</FieldLabel>
                        </Field>
                        <Button
                          onClick={() => removeRepeatItem("resume.experience_entries", index)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Remove experience
                        </Button>
                      </div>
                      <AdaptiveFieldGrid>
                        {dateRangeField(`resume.experience_entries.${index}.date_range`, "Date range")}
                        {textField(`resume.experience_entries.${index}.title`, "Title")}
                        {textField(`resume.experience_entries.${index}.company`, "Company")}
                        {textField(`resume.experience_entries.${index}.location`, "Location")}
                      </AdaptiveFieldGrid>
                      <Separator />
                      <FieldGroup className="bullet-list">
                        {bullets.map((bullet, bulletIndex) => {
                          const requiredBulletId = editorControlId(
                            "profile",
                            `experience-${index}-bullet-${bulletIndex}`,
                            "required",
                          );
                          return (
                            <Field className="bullet-row" key={`${entryId}-${bulletIndex}`}>
                              <div className="bullet-row-top">
                                <FieldTitle className="bullet-label">Bullet {bulletIndex + 1}</FieldTitle>
                                <Field
                                  className="choice bullet-choice"
                                  data-disabled={!entryId || !bullet || undefined}
                                  orientation="horizontal"
                                >
                                  <Checkbox
                                    id={requiredBulletId}
                                    checked={requiredBullets.has(bullet)}
                                    disabled={!entryId || !bullet}
                                    onCheckedChange={(checked) =>
                                      setRequiredBullet(entryId, bullet, checked)
                                    }
                                  />
                                  <FieldLabel htmlFor={requiredBulletId}>Required</FieldLabel>
                                </Field>
                              </div>
                              <Textarea
                                aria-label={`Bullet ${bulletIndex + 1}`}
                                value={bullet}
                                onChange={(event) =>
                                  updateProfilePath(
                                    `resume.experience_entries.${index}.bullets.${bulletIndex}`,
                                    event.target.value,
                                  )
                                }
                              />
                              <Button
                                className="icon-button"
                                aria-label={`Remove bullet ${bulletIndex + 1}`}
                                size="icon"
                                title="Remove bullet"
                                type="button"
                                variant="ghost"
                                onClick={() => removeBullet(index, bulletIndex)}
                              >
                                <IconTrash size={14} aria-hidden="true" />
                              </Button>
                            </Field>
                          );
                        })}
                        <Button className="add-bullet" onClick={() => addBullet(index)} size="sm" type="button" variant="secondary">
                          <IconPlus size={14} aria-hidden="true" />
                          Add bullet
                        </Button>
                      </FieldGroup>
                    </FieldSet>
                  </Fragment>
                );
              })}
              <Button
                onClick={() => addRepeatItem("resume.experience_entries")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Add experience
              </Button>
            </FieldGroup>
          </DisclosureSection>

          <DisclosureSection
            className="profile-disclosure profile-disclosure--education"
            collapsedSummary={`${educationEntries.length} ${
              educationEntries.length === 1 ? "entry" : "entries"
            }`}
            defaultOpen={false}
            description="Degrees, institutions, completion dates, and required content"
            headingLevel={3}
            title="Education"
          >
            <FieldGroup className="repeat-list">
              {educationEntries.map((entry, index) => {
                const entryId = textFrom(entry["id"]);
                const requiredEntryId = editorControlId("profile", `education-${index}`, "required");
                return (
                  <Fragment key={`${entryId || "education"}-${index}`}>
                    {index > 0 ? <Separator className="repeat-section-separator" /> : null}
                    <FieldSet className="repeat-section">
                      <FieldLegend>
                        {textFrom(entry["degree"]) || `Education ${index + 1}`}
                      </FieldLegend>
                      <div className="repeat-controls">
                        <Field
                          className="choice"
                          data-disabled={!entryId || undefined}
                          orientation="horizontal"
                        >
                          <Checkbox
                            id={requiredEntryId}
                            checked={requiredEducationIds.has(entryId)}
                            disabled={!entryId}
                            onCheckedChange={(checked) =>
                              setRequiredId(
                                "resume.tailoring_rules.required_education_entry_ids",
                                entryId,
                                checked,
                              )
                            }
                          />
                          <FieldLabel htmlFor={requiredEntryId}>Must appear in final resume</FieldLabel>
                        </Field>
                        <Button
                          onClick={() => removeRepeatItem("resume.education_entries", index)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Remove education
                        </Button>
                      </div>
                      <AdaptiveFieldGrid>
                        {monthField(`resume.education_entries.${index}.date`, "Completion month")}
                        {textField(`resume.education_entries.${index}.degree`, "Degree")}
                        {textField(`resume.education_entries.${index}.institution`, "Institution")}
                        {textField(`resume.education_entries.${index}.location`, "Location")}
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
          </DisclosureSection>

          <DisclosureSection
            className="profile-disclosure profile-disclosure--skills"
            collapsedSummary={`${skillCategories.length} ${
              skillCategories.length === 1 ? "category" : "categories"
            }`}
            defaultOpen={false}
            description="Skill groups, individual skills, and required content"
            headingLevel={3}
            title="Skill categories"
          >
            <FieldGroup className="repeat-list">
              {skillCategories.map((entry, index) => {
                const entryId = textFrom(entry["id"]);
                const skills = editableTextArrayAt(profile, `resume.skill_categories.${index}.items`);
                const requiredSkills = new Set(
                  asTextArray(
                    recordAt(profile, "resume.tailoring_rules.required_skills_by_category_id")[entryId],
                  ),
                );
                const requiredEntryId = editorControlId("profile", `skills-${index}`, "required");
                return (
                  <Fragment key={`${entryId || "skills"}-${index}`}>
                    {index > 0 ? <Separator className="repeat-section-separator" /> : null}
                    <FieldSet className="repeat-section">
                      <FieldLegend>
                        {textFrom(entry["label"]) || `Skill category ${index + 1}`}
                      </FieldLegend>
                      <div className="repeat-controls">
                        <Field
                          className="choice"
                          data-disabled={!entryId || undefined}
                          orientation="horizontal"
                        >
                          <Checkbox
                            id={requiredEntryId}
                            checked={requiredSkillIds.has(entryId)}
                            disabled={!entryId}
                            onCheckedChange={(checked) =>
                              setRequiredId(
                                "resume.tailoring_rules.required_skill_category_ids",
                                entryId,
                                checked,
                              )
                            }
                          />
                          <FieldLabel htmlFor={requiredEntryId}>Must appear in final resume</FieldLabel>
                        </Field>
                        <Button
                          onClick={() => removeRepeatItem("resume.skill_categories", index)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Remove skill category
                        </Button>
                      </div>
                      <AdaptiveFieldGrid>
                        <AdaptiveFieldSpan span="wide">
                          {textField(`resume.skill_categories.${index}.label`, "Label")}
                        </AdaptiveFieldSpan>
                      </AdaptiveFieldGrid>
                      <Separator />
                      <FieldGroup className="skill-list">
                        {skills.map((skill, skillIndex) => {
                          const skillId = editorControlId(
                            "profile",
                            `skill-category-${index}-skill-${skillIndex}`,
                          );
                          const requiredSkillId = `${skillId}-required`;
                          return (
                            <Field className="skill-row" key={`${entryId}-${skillIndex}`}>
                              <Field className="skill-input field">
                                <FieldLabel htmlFor={skillId}>Skill {skillIndex + 1}</FieldLabel>
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
                              <Field
                                className="choice skill-choice"
                                data-disabled={!entryId || !skill || undefined}
                                orientation="horizontal"
                              >
                                <Checkbox
                                  id={requiredSkillId}
                                  checked={requiredSkills.has(skill)}
                                  disabled={!entryId || !skill}
                                  onCheckedChange={(checked) =>
                                    setRequiredSkill(entryId, skill, checked)
                                  }
                                />
                                <FieldLabel htmlFor={requiredSkillId}>Required</FieldLabel>
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
                        <Button className="add-bullet" onClick={() => addSkill(index)} size="sm" type="button" variant="secondary">
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
          </DisclosureSection>

          <DisclosureSection
            className="profile-disclosure profile-disclosure--eeo"
            collapsedSummary="Gender · race or ethnicity · veteran status · disability status"
            defaultOpen={false}
            description="Optional demographic information"
            headingLevel={3}
            title="Voluntary EEO"
          >
            <AdaptiveFieldGrid>
              {textField("eeo_voluntary.gender", "Gender")}
              {textField("eeo_voluntary.race_ethnicity", "Race / ethnicity")}
              {textField("eeo_voluntary.veteran_status", "Veteran status")}
              {textField("eeo_voluntary.disability_status", "Disability status")}
            </AdaptiveFieldGrid>
          </DisclosureSection>
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
            title="Application configuration"
          >
            <AdaptiveFieldGrid>
              {applicationConfigurationFields}
              {yesNoCheckboxField(
                "work_authorization.legally_authorized_to_work",
                "Legally authorized to work",
              )}
              {yesNoCheckboxField("work_authorization.require_sponsorship", "Requires sponsorship")}
              {textField("work_authorization.work_permit_type", "Work permit type")}
              {textField("personal.password", "Job-site login password", "password", {
                autoComplete: "new-password",
              })}
              {textField("availability.earliest_start_date", "Earliest start date", "date")}
              {yesNoCheckboxField("availability.available_for_full_time", "Available full-time")}
              {yesNoCheckboxField("availability.available_for_contract", "Available for contract")}
              {textField("compensation.salary_expectation", "Salary expectation", "number", {
                min: 0,
                step: 1,
                valueKind: "text",
              })}
              {textField("compensation.salary_currency", "Salary currency")}
              {textField("compensation.salary_range_min", "Salary range min", "number", {
                min: 0,
                step: 1,
                valueKind: "text",
              })}
              {textField("compensation.salary_range_max", "Salary range max", "number", {
                min: 0,
                step: 1,
                valueKind: "text",
              })}
              {textField(
                "compensation.currency_conversion_note",
                "Currency conversion guidance",
                "text",
                {
                  helperText:
                    "Used for salary questions when a job posting lists compensation in a different currency.",
                },
              )}
            </AdaptiveFieldGrid>
          </DisclosureSection>

          <DisclosureSection
            className="preferences-disclosure preferences-disclosure--tailoring"
            collapsedSummary="Content rules · writing style · quality gates"
            defaultOpen
            description="Control what JobCtrl may change and how generated resumes are evaluated"
            headingLevel={3}
            title="Tailoring controls"
          >
            <Tabs className="tailoring-control-tabs" defaultValue="content-rules">
              <TabsList
                aria-label="Tailoring control sections"
                className="tailoring-control-tabs__list"
              >
                <TabsTrigger value="content-rules">Content rules</TabsTrigger>
                <TabsTrigger value="writing-style">Writing style</TabsTrigger>
                <TabsTrigger value="quality-gates">Quality gates</TabsTrigger>
              </TabsList>
              <TabsContent
                className="tailoring-tab-panel tailoring-tab-panel--content-rules"
                forceMount
                value="content-rules"
              >
                <FieldGroup className="tailoring-controls-grid tailoring-controls-grid--content">
                  {adjacentExperienceClaimsGroup()}
                  {generationPermissionsGroup()}
                  {bulletStandardsField()}
                </FieldGroup>
              </TabsContent>
              <TabsContent
                className="tailoring-tab-panel tailoring-tab-panel--writing-style"
                forceMount
                value="writing-style"
              >
                <FieldGroup className="tailoring-controls-grid tailoring-controls-grid--writing">
                  {writingStyleGroup()}
                  {additionalGuidanceGroup()}
                </FieldGroup>
              </TabsContent>
              <TabsContent
                className="tailoring-tab-panel tailoring-tab-panel--quality-gates"
                forceMount
                value="quality-gates"
              >
                <FieldGroup className="tailoring-controls-grid tailoring-controls-grid--quality">
                  {revisionPolicyGroup()}
                </FieldGroup>
              </TabsContent>
            </Tabs>
          </DisclosureSection>

          <DisclosureSection
            collapsedSummary="Typography · template · page layout"
            defaultOpen={false}
            description="Defaults for generated resumes outside the template workspace"
            headingLevel={3}
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
              {styleNumber("hints_column_width_cm", "Date column width (cm)", 1.5, 5, 0.1)}
            </AdaptiveFieldGrid>
          </DisclosureSection>
        </>
      )}
    </div>
  );
}

function delimitedListAt(value: string): string[] {
  const withoutLegacyLabel = value.replace(/^\s*Target roles?:\s*/i, "");
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
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeTargetSearchOption(value: string, options: readonly TargetSearchOption[]): string | null {
  const normalized = normalizeTargetSearchToken(value);
  const match = options.find((option) => {
    const optionTokens = [option.value, option.label, ...(option.aliases ?? [])];
    return optionTokens.some((token) => normalizeTargetSearchToken(token) === normalized);
  });
  return match?.value ?? null;
}

function normalizeTargetSearchToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
