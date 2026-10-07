import { FormMappingResponseSchema, type FormQuestion, type FormSnapshot, type FormMappingResponse } from "@jobctrl/contracts";
import type {
  DiscoveryBrowserRequest,
  DiscoveryBrowserTaskResult,
  ExtensionAutofillProfileField,
  ExtensionAutofillProfileResponse,
} from "@jobctrl/contracts";

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
  optionId: string | null;
  question: FormQuestion;
  rationale: string;
}

export type AutofillReviewResponse =
  | { ok: true; status: "review_opened"; suggestions: number; missing: number }
  | { ok: false; error: string; message: string };

let capturedForm:{snapshot:FormSnapshot;targets:FieldTarget[]}|null=null;

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
  if (isDiscoveryProbeMessage(message)) {
    sendResponse({ ok: true, status: "discovery_ready" });
    return true;
  }
  if (isDiscoverySnapshotMessage(message)) {
    void captureRenderedPageSnapshotResponse().then(sendResponse);
    return true;
  }
  if (isDiscoveryFetchMessage(message)) {
    void executeDiscoveryHttpRequest(message.request).then(sendResponse, (error: unknown) => {
      sendResponse(discoveryFailure("request_failed", error, true));
    });
    return true;
  }
  if (message && typeof message==="object" && (message as Record<string,unknown>).type==="jobctrl.autofill.capture"){
    sendResponse(captureAutofillForm());return true;
  }
  if (isAutofillProbeMessage(message)) {
    sendResponse({ ok: true, status: "autofill_ready" });
    return true;
  }
  if (isAutofillMessage(message)) {
    const result = showAutofillReview(message.profile,message.mapping);
    sendResponse(result);
    return true;
  }
  return undefined;
});

export function showAutofillReview(
  profile: ExtensionAutofillProfileResponse,
  mapping: FormMappingResponse,
  doc: Document = document,
  pageUrl = location.href,
): AutofillReviewResponse {
  if (!isHttpUrl(pageUrl)) {
    renderOverlay(doc, [], "JobCtrl autofill is available only on http(s) application forms.");
    return {
      ok: false,
      error: "unsupported_page",
      message: "JobCtrl autofill is available only on http(s) application forms.",
    };
  }
  if(!capturedForm || capturedForm.snapshot.snapshotId!==mapping.snapshotId || profile.profileVersion!==mapping.profileVersion || capturedForm.snapshot.pageUrl!==pageUrl || JSON.stringify(capturedForm.snapshot.questions)!==JSON.stringify(questionsForTargets(capturedForm.targets)))return {ok:false,error:"stale_form_snapshot",message:"The form changed; reopen autofill review."};
  const suggestions = buildAutofillSuggestions(profile.fields,capturedForm.targets,mapping);
  const missing = suggestions.filter((suggestion) => suggestion.status === "missing").length;
  renderOverlay(doc, suggestions, suggestions.length ? null : "No supported fields were detected on this form.");
  return { ok: true, status: "review_opened", suggestions: suggestions.length - missing, missing };
}

export function collectFieldTargets(root: ParentNode = document): FieldTarget[] {
  const controls = Array.from(root.querySelectorAll("input, select, textarea")).filter(isFillableControl);
  const seenGroups=new Set<string>();
  return controls.filter(control=>{
    if(!(control instanceof HTMLInputElement) || control.type!=="radio" || !control.name)return true;
    const group=JSON.stringify([control.form?Array.from(control.ownerDocument.forms).indexOf(control.form):-1,control.name]);
    if(seenGroups.has(group))return false;seenGroups.add(group);return true;
  }).map((control, index) => ({
    id: `jh-field-${index}`,
    descriptor: fieldDescriptor(control),
    control,
  }));
}

export function captureAutofillForm(doc:Document=document,pageUrl=location.href):FormSnapshot{
  const targets=collectFieldTargets(doc);
  const snapshot:FormSnapshot={snapshotId:Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join(""),pageUrl,questions:questionsForTargets(targets)};
  capturedForm={snapshot,targets};return snapshot;
}

function questionsForTargets(targets:readonly FieldTarget[]):FormQuestion[]{
  return targets.map(target=>{
    const control=target.control;
    let control_type:FormQuestion["control_type"]="text";
    let options:FormQuestion["options"]=[];
    if(control instanceof HTMLSelectElement){control_type="select";options=Array.from(control.options).map((option,index)=>({option_id:`${target.id}:option:${index}`,label:`${option.textContent??""} [${option.value}]`}));}
    else if(control instanceof HTMLInputElement && control.type==="radio") {control_type="radio";options=radioGroupControls(control).filter(isFillableControl).map((option,index)=>({option_id:`${target.id}:option:${index}`,label:inputOptionDescriptor(option)}));}
    else if(control instanceof HTMLInputElement && control.type==="checkbox"){control_type="checkbox";options=[{option_id:`${target.id}:checked:true`,label:`Checked: ${fieldDescriptor(control)}`},{option_id:`${target.id}:checked:false`,label:`Unchecked: ${fieldDescriptor(control)}`}];}
    return {question_id:target.id,descriptor:fieldDescriptor(control),control_type,options};
  });
}

export function buildAutofillSuggestions(fields:readonly ExtensionAutofillProfileField[],targets:readonly FieldTarget[],mapping:FormMappingResponse):AutofillSuggestion[]{
  const questions=questionsForTargets(targets);
  return mapping.mappings.filter(row=>row.decision!=="unmapped").map(row=>{
    const target=targets.find(target=>target.id===row.question_id);
    const question=questions.find(question=>question.question_id===row.question_id);
    const field=fields.find(field=>field.path===row.fact_id);
    if(!target || !question || (row.decision==="mapped" && !field))throw new Error("Invalid form mapping binding.");
    return {id:row.question_id,target,question,profilePath:row.fact_id??"",profileLabel:field?.label??target.descriptor,sourceLabel:field?.source.label??"Saved profile",value:row.value,optionId:row.option_id,rationale:row.rationale,status:row.decision==="mapped"?"suggested":"missing"};
  });
}

export function applyAcceptedSuggestions(suggestions: readonly AutofillSuggestion[]): number {
  let filled = 0;
  for (const suggestion of suggestions) {
    if (suggestion.status !== "suggested") {
      continue;
    }
    if (setControlValue(suggestion)) {
      filled += 1;
    }
  }
  return filled;
}

function renderOverlay(doc: Document, suggestions: AutofillSuggestion[], emptyMessage: string | null): void {
  doc.getElementById("jobctrl-autofill-root")?.remove();
  const root = doc.createElement("aside");
  root.id = "jobctrl-autofill-root";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "JobCtrl autofill suggestions");
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
  title.textContent = "JobCtrl autofill";
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

function setControlValue(suggestion:AutofillSuggestion):boolean{
  const control=suggestion.target.control;
  if(!isFillableControl(control) || JSON.stringify(questionsForTargets([suggestion.target])[0])!==JSON.stringify(suggestion.question))return false;
  const optionIndex=suggestion.question.options.findIndex(option=>option.option_id===suggestion.optionId);
  if(control instanceof HTMLSelectElement){
    const option=control.options[optionIndex];if(!option || option.disabled)return false;control.selectedIndex=optionIndex;
  }else if(control instanceof HTMLInputElement && control.type==="radio"){
    const group=radioGroupControls(control).filter(isFillableControl);const selected=group[optionIndex];if(!selected)return false;
    for(const radio of group)radio.checked=radio===selected;dispatchFormEvents(selected);return true;
  }else if(control instanceof HTMLInputElement && control.type==="checkbox"){
    if(optionIndex<0)return false;control.checked=optionIndex===0;
  }else{if(suggestion.optionId!==null)return false;control.value=suggestion.value;}
  dispatchFormEvents(control);return true;
}

function isFillableControl(control: Element): control is FormControl {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (control.closest("#jobctrl-autofill-root"))return false;
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
  return isVisibleElement(control);
}

function isVisibleElement(control: HTMLElement): boolean {
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

function hasVisibleRenderedBox(control: HTMLElement, view: Window): boolean {
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

function radioGroupControls(control: HTMLInputElement): HTMLInputElement[] {
  if (!control.name) {
    return [control];
  }
  const root = control.form ?? control.ownerDocument;
  return Array.from(root.querySelectorAll<HTMLInputElement>("input[type='radio']")).filter(
    (candidate) => candidate.name === control.name,
  );
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

function dispatchFormEvents(control: FormControl): void {
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isHttpUrl(urlText: string | undefined): boolean {
  if (!urlText) {
    return false;
  }
  try {
    const protocol = new URL(urlText).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isAutofillProbeMessage(value: unknown): value is { type: "jobctrl.autofill.probe" } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).type === "jobctrl.autofill.probe",
  );
}

function isDiscoveryProbeMessage(value: unknown): value is { type: "jobctrl.discovery.probe" } {
  return messageType(value) === "jobctrl.discovery.probe";
}

function isDiscoverySnapshotMessage(value: unknown): value is { type: "jobctrl.discovery.snapshot" } {
  return messageType(value) === "jobctrl.discovery.snapshot";
}

function isDiscoveryFetchMessage(value: unknown): value is {
  type: "jobctrl.discovery.fetch";
  request: Extract<DiscoveryBrowserRequest, { mode: "http_request" }>;
} {
  if (messageType(value) !== "jobctrl.discovery.fetch") return false;
  const request = (value as Record<string, unknown>).request;
  if (!request || typeof request !== "object") return false;
  const candidate = request as Record<string, unknown>;
  return (
    candidate.mode === "http_request" &&
    (candidate.method === "GET" || candidate.method === "POST") &&
    typeof candidate.url === "string" &&
    Boolean(candidate.headers && typeof candidate.headers === "object")
  );
}

function messageType(value: unknown): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>).type : undefined;
}

export async function executeDiscoveryHttpRequest(
  request: Extract<DiscoveryBrowserRequest, { mode: "http_request" }>,
): Promise<DiscoveryBrowserTaskResult> {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return discoveryFailure("unsupported_page", new Error("The Discovery URL is invalid."), false);
  }
  if (!isSafePublicPageUrl(target) || target.origin !== location.origin) {
    return discoveryFailure(
      "unsupported_page",
      new Error("Discovery browser requests must stay on the active public page origin."),
      false,
    );
  }
  try {
    const response = await fetch(target.href, {
      method: request.method,
      headers: sanitizeDiscoveryHeaders(request.headers),
      ...(request.method === "POST" && request.body !== undefined ? { body: request.body } : {}),
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    const finalUrl = new URL(response.url || target.href);
    if (!isSafePublicPageUrl(finalUrl) || finalUrl.origin !== target.origin) {
      return discoveryFailure("unsafe_redirect", new Error("Discovery request redirected outside the public web."), false);
    }
    const bodyText = await readBoundedResponseText(response, 4_000_000);
    return {
      status: "succeeded",
      finalUrl: finalUrl.href,
      statusCode: response.status,
      contentType: response.headers.get("content-type")?.slice(0, 300) ?? "",
      title: "",
      browserUserAgent: navigator.userAgent.slice(0, 500),
      bodyText,
    };
  } catch (error) {
    if (error instanceof DiscoveryResponseTooLargeError) {
      return discoveryFailure("response_too_large", error, false);
    }
    return discoveryFailure("request_failed", error, true);
  }
}

export function captureRenderedPageSnapshot(): DiscoveryBrowserTaskResult {
  let finalUrl: URL;
  try {
    finalUrl = new URL(location.href);
  } catch {
    return discoveryFailure("unsupported_page", new Error("The rendered page URL is invalid."), false);
  }
  if (!isSafePublicPageUrl(finalUrl)) {
    return discoveryFailure("unsafe_redirect", new Error("Rendered Discovery page is not a public HTTP(S) URL."), false);
  }
  const bodyText = truncateUtf8(
    document.body?.innerText ?? document.documentElement?.textContent ?? "",
    4_000_000,
  );
  const bodyHtml = truncateUtf8(document.documentElement?.outerHTML ?? "", 4_000_000);
  if (!bodyText.trim() && !bodyHtml.trim()) {
    return discoveryFailure("unsupported_page", new Error("The rendered page exposed no readable content."), true);
  }
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const responseStatus = navigation?.responseStatus;
  return {
    status: "succeeded",
    finalUrl: finalUrl.href,
    statusCode: responseStatus && Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599
      ? responseStatus
      : null,
    contentType: document.contentType?.slice(0, 300) ?? "text/html",
    title: document.title.slice(0, 500),
    browserUserAgent: navigator.userAgent.slice(0, 500),
    bodyText,
    bodyHtml,
    ...(linkedinViewId(finalUrl.href) ? { visibleApplyControls: captureVisibleApplyControls(document) } : {}),
  };
}

function linkedinViewId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname)) return null;
    return /^\/jobs\/view\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function selectedHeaderJobId(anchor: HTMLAnchorElement): string | null {
  // Modern LinkedIn keeps the selected header's Apply control and its two
  // current-job detail links in one narrow DIV. Recommendations sit in a
  // separate section; the broad Primary content region is never identity.
  let depth = 0;
  for (let current: HTMLElement | null = anchor; current && depth <= 6; current = current.parentElement, depth += 1) {
    if (current !== anchor && (
      ["MAIN", "SECTION", "ARTICLE"].includes(current.tagName)
      || current.getAttribute("aria-label") === "Primary content"
    )) return null;
    if (current.tagName !== "DIV" || current.querySelector("section, article, main")) continue;
    const ids = [...current.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]')]
      .filter((link) => isVisibleElement(link))
      .map((link) => linkedinViewId(link.href))
      .filter((id): id is string => id !== null);
    if (ids.length >= 2 && new Set(ids).size === 1) return ids[0] ?? null;
  }
  return null;
}

export function captureVisibleApplyControls(doc: Document): Array<{ href: string; jobId: string }> {
  const controls: Array<{ href: string; jobId: string }> = [];
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const label = (anchor.getAttribute("aria-label") ?? "").trim().toLowerCase();
    const tracking = (anchor.getAttribute("data-tracking-control-name") ?? "").toLowerCase();
    if (!(label.startsWith("apply on company website")
      || anchor.classList.contains("jobs-apply-button")
      || tracking.includes("jobs_apply-link"))) continue;
    if (!isVisibleElement(anchor)) continue;
    const jobId = selectedHeaderJobId(anchor);
    if (!jobId) continue;
    if (anchor.href.length > 2048) return [];
    controls.push({ href: anchor.href, jobId });
    if (controls.length > 20) return [];
  }
  return controls;
}

type RenderedPageSleep = (milliseconds: number) => Promise<void>;

export interface RenderedPageReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  minimumStableMs?: number;
  sleep?: RenderedPageSleep;
  now?: () => number;
}

/**
 * Wait for client-rendered job pages to expose their actual detail DOM before
 * taking a snapshot. Chrome injects the content script at document_idle, but
 * SPA shells (notably LinkedIn's signed-in job view) can still be hydrating at
 * that point. Capturing immediately records the loading shell and causes the
 * worker's extraction cascade to report "no data extracted" even though the
 * authenticated page becomes readable moments later.
 *
 * LinkedIn job pages require a concrete job-detail signal and therefore wait
 * up to the bounded timeout. Other pages use a short DOM-stability window so
 * static sources are not forced to pay the full delay.
 */
export async function waitForRenderedPageReady(
  doc: Document = document,
  pageUrl = location.href,
  options: RenderedPageReadinessOptions = {},
): Promise<void> {
  // The executor provides a visible tab for LinkedIn job hydration. Leave
  // room for content readiness inside its separate hard task deadline.
  const timeoutMs = Math.max(250, options.timeoutMs ?? 30_000);
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
  const minimumStableMs = Math.max(pollIntervalMs, options.minimumStableMs ?? 750);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => performance.now());
  const linkedinJobPage = isLinkedInJobPage(pageUrl);
  const deadline = now() + timeoutMs;
  let stableSince = now();
  let previousSignature = renderedPageSignature(doc);

  while (now() < deadline) {
    if (linkedinJobPage && hasLinkedInJobDetailContent(doc)) {
      return;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));

    const observedAt = now();
    const signature = renderedPageSignature(doc);
    const busy = doc.querySelector('[aria-busy="true"], [role="progressbar"]') !== null;
    if (signature !== previousSignature || busy || doc.readyState === "loading") {
      stableSince = observedAt;
    }
    previousSignature = signature;

    if (!linkedinJobPage && observedAt - stableSince >= minimumStableMs) {
      return;
    }
  }

  if (linkedinJobPage && !hasLinkedInJobDetailContent(doc)) {
    throw new Error("LinkedIn job detail did not become ready before the bounded Discovery wait.");
  }
}

export async function captureRenderedPageSnapshotWhenReady(
  doc: Document = document,
  pageUrl = location.href,
  options: RenderedPageReadinessOptions = {},
): Promise<DiscoveryBrowserTaskResult> {
  await waitForRenderedPageReady(doc, pageUrl, options);
  return captureRenderedPageSnapshot();
}

export async function captureRenderedPageSnapshotResponse(
  doc: Document = document,
  pageUrl = location.href,
  options: RenderedPageReadinessOptions = {},
): Promise<DiscoveryBrowserTaskResult> {
  try {
    return await captureRenderedPageSnapshotWhenReady(doc, pageUrl, options);
  } catch (error) {
    return discoveryFailure("navigation_failed", error, true);
  }
}

function isLinkedInJobPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return (host === "linkedin.com" || host.endsWith(".linkedin.com")) && url.pathname.startsWith("/jobs/");
  } catch {
    return false;
  }
}

function hasLinkedInJobDetailContent(doc: Document): boolean {
  const details = doc.querySelectorAll(
    [
      '[id^="JobDetails_AboutTheJob_"]',
      ".jobs-description__content",
      ".jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description",
      '[data-view-name*="job-details"]',
    ].join(", "),
  );
  if ([...details].some((detail) => readableText(detail).length >= 200)) {
    return true;
  }
  return [...doc.querySelectorAll('script[type="application/ld+json"]')].some((script) =>
    (script.textContent ?? "").includes('"JobPosting"'),
  );
}

function renderedPageSignature(doc: Document): string {
  const text = readableText(doc.body ?? doc.documentElement);
  const elements = doc.getElementsByTagName("*").length;
  return `${doc.readyState}:${doc.title.length}:${text.length}:${elements}`;
}

function readableText(node: Element | null): string {
  if (!node) return "";
  const withInnerText = node as HTMLElement;
  return String(withInnerText.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sanitizeDiscoveryHeaders(headers: Record<string, string>): Record<string, string> {
  const forbidden = new Set([
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "user-agent",
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => {
        const normalized = name.toLowerCase();
        return (
          !forbidden.has(normalized) &&
          !normalized.startsWith("sec-") &&
          !normalized.startsWith("proxy-")
        );
      })
      .slice(0, 32)
      .map(([name, value]) => [name, String(value).slice(0, 4096)]),
  );
}

class DiscoveryResponseTooLargeError extends Error {
  constructor() {
    super("Discovery response exceeded 4 MB of UTF-8 data.");
    this.name = "DiscoveryResponseTooLargeError";
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new DiscoveryResponseTooLargeError();
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Discovery response exceeded its byte limit.");
        throw new DiscoveryResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (encoder.encode(value.slice(0, midpoint)).byteLength <= maxBytes) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  const bounded = value.slice(0, lower);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function isSafePublicPageUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^(?:127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host)) return false;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  return true;
}

function discoveryFailure(
  errorCode: Extract<DiscoveryBrowserTaskResult, { status: "failed" }>["errorCode"],
  error: unknown,
  retryable: boolean,
): DiscoveryBrowserTaskResult {
  const message = error instanceof Error ? error.message : String(error || "Discovery browser request failed.");
  return {
    status: "failed",
    errorCode,
    message: message.trim().slice(0, 500) || "Discovery browser request failed.",
    retryable,
  };
}

function isAutofillMessage(value: unknown): value is {
  type: "jobctrl.autofill.review";
  profile: ExtensionAutofillProfileResponse;
  mapping: FormMappingResponse;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).type === "jobctrl.autofill.review" &&
      isProfileResponse((value as Record<string, unknown>).profile) && FormMappingResponseSchema.safeParse((value as Record<string,unknown>).mapping).success,
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
