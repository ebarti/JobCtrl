import type {
  ExtensionAutofillProfileField,
  ExtensionAutofillProfileResponse,
} from "@jobhunter/contracts";

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface FieldTarget {
  id: string;
  descriptor: string;
  control: FormControl;
}

export interface AutofillSuggestion {
  id: string;
  target: FieldTarget;
  profilePath: string;
  profileLabel: string;
  sourceLabel: string;
  value: string;
  status: "missing" | "suggested";
}

interface FieldRule {
  path: string;
  label: string;
  patterns: RegExp[];
  excludePatterns?: RegExp[];
  transform?: "first_name" | "last_name";
}

export type AutofillReviewResponse =
  | { ok: true; status: "review_opened"; suggestions: number; missing: number }
  | { ok: false; error: string; message: string };

const FIELD_RULES: FieldRule[] = [
  { path: "personal.email", label: "Email", patterns: [/\bemail\b/] },
  { path: "personal.full_name", label: "First name", patterns: [/\bfirst\s*name\b|\bgiven\s*name\b/], transform: "first_name" },
  { path: "personal.full_name", label: "Last name", patterns: [/\blast\s*name\b|\bfamily\s*name\b|\bsurname\b/], transform: "last_name" },
  { path: "personal.full_name", label: "Full name", patterns: [/\bfull\s*name\b|\blegal\s*name\b|\bcandidate\s*name\b|\bapplicant\s*name\b|\byour\s*name\b/] },
  { path: "personal.phone", label: "Phone", patterns: [/\bphone\b|\bmobile\b|\btelephone\b/] },
  {
    path: "personal.address",
    label: "Street address",
    patterns: [/\bstreet\s*address\b|\baddress\s*(?:line\s*)?1\b|\baddress\b|\bstreet\b/],
    excludePatterns: [/\baddress\s*(?:line\s*)?2\b|\baddress\s*2\b|\bapt\b|\bapartment\b|\bunit\b|\bsuite\b/],
  },
  { path: "personal.city", label: "City", patterns: [/\bcity\b/] },
  { path: "personal.province_state", label: "State / province", patterns: [/\bstate\b|\bprovince\b|\bregion\b/] },
  { path: "personal.country", label: "Country", patterns: [/\bcountry\b/], excludePatterns: [/\bcitizenship\b|\bnationality\b|\bpassport\b/] },
  { path: "personal.postal_code", label: "Postal code", patterns: [/\bpostal\b|\bzip\b/] },
  { path: "personal.linkedin_url", label: "LinkedIn URL", patterns: [/\blinkedin\b/] },
  { path: "personal.github_url", label: "GitHub URL", patterns: [/\bgithub\b/] },
  { path: "personal.portfolio_url", label: "Portfolio URL", patterns: [/\bportfolio\b/] },
  { path: "personal.website_url", label: "Website URL", patterns: [/\bwebsite\b|\bpersonal\s*site\b/] },
  { path: "work_authorization.legally_authorized_to_work", label: "Legally authorized to work", patterns: [/\bauthori[sz]ed\b.*\bwork\b|\blegally\b.*\bwork\b/] },
  { path: "work_authorization.require_sponsorship", label: "Requires sponsorship", patterns: [/\bsponsorship\b|\bvisa\b.*\bsponsor\b/] },
  { path: "work_authorization.work_permit_type", label: "Work permit type", patterns: [/\bwork\s*permit\b|\bvisa\s*type\b/] },
  { path: "compensation.salary_expectation", label: "Salary expectation", patterns: [/\bsalary\b|\bcompensation\b|\bexpected\s*pay\b/] },
  { path: "availability.earliest_start_date", label: "Earliest start date", patterns: [/\bstart\s*date\b|\bavailable\s*from\b/] },
  {
    path: "availability.available_for_full_time",
    label: "Available for full time",
    patterns: [/\bavailable\b.*\bfull[\s-]*time\b|\bfull[\s-]*time\b.*\bavailable\b|\bopen\b.*\bfull[\s-]*time\b|\bfull[\s-]*time\b.*\bavailability\b/],
    excludePatterns: [/\bemployment\s*type\b|\bjob\s*type\b|\bposition\s*type\b/],
  },
  {
    path: "availability.available_for_contract",
    label: "Available for contract",
    patterns: [/\bavailable\b.*\bcontract\b|\bcontract\b.*\bavailable\b|\bopen\b.*\bcontract\b|\bcontract\b.*\bavailability\b/],
    excludePatterns: [/\bcontract\s*type\b|\bcontract\s*terms?\b|\baccept\b.*\bcontract\b|\bagree\b.*\bcontract\b/],
  },
  { path: "eeo_voluntary.gender", label: "Gender", patterns: [/\bgender\b/] },
  { path: "eeo_voluntary.race_ethnicity", label: "Race / ethnicity", patterns: [/\brace\b|\bethnicity\b/] },
  { path: "eeo_voluntary.veteran_status", label: "Veteran status", patterns: [/\bveteran\b/] },
  { path: "eeo_voluntary.disability_status", label: "Disability status", patterns: [/\bdisability\b/] },
];

declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void,
      ): void;
    };
  };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isAutofillMessage(message)) {
    const result = showAutofillReview(message.profile);
    sendResponse(result);
    return true;
  }
  return undefined;
});

export function showAutofillReview(
  profile: ExtensionAutofillProfileResponse,
  doc: Document = document,
  pageUrl = location.href,
): AutofillReviewResponse {
  if (!detectSupportedAts(pageUrl)) {
    renderOverlay(doc, [], "This page is not a supported ATS application form.");
    return { ok: false, error: "unsupported_ats", message: "This page is not a supported ATS application form." };
  }
  const suggestions = buildAutofillSuggestions(profile.fields, collectFieldTargets(doc));
  const missing = suggestions.filter((suggestion) => suggestion.status === "missing").length;
  renderOverlay(doc, suggestions, suggestions.length ? null : "No supported fields were detected on this form.");
  return { ok: true, status: "review_opened", suggestions: suggestions.length - missing, missing };
}

export function collectFieldTargets(root: ParentNode = document): FieldTarget[] {
  const controls = Array.from(root.querySelectorAll("input, select, textarea")).filter(isFillableControl);
  return controls.map((control, index) => ({
    id: `jh-field-${index}`,
    descriptor: fieldDescriptor(control),
    control,
  }));
}

export function buildAutofillSuggestions(
  fields: readonly ExtensionAutofillProfileField[],
  targets: readonly FieldTarget[],
): AutofillSuggestion[] {
  const suggestions: AutofillSuggestion[] = [];
  const seenLogicalTargets = new Set<string>();
  for (const target of targets) {
    const rule = FIELD_RULES.find((candidate) => matchesRule(candidate, target.descriptor));
    if (!rule) {
      continue;
    }
    const suggestionKey = logicalSuggestionKey(target, rule);
    if (seenLogicalTargets.has(suggestionKey)) {
      continue;
    }
    seenLogicalTargets.add(suggestionKey);
    const field = fields.find((candidate) => candidate.path === rule.path);
    const value = field ? transformValue(field.value, rule.transform) : "";
    suggestions.push({
      id: `${target.id}:${rule.path}:${rule.transform ?? "value"}`,
      target,
      profilePath: rule.path,
      profileLabel: rule.label,
      sourceLabel: field?.source.label ?? rule.label,
      value,
      status: value ? "suggested" : "missing",
    });
  }
  return suggestions;
}

export function applyAcceptedSuggestions(suggestions: readonly AutofillSuggestion[]): number {
  let filled = 0;
  for (const suggestion of suggestions) {
    if (suggestion.status !== "suggested") {
      continue;
    }
    if (setControlValue(suggestion.target.control, suggestion.value)) {
      filled += 1;
    }
  }
  return filled;
}

function renderOverlay(doc: Document, suggestions: AutofillSuggestion[], emptyMessage: string | null): void {
  doc.getElementById("jobhunter-autofill-root")?.remove();
  const root = doc.createElement("aside");
  root.id = "jobhunter-autofill-root";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "JobHunter autofill suggestions");
  Object.assign(root.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    width: "360px",
    maxHeight: "80vh",
    overflow: "auto",
    border: "1px solid #94a3b8",
    borderRadius: "8px",
    padding: "12px",
    color: "#0f172a",
    background: "#ffffff",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.24)",
    font: "14px system-ui, sans-serif",
  });
  const title = doc.createElement("h2");
  title.textContent = "JobHunter autofill";
  Object.assign(title.style, { margin: "0 0 8px", fontSize: "16px" });
  root.append(title);

  if (emptyMessage) {
    const empty = doc.createElement("p");
    empty.textContent = emptyMessage;
    root.append(empty);
  } else {
    const form = doc.createElement("form");
    const selectedSuggestionIndexes = new Set<number>();
    form.addEventListener("submit", (event) => event.preventDefault());
    suggestions.forEach((suggestion, index) => {
      const label = doc.createElement("label");
      Object.assign(label.style, { display: "block", margin: "8px 0", lineHeight: "1.3" });
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = suggestion.status === "suggested";
      checkbox.disabled = suggestion.status === "missing";
      checkbox.dataset.suggestionIndex = String(index);
      if (suggestion.status === "suggested") {
        selectedSuggestionIndexes.add(index);
      }
      checkbox.addEventListener("change", (event) => {
        if (!event.isTrusted) {
          checkbox.checked = selectedSuggestionIndexes.has(index);
          return;
        }
        if (checkbox.checked) {
          selectedSuggestionIndexes.add(index);
        } else {
          selectedSuggestionIndexes.delete(index);
        }
      });
      label.append(checkbox, ` ${suggestion.profileLabel}`);
      const detail = doc.createElement("div");
      const formField = suggestion.target.descriptor ? `Form field: ${suggestion.target.descriptor}` : "Form field: detected control";
      detail.textContent =
        suggestion.status === "suggested"
          ? `Profile value ready · ${suggestion.sourceLabel} · ${formField}`
          : `Not in your profile · ${suggestion.sourceLabel} · ${formField}`;
      Object.assign(detail.style, { color: "#475569", fontSize: "12px", marginLeft: "22px" });
      label.append(detail);
      form.append(label);
    });
    const fill = doc.createElement("button");
    fill.type = "button";
    fill.textContent = "Fill selected";
    fill.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        status.textContent = "Use the extension review control to fill selected fields.";
        return;
      }
      const selected = suggestions.filter(
        (suggestion, index) => suggestion.status === "suggested" && selectedSuggestionIndexes.has(index),
      );
      const count = applyAcceptedSuggestions(selected);
      status.textContent = `Filled ${count} field${count === 1 ? "" : "s"}. Review the form before submitting.`;
    });
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => root.remove());
    Object.assign(close.style, { marginLeft: "8px" });
    const status = doc.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "Review each value before filling.";
    Object.assign(status.style, { color: "#475569", fontSize: "12px" });
    form.append(fill, close, status);
    root.append(form);
  }
  doc.body.append(root);
}

function setControlValue(control: FormControl, value: string): boolean {
  if (!isFillableControl(control)) {
    return false;
  }
  if (control instanceof HTMLSelectElement) {
    const option = Array.from(control.options).find((candidate) => optionMatches(candidate, value));
    if (!option) {
      return false;
    }
    control.value = option.value;
  } else if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
    if (control.type === "radio") {
      return setRadioValue(control, value);
    }
    return setCheckboxValue(control, value);
  } else {
    control.value = value;
  }
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function isFillableControl(control: Element): control is FormControl {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (control.disabled) {
    return false;
  }
  if (control.matches(":disabled")) {
    return false;
  }
  if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && control.readOnly) {
    return false;
  }
  if (control instanceof HTMLInputElement) {
    if (["button", "file", "hidden", "image", "password", "reset", "submit"].includes(control.type)) {
      return false;
    }
  }
  return isVisibleUserEditableControl(control);
}

function isVisibleUserEditableControl(control: FormControl): boolean {
  if (!control.isConnected) {
    return false;
  }
  const view = control.ownerDocument.defaultView;
  if (!view) {
    return true;
  }
  for (let current: Element | null = control; current; current = current.parentElement) {
    if (!(current instanceof view.HTMLElement)) {
      continue;
    }
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = view.getComputedStyle(current);
    const clipPath = style.clipPath;
    const clip = style.clip;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0" ||
      style.pointerEvents === "none" ||
      (clipPath !== "" && clipPath !== "none") ||
      (clip !== "" && clip !== "auto")
    ) {
      return false;
    }
  }
  return hasVisibleRenderedBox(control, view);
}

function hasVisibleRenderedBox(control: FormControl, view: Window): boolean {
  const rects = Array.from(control.getClientRects());
  const candidates = rects.length > 0 ? rects : [control.getBoundingClientRect()];
  return candidates.some((rect) => isVisibleRect(rect) && intersectsViewport(rect, view));
}

function isVisibleRect(rect: DOMRect | DOMRectReadOnly): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) &&
    rect.width >= 1 &&
    rect.height >= 1
  );
}

function intersectsViewport(rect: DOMRect | DOMRectReadOnly, view: Window): boolean {
  const width = view.innerWidth || controlViewportWidth(view);
  const height = view.innerHeight || controlViewportHeight(view);
  if (width <= 0 || height <= 0) {
    return true;
  }
  return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
}

function controlViewportWidth(view: Window): number {
  return view.document.documentElement.clientWidth || view.document.body.clientWidth || 0;
}

function controlViewportHeight(view: Window): number {
  return view.document.documentElement.clientHeight || view.document.body.clientHeight || 0;
}

function fieldDescriptor(control: FormControl): string {
  return normalize(
    [
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("autocomplete"),
      control.getAttribute("name"),
      control.id,
      ...Array.from(control.labels ?? []).map((label) => label.textContent),
      closestLabel(control),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function closestLabel(control: FormControl): string {
  const label = control.closest("label");
  return label?.textContent ?? "";
}

function transformValue(value: string, transform: FieldRule["transform"]): string {
  if (!transform) return value;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (transform === "first_name") return parts[0] ?? "";
  if (transform === "last_name") return parts.slice(1).join(" ");
  return value;
}

function optionMatches(option: HTMLOptionElement, value: string): boolean {
  return answerMatchesOption(value, normalize(`${option.value} ${option.textContent ?? ""}`));
}

function setRadioValue(control: HTMLInputElement, value: string): boolean {
  const match = radioGroupControls(control)
    .filter(isFillableControl)
    .find((candidate) => answerMatchesOption(value, inputOptionDescriptor(candidate)));
  if (!match) {
    return false;
  }
  for (const radio of radioGroupControls(control)) {
    radio.checked = radio === match;
  }
  dispatchFormEvents(match);
  return true;
}

function setCheckboxValue(control: HTMLInputElement, value: string): boolean {
  const group = checkboxGroupControls(control).filter(isFillableControl);
  if (group.length > 1) {
    const match = group.find((candidate) => answerMatchesOption(value, inputOptionDescriptor(candidate)));
    if (!match) {
      return false;
    }
    match.checked = true;
    dispatchFormEvents(match);
    return true;
  }

  const booleanValue = parseBooleanAnswer(value);
  if (booleanValue === null && !answerMatchesOption(value, inputOptionDescriptor(control))) {
    return false;
  }
  control.checked = booleanValue ?? true;
  dispatchFormEvents(control);
  return true;
}

function radioGroupControls(control: HTMLInputElement): HTMLInputElement[] {
  if (!control.name) {
    return [control];
  }
  const root = control.form ?? control.ownerDocument;
  return Array.from(root.querySelectorAll<HTMLInputElement>("input[type='radio']")).filter(
    (candidate) => candidate.name === control.name,
  );
}

function checkboxGroupControls(control: HTMLInputElement): HTMLInputElement[] {
  if (!control.name) {
    return [control];
  }
  const root = control.form ?? control.ownerDocument;
  const group = Array.from(root.querySelectorAll<HTMLInputElement>("input[type='checkbox']")).filter(
    (candidate) => candidate.name === control.name,
  );
  return group.length > 0 ? group : [control];
}

function inputOptionDescriptor(control: HTMLInputElement): string {
  return normalize(
    [
      control.value,
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      ...Array.from(control.labels ?? []).map((label) => label.textContent),
      closestLabel(control),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function answerMatchesOption(value: string, optionText: string): boolean {
  const option = tokenizeNormalized(optionText).join(" ");
  if (!option) {
    return false;
  }
  return answerMatchCandidates(value).some((candidate) => normalizedPhraseIncludes(option, candidate));
}

function answerMatchCandidates(value: string): string[] {
  const normalized = normalize(value);
  const booleanValue = parseBooleanAnswer(value);
  if (booleanValue === true) {
    return ["yes", "true", "y", "1"];
  }
  if (booleanValue === false) {
    return ["no", "false", "n", "0"];
  }
  return normalized ? [normalized] : [];
}

function normalizedPhraseIncludes(option: string, candidate: string): boolean {
  const normalizedCandidate = tokenizeNormalized(candidate).join(" ");
  if (!normalizedCandidate) {
    return false;
  }
  return option === normalizedCandidate || ` ${option} `.includes(` ${normalizedCandidate} `);
}

function parseBooleanAnswer(value: string): boolean | null {
  const normalized = tokenizeNormalized(value).join(" ");
  if (["yes", "true", "y", "1", "authorized", "legally authorized", "eligible"].includes(normalized)) {
    return true;
  }
  if (
    ["no", "false", "n", "0", "not authorized", "unauthorized", "not eligible", "ineligible"].includes(normalized)
  ) {
    return false;
  }
  return null;
}

function tokenizeNormalized(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter(Boolean);
}

function matchesRule(rule: FieldRule, descriptor: string): boolean {
  return (
    rule.patterns.some((pattern) => pattern.test(descriptor)) &&
    !(rule.excludePatterns ?? []).some((pattern) => pattern.test(descriptor))
  );
}

function logicalSuggestionKey(target: FieldTarget, rule: FieldRule): string {
  const control = target.control;
  if (control instanceof HTMLInputElement && control.type === "radio" && control.name) {
    return `radio:${formScopeIndex(control)}:${control.name}:${rule.path}:${rule.transform ?? "value"}`;
  }
  return `${target.id}:${rule.path}:${rule.transform ?? "value"}`;
}

function formScopeIndex(control: HTMLInputElement): number {
  if (!control.form) {
    return -1;
  }
  return Array.from(control.ownerDocument.forms).indexOf(control.form);
}

function dispatchFormEvents(control: FormControl): void {
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function detectSupportedAts(urlText: string | undefined): boolean {
  if (!urlText) {
    return false;
  }
  try {
    const host = new URL(urlText).hostname.toLowerCase();
    return (
      host.endsWith("myworkdayjobs.com") ||
      host === "boards.greenhouse.io" ||
      host.endsWith(".greenhouse.io") ||
      host === "jobs.lever.co" ||
      host.endsWith(".lever.co") ||
      host === "jobs.ashbyhq.com" ||
      host.endsWith(".ashbyhq.com")
    );
  } catch {
    return false;
  }
}

function isAutofillMessage(value: unknown): value is {
  type: "jobhunter.autofill.review";
  profile: ExtensionAutofillProfileResponse;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).type === "jobhunter.autofill.review" &&
      isProfileResponse((value as Record<string, unknown>).profile),
  );
}

function isProfileResponse(value: unknown): value is ExtensionAutofillProfileResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).ok === true &&
      Array.isArray((value as Record<string, unknown>).fields),
  );
}
