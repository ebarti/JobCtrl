import { useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";

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

export interface StructuredProfileEditorProps {
  mode?: "profile" | "preferences";
  profileText: string;
  styleText: string;
  onProfileTextChange: (value: string) => void;
  onStyleTextChange: (value: string) => void;
}

export function StructuredProfileEditor({
  mode = "profile",
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
      <div className="banner inline">
        The structured editor needs valid profile data. Reload the profile after fixing the saved data.
      </div>
    );
  }

  const updateProfileDraft = (updater: (draft: JsonRecord) => void) => {
    const draft = cloneJsonRecord(profile);
    updater(draft);
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
    type = "text",
    attrs: Record<string, unknown> = {},
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        {...attrs}
        type={type}
        value={textAt(profile, path)}
        onChange={(event) =>
          updateProfilePath(
            path,
            type === "number" ? constrainedNumberOrEmpty(event.target.value, attrs) : event.target.value,
          )
        }
      />
    </label>
  );

  const constrainedNumberOrEmpty = (value: string, attrs: Record<string, unknown>) => {
    const parsed = numberOrEmpty(value);
    if (parsed === "" || typeof parsed !== "number") {
      return parsed;
    }
    if (!Number.isFinite(parsed)) {
      return "";
    }
    const min = typeof attrs["min"] === "number" ? attrs["min"] : undefined;
    const max = typeof attrs["max"] === "number" ? attrs["max"] : undefined;
    return Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
  };

  const years = profileYearOptions();

  const monthSelector = (
    label: string,
    value: ProfileMonthValue,
    onChange: (value: ProfileMonthValue) => void,
    disabled = false,
  ) => (
    <div className="month-selector">
      <span>{label}</span>
      <div className="month-selector-controls">
        <select
          aria-label={`${label} month`}
          disabled={disabled}
          value={value.month}
          onChange={(event) => onChange({ ...value, month: event.target.value })}
        >
          <option value="">Month</option>
          {PROFILE_MONTHS.map((month) => (
            <option key={month.value} value={month.value}>
              {month.label}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} year`}
          disabled={disabled}
          value={value.year}
          onChange={(event) => onChange({ ...value, year: event.target.value })}
        >
          <option value="">Year</option>
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  const monthField = (path: string, label: string) => {
    const value = parseProfileMonth(textAt(profile, path));
    return (
      <div className="field month-field">
        <span>{label}</span>
        <div className="month-field-body">
          {monthSelector(label, value, (next) => updateProfilePath(path, formatProfileMonth(next)))}
          <button
            className="tab"
            type="button"
            disabled={!value.month && !value.year}
            onClick={() => updateProfilePath(path, "")}
          >
            clear
          </button>
        </div>
      </div>
    );
  };

  const dateRangeField = (path: string, label: string) => {
    const value = parseProfileDateRange(textAt(profile, path));
    const hasError = !isProfileDateRangeChronological(value);
    const updateDateRange = (next: Partial<typeof value>) => {
      updateProfilePath(path, formatProfileDateRange({ ...value, ...next }));
    };
    return (
      <div className="field date-range-field wide">
        <span>{label}</span>
        <div className={`date-range-body${hasError ? " invalid" : ""}`}>
          {monthSelector("Start", value.start, (start) => updateDateRange({ start }))}
          {value.present
            ? null
            : monthSelector("End", value.end, (end) => updateDateRange({ end, present: false }))}
          <label className="choice date-range-present">
            <input
              type="checkbox"
              checked={value.present}
              onChange={(event) =>
                updateDateRange({
                  end: event.target.checked ? emptyProfileMonth() : value.end,
                  present: event.target.checked,
                })
              }
            />
            <span>Present</span>
          </label>
          <button
            className="tab"
            type="button"
            disabled={
              !value.start.month &&
              !value.start.year &&
              !value.end.month &&
              !value.end.year &&
              !value.present
            }
            onClick={() => updateProfilePath(path, "")}
          >
            clear
          </button>
        </div>
        {hasError ? <span className="field-error">End date must be after start date.</span> : null}
      </div>
    );
  };

  const selectField = (
    path: string,
    label: string,
    options: Array<[string, string]> | string[],
  ) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={textAt(profile, path)}
        onChange={(event) => updateProfilePath(path, event.target.value)}
      >
        {options.map((option) => {
          const value = Array.isArray(option) ? option[0] : option;
          const text = Array.isArray(option) ? option[1] : option;
          return (
            <option key={value} value={value}>
              {text}
            </option>
          );
        })}
      </select>
    </label>
  );

  const checkboxField = (path: string, label: string) => (
    <label className="field check">
      <input
        type="checkbox"
        checked={Boolean(getPathValue(profile, path))}
        onChange={(event) => updateProfilePath(path, event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );

  const textareaField = (path: string, label: string, placeholder = "") => (
    <label className="field wide">
      <span>{label}</span>
      <textarea
        placeholder={placeholder}
        value={textAt(profile, path)}
        onChange={(event) => updateProfilePath(path, event.target.value)}
      />
    </label>
  );

  const listField = (path: string, label: string) => (
    <label className="field wide">
      <span>{label}</span>
      <textarea
        value={textArrayAt(profile, path).join("\n")}
        onChange={(event) => updateProfilePath(path, lines(event.target.value))}
      />
    </label>
  );

  const delimitedListField = (
    path: string,
    label: string,
    addLabel: string,
    options: { compact?: boolean } = {},
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
      <div className="field wide inline-list-field">
        <span>{label}</span>
        <div className={`inline-list${options.compact ? " compact" : ""}`}>
          {values.map((value, index) => (
            <div className="inline-list-row" key={`${path}-${index}`}>
              <input
                aria-label={`${label} ${index + 1}`}
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
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                title="Remove"
                onClick={() => updateValues(values.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button className="tab add-bullet" type="button" onClick={appendValue}>
            <Plus size={14} aria-hidden="true" />
            {addLabel}
          </button>
        </div>
      </div>
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
      <div className="field wide target-location-model-field">
        <span>Target location: target work model</span>
        <div className="target-location-model-list">
          {rows.map((row, index) => (
            <div className="target-location-model-row" key={`${locationPath}-${index}`}>
              <input
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
              <fieldset className="target-work-model-group" aria-label={`Target work model ${index + 1}`}>
                {workModelOptions.map((value) => {
                  const checkboxId = `target-work-model-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                  return (
                    <label className="target-work-model-option" key={value} htmlFor={checkboxId}>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={commaListAt(row.workModel).includes(value)}
                        onChange={(event) => toggleWorkModel(index, value, event.target.checked)}
                      />
                      <span>{value}</span>
                    </label>
                  );
                })}
              </fieldset>
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove target location ${index + 1}`}
                title="Remove"
                onClick={() => updateRows(rows.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            className="tab add-bullet"
            type="button"
            onClick={appendRow}
          >
            <Plus size={14} aria-hidden="true" />
            add location
          </button>
        </div>
      </div>
    );
  };

  const styleSelect = (path: string, label: string, options: Array<[string, string]>) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={textAt(style, path)}
        onChange={(event) => updateStylePath(path, event.target.value)}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  const styleNumber = (path: string, label: string, min: number, max: number, step: number) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={textAt(style, path)}
        onChange={(event) => updateStylePath(path, numberOrEmpty(event.target.value))}
      />
    </label>
  );

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

  return (
    <div className="profile-sections">
      {mode === "profile" ? (
        <>
          <section className="form-section">
            <h3>Personal information</h3>
            <div className="field-grid">
              {textField("personal.full_name", "Full name", "text", { required: true })}
              {textField("personal.preferred_name", "Preferred name")}
              {textField("personal.email", "Email", "email", { required: true })}
              {textField("personal.phone", "Phone", "tel")}
              {textField("personal.address", "Address")}
              {textField("personal.city", "City")}
              {textField("personal.province_state", "State / province")}
              {textField("personal.country", "Country")}
              {textField("personal.postal_code", "Postal code")}
              {textField("personal.linkedin_url", "LinkedIn URL", "url")}
              {textField("personal.github_url", "GitHub URL", "url")}
              {textField("personal.portfolio_url", "Portfolio URL", "url")}
              {textField("personal.website_url", "Website URL", "url")}
            </div>
          </section>

          <section className="form-section">
            <h3>Resume baseline</h3>
            <div className="field-grid">
              {textField("experience.years_of_experience_total", "Total years of experience", "number", {
                min: 0,
                step: 1,
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
            </div>
            <div className="field-grid one">
              {textareaField("resume.executive_profile.baseline_text", "Executive profile baseline")}
              {listField("resume_constraints.real_metrics", "Verified resume metrics")}
            </div>
          </section>

          <section className="form-section">
        <h3>Experience entries</h3>
        <div className="repeat-list">
          {experienceEntries.map((entry, index) => {
            const entryId = textFrom(entry["id"]);
            const bullets = editableTextArrayAt(profile, `resume.experience_entries.${index}.bullets`);
            const requiredBullets = new Set(
              asTextArray(
                recordAt(profile, "resume.tailoring_rules.required_bullets_by_experience_id")[entryId],
              ),
            );
            return (
              <div className="repeat-card" key={`${entryId || "experience"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry["title"]) || `Experience ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        type="checkbox"
                        checked={requiredExperienceIds.has(entryId)}
                        disabled={!entryId}
                        onChange={(event) =>
                          setRequiredId(
                            "resume.tailoring_rules.required_experience_entry_ids",
                            entryId,
                            event.target.checked,
                          )
                        }
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button
                      className="tab"
                      type="button"
                      onClick={() => removeRepeatItem("resume.experience_entries", index)}
                    >
                      remove experience
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {dateRangeField(`resume.experience_entries.${index}.date_range`, "Date range")}
                  {textField(`resume.experience_entries.${index}.title`, "Title")}
                  {textField(`resume.experience_entries.${index}.company`, "Company")}
                  {textField(`resume.experience_entries.${index}.location`, "Location")}
                </div>
                <div className="bullet-list">
                  {bullets.map((bullet, bulletIndex) => (
                    <div className="bullet-row" key={`${entryId}-${bulletIndex}`}>
                      <div className="bullet-row-top">
                        <span className="bullet-label">Bullet {bulletIndex + 1}</span>
                        <label className="choice bullet-choice">
                          <input
                            type="checkbox"
                            checked={requiredBullets.has(bullet)}
                            disabled={!entryId || !bullet}
                            onChange={(event) =>
                              setRequiredBullet(entryId, bullet, event.target.checked)
                            }
                          />
                          <span>Required</span>
                        </label>
                      </div>
                      <textarea
                        aria-label={`Bullet ${bulletIndex + 1}`}
                        value={bullet}
                        onChange={(event) =>
                          updateProfilePath(
                            `resume.experience_entries.${index}.bullets.${bulletIndex}`,
                            event.target.value,
                          )
                        }
                      />
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Remove bullet ${bulletIndex + 1}`}
                        title="Remove bullet"
                        onClick={() => removeBullet(index, bulletIndex)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  <button className="tab add-bullet" type="button" onClick={() => addBullet(index)}>
                    <Plus size={14} aria-hidden="true" />
                    add bullet
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="tab"
            type="button"
            onClick={() => addRepeatItem("resume.experience_entries")}
          >
            add experience
          </button>
        </div>
          </section>

          <section className="form-section">
        <h3>Education</h3>
        <div className="repeat-list">
          {educationEntries.map((entry, index) => {
            const entryId = textFrom(entry["id"]);
            return (
              <div className="repeat-card" key={`${entryId || "education"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry["degree"]) || `Education ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        type="checkbox"
                        checked={requiredEducationIds.has(entryId)}
                        disabled={!entryId}
                        onChange={(event) =>
                          setRequiredId(
                            "resume.tailoring_rules.required_education_entry_ids",
                            entryId,
                            event.target.checked,
                          )
                        }
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button
                      className="tab"
                      type="button"
                      onClick={() => removeRepeatItem("resume.education_entries", index)}
                    >
                      remove education
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {monthField(`resume.education_entries.${index}.date`, "Completion month")}
                  {textField(`resume.education_entries.${index}.degree`, "Degree")}
                  {textField(`resume.education_entries.${index}.institution`, "Institution")}
                  {textField(`resume.education_entries.${index}.location`, "Location")}
                </div>
              </div>
            );
          })}
          <button
            className="tab"
            type="button"
            onClick={() => addRepeatItem("resume.education_entries")}
          >
            add education
          </button>
        </div>
          </section>

          <section className="form-section">
        <h3>Skill categories</h3>
        <div className="repeat-list">
          {skillCategories.map((entry, index) => {
            const entryId = textFrom(entry["id"]);
            const skills = editableTextArrayAt(profile, `resume.skill_categories.${index}.items`);
            const requiredSkills = new Set(
              asTextArray(
                recordAt(profile, "resume.tailoring_rules.required_skills_by_category_id")[entryId],
              ),
            );
            return (
              <div className="repeat-card" key={`${entryId || "skills"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry["label"]) || `Skill category ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        type="checkbox"
                        checked={requiredSkillIds.has(entryId)}
                        disabled={!entryId}
                        onChange={(event) =>
                          setRequiredId(
                            "resume.tailoring_rules.required_skill_category_ids",
                            entryId,
                            event.target.checked,
                          )
                        }
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button
                      className="tab"
                      type="button"
                      onClick={() => removeRepeatItem("resume.skill_categories", index)}
                    >
                      remove skill category
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {textField(`resume.skill_categories.${index}.label`, "Label")}
                </div>
                <div className="skill-list">
                  {skills.map((skill, skillIndex) => (
                    <div className="skill-row" key={`${entryId}-${skillIndex}`}>
                      <label className="skill-input field">
                        <span>Skill {skillIndex + 1}</span>
                        <input
                          value={skill}
                          onChange={(event) =>
                            updateProfilePath(
                              `resume.skill_categories.${index}.items.${skillIndex}`,
                              event.target.value,
                            )
                          }
                        />
                      </label>
                      <label className="choice skill-choice">
                        <input
                          type="checkbox"
                          checked={requiredSkills.has(skill)}
                          disabled={!entryId || !skill}
                          onChange={(event) =>
                            setRequiredSkill(entryId, skill, event.target.checked)
                          }
                        />
                        <span>Required</span>
                      </label>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Remove skill ${skillIndex + 1}`}
                        title="Remove skill"
                        onClick={() => removeSkill(index, skillIndex)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  <button className="tab add-bullet" type="button" onClick={() => addSkill(index)}>
                    <Plus size={14} aria-hidden="true" />
                    add skill
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="tab"
            type="button"
            onClick={() => addRepeatItem("resume.skill_categories")}
          >
            add skill category
          </button>
        </div>
          </section>

          <section className="form-section">
        <h3>Voluntary EEO</h3>
        <div className="field-grid">
          {textField("eeo_voluntary.gender", "Gender")}
          {textField("eeo_voluntary.race_ethnicity", "Race / ethnicity")}
          {textField("eeo_voluntary.veteran_status", "Veteran status")}
          {textField("eeo_voluntary.disability_status", "Disability status")}
        </div>
          </section>
        </>
      ) : (
        <>
          <section className="form-section">
            <h3>Application defaults</h3>
            <div className="field-grid">
              {selectField("work_authorization.legally_authorized_to_work", "Legally authorized to work", [
                "Yes",
                "No",
              ])}
              {selectField("work_authorization.require_sponsorship", "Requires sponsorship", ["No", "Yes"])}
              {textField("work_authorization.work_permit_type", "Work permit type")}
              {textField("personal.password", "Job-site login password", "password", {
                autoComplete: "new-password",
              })}
              {textField("availability.earliest_start_date", "Earliest start date", "date")}
              {selectField("availability.available_for_full_time", "Available full-time", ["Yes", "No"])}
              {selectField("availability.available_for_contract", "Available for contract", ["No", "Yes"])}
              {textField("compensation.salary_expectation", "Salary expectation", "number", {
                min: 0,
                step: 1000,
              })}
              {textField("compensation.salary_currency", "Salary currency")}
              {textField("compensation.salary_range_min", "Salary range min", "number", {
                min: 0,
                step: 1000,
              })}
              {textField("compensation.salary_range_max", "Salary range max", "number", {
                min: 0,
                step: 1000,
              })}
              {textField("compensation.currency_conversion_note", "Currency note")}
            </div>
          </section>

          <section className="form-section">
            <h3>Target search</h3>
            <div className="target-preferences-grid">
              {delimitedListField("experience.target_role", "Target roles", "add role", { compact: true })}
              {targetLocationWorkModelField()}
            </div>
          </section>

          <section className="form-section">
            <h3>Tailoring controls</h3>
            <div className="field-grid">
              {selectField("resume.tailoring_rules.tailoring_policy.mode", "Tailoring mode", [
                ["strict", "Strict"],
                ["balanced", "Balanced"],
                ["aggressive", "Aggressive"],
              ])}
              {selectField("resume.tailoring_rules.writing_style.tone", "Writing tone", [
                ["direct", "Direct"],
                ["executive", "Executive"],
                ["technical", "Technical"],
                ["confident", "Confident"],
                ["warm", "Warm"],
              ])}
              {selectField("resume.tailoring_rules.writing_style.bullet_style", "Bullet style", [
                ["balanced", "Balanced"],
                ["impact", "Impact"],
                ["technical_depth", "Technical depth"],
                ["leadership", "Leadership"],
              ])}
              {selectField("resume.tailoring_rules.writing_style.verbosity", "Verbosity", [
                ["concise", "Concise"],
                ["balanced", "Balanced"],
                ["detailed", "Detailed"],
              ])}
              {selectField("resume.tailoring_rules.writing_style.keyword_density", "Keyword density", [
                ["natural", "Natural"],
                ["moderate", "Moderate"],
                ["high", "High"],
              ])}
              {checkboxField(
                "resume.tailoring_rules.writing_style.avoid_first_person",
                "Avoid first-person language",
              )}
              {checkboxField(
                "resume.tailoring_rules.tailoring_policy.allow_summary_rewrite",
                "AI may rewrite the executive summary",
              )}
              {checkboxField(
                "resume.tailoring_rules.tailoring_policy.allow_title_reframing",
                "AI may reframe experience titles",
              )}
              {checkboxField(
                "resume.tailoring_rules.tailoring_policy.allow_achievement_rewriting",
                "AI may rewrite achievement bullets",
              )}
              {checkboxField(
                "resume.tailoring_rules.tailoring_policy.allow_skill_reordering",
                "AI may reorder or trim skill items",
              )}
              {checkboxField(
                "resume.tailoring_rules.tailoring_policy.allow_minor_inference",
                "AI may make minor inferred phrasing",
              )}
            </div>
            <div className="field-grid one">
              {textareaField(
                "resume.tailoring_rules.custom_tailoring_prompt",
                "Additional tailoring prompt",
                "Optional guidance injected into every resume tailoring prompt.",
              )}
            </div>
          </section>

          <section className="form-section">
            <h3>Resume style</h3>
            <div className="field-grid">
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
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function delimitedListAt(value: string): string[] {
  const withoutLegacyLabel = value.replace(/^\s*Target roles?:\s*/i, "");
  if (!withoutLegacyLabel.trim()) {
    return [""];
  }
  return withoutLegacyLabel.split(";").map((item) => item.trim());
}

function commaListAt(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
