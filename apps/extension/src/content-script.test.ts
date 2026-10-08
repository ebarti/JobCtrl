// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://careers.example.com/jobs"}

import { DiscoveryBrowserTaskResultSchema, type FormMappingResponse, type FormSnapshot, type ExtensionAutofillProfileField } from "@jobctrl/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;
let getClientRectsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
      },
    },
  });
});

beforeEach(() => {
  getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return syntheticRectFor(this);
  });
  getClientRectsSpy = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    const rect = syntheticRectFor(this);
    return (rect.width >= 1 && rect.height >= 1 ? [rect] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  getBoundingClientRectSpy.mockRestore();
  getClientRectsSpy.mockRestore();
});

describe("source-bound autofill content script", () => {
  it("observes only a visible Apply link positively bound to the selected job header", async () => {
    const { captureVisibleApplyControls } = await import("./content-script");
    document.body.innerHTML = `
      <style>.concealed { display: none; }</style>
      <section aria-label="Primary content">
        <div class="selected-header">
          <a href="https://www.linkedin.com/jobs/view/123/">On-site</a>
          <a href="https://www.linkedin.com/jobs/view/123/">Full-time</a>
          <div><div><div>
            <a class="concealed" aria-label="Apply on company website" href="https://other.example.com/hidden">Apply</a>
            <a aria-label="Apply on company website" href="https://apply.example.com/current">Apply</a>
          </div></div></div>
        </div>
        <section class="recommendation">
          <a aria-label="Apply on company website" href="https://other.example.com/wrong">Apply</a>
        </section>
        <div id="JobDetails_AboutTheJob_123">Selected description</div>
      </section>`;

    const observed = captureVisibleApplyControls(document);
    expect(observed).toEqual([
      { href: "https://apply.example.com/current", jobId: "123" },
    ]);
    expect(DiscoveryBrowserTaskResultSchema.safeParse({
      status: "succeeded", finalUrl: "https://www.linkedin.com/jobs/view/123/", statusCode: 200,
      contentType: "text/html", title: "Synthetic role", bodyText: "Synthetic role",
      visibleApplyControls: observed,
    }).success).toBe(true);
    document.querySelector<HTMLAnchorElement>('a[href="https://apply.example.com/current"]')?.remove();
    expect(captureVisibleApplyControls(document)).toEqual([]);
  });

  it.each([200, 404, 410])("preserves navigation HTTP %s in a rendered snapshot", async (status) => {
    const { captureRenderedPageSnapshot } = await import("./content-script");
    document.body.innerHTML = "<main>Job not found</main>";
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: vi.fn(() => [{ responseStatus: status }]),
    });
    expect(captureRenderedPageSnapshot()).toMatchObject({ status: "succeeded", statusCode: status });
  });

  it.each([0, undefined])("keeps unavailable navigation status explicit (%s)", async (status) => {
    const { captureRenderedPageSnapshot } = await import("./content-script");
    document.body.innerHTML = "<main>Job details</main>";
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: vi.fn(() => [{ responseStatus: status }]),
    });
    expect(captureRenderedPageSnapshot()).toMatchObject({ status: "succeeded", statusCode: null });
  });

  it("waits for the signed-in LinkedIn job detail instead of snapshotting its loading shell", async () => {
    const { waitForRenderedPageReady } = await import("./content-script");
    document.body.innerHTML = '<main><div role="progressbar">Loading</div></main>';
    let polls = 0;
    let elapsed = 0;

    await waitForRenderedPageReady(document, "https://www.linkedin.com/jobs/view/123", {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      minimumStableMs: 100,
      now: () => elapsed,
      sleep: async (milliseconds: number) => {
        elapsed += milliseconds;
        polls += 1;
        if (polls === 2) {
          document.body.innerHTML = `<main><section class="jobs-description__content">${"Authenticated job detail ".repeat(20)}</section></main>`;
        }
      },
    });

    expect(polls).toBe(2);
    expect(document.querySelector(".jobs-description__content")).not.toBeNull();
  });

  it("recognizes the current LinkedIn SDUI detail only after its description is populated", async () => {
    const { waitForRenderedPageReady } = await import("./content-script");
    document.body.innerHTML = '<main><div id="JobDetails_AboutTheJob_123" componentkey="JobDetails_AboutTheJob_123"><h2>About the job</h2></div></main>';
    let elapsed = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      elapsed += milliseconds;
      if (elapsed >= 200) {
        document.querySelector("#JobDetails_AboutTheJob_123")!.innerHTML += `<p>${"Build and operate reliable infrastructure. ".repeat(10)}</p>`;
      }
    });

    await waitForRenderedPageReady(document, "https://www.linkedin.com/jobs/view/123/", {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      sleep,
      now: () => elapsed,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("allows a cold inactive LinkedIn page to hydrate beyond twelve seconds", async () => {
    const { waitForRenderedPageReady } = await import("./content-script");
    document.body.innerHTML = '<div id="JobDetails_AboutTheJob_123"><h2>About the job</h2></div>';
    let elapsed = 0;

    await waitForRenderedPageReady(document, "https://www.linkedin.com/jobs/view/123/", {
      now: () => elapsed,
      sleep: async (milliseconds: number) => {
        elapsed += milliseconds;
        if (elapsed >= 15_000) {
          document.querySelector("#JobDetails_AboutTheJob_123")!.innerHTML += `<p>${"Build and operate reliable infrastructure. ".repeat(10)}</p>`;
        }
      },
    });

    expect(elapsed).toBe(15_000);
  });

  it("uses a short stability window for non-LinkedIn rendered pages", async () => {
    const { waitForRenderedPageReady } = await import("./content-script");
    document.body.innerHTML = "<main>Stable public job detail</main>";
    let elapsed = 0;
    const sleep = vi.fn(async (milliseconds: number) => { elapsed += milliseconds; });

    await waitForRenderedPageReady(document, "https://careers.example.com/jobs/123", {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      minimumStableMs: 200,
      sleep,
      now: () => elapsed,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable bounded failure when a LinkedIn loading shell never hydrates", async () => {
    const { captureRenderedPageSnapshotResponse } = await import("./content-script");
    document.body.innerHTML = '<main><div role="progressbar">Loading</div></main>';
    let elapsed = 0;
    const sleep = vi.fn(async (milliseconds: number) => { elapsed += milliseconds; });

    const response = await captureRenderedPageSnapshotResponse(
      document,
      "https://www.linkedin.com/jobs/view/123",
      {
        timeoutMs: 300,
        pollIntervalMs: 100,
        sleep,
        now: () => elapsed,
      },
    );

    expect(response).toEqual({
      status: "failed",
      errorCode: "navigation_failed",
      message: "LinkedIn job detail did not become ready before the bounded Discovery wait.",
      retryable: true,
    });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("uses elapsed wall time when an inactive tab delays a readiness poll", async () => {
    const { captureRenderedPageSnapshotResponse } = await import("./content-script");
    document.body.innerHTML = '<main><div id="JobDetails_AboutTheJob_123">Loading</div></main>';
    let elapsed = 0;
    const sleep = vi.fn(async () => { elapsed += 5_000; });

    const response = await captureRenderedPageSnapshotResponse(document, "https://www.linkedin.com/jobs/view/123/", {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      sleep,
      now: () => elapsed,
    });

    expect(response).toMatchObject({ status: "failed", errorCode: "navigation_failed", retryable: true });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("strips browser-owned identity headers from Discovery fetches", async () => {
    const { executeDiscoveryHttpRequest } = await import("./content-script");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      url: "https://careers.example.com/api/jobs",
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => '{"jobs":[]}',
    } as Response);

    const response = await executeDiscoveryHttpRequest({
      mode: "http_request",
      url: "https://careers.example.com/api/jobs",
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: "must-not-cross",
        "User-Agent": "must-not-cross",
        "Sec-CH-UA": '"Hard-coded browser";v="1"',
        "Proxy-Authorization": "must-not-cross",
      },
    });

    expect(response).toMatchObject({
      status: "succeeded",
      bodyText: '{"jobs":[]}',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://careers.example.com/api/jobs",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    fetchSpy.mockRestore();
  });

  it("cancels an oversized streaming response before buffering beyond 4 MB", async () => {
    const { executeDiscoveryHttpRequest } = await import("./content-script");
    let producedChunks = 0;
    let canceled = false;
    const chunk = new Uint8Array(1_000_000);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        producedChunks += 1;
        controller.enqueue(chunk);
        if (producedChunks >= 10) controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await executeDiscoveryHttpRequest({
      mode: "http_request",
      url: "https://careers.example.com/api/jobs",
      method: "GET",
      headers: {},
    });

    expect(response).toMatchObject({
      status: "failed",
      errorCode: "response_too_large",
      retryable: false,
    });
    expect(producedChunks).toBeLessThan(10);
    expect(canceled).toBe(true);
    fetchSpy.mockRestore();
  });

  it("uses the model mapping and keeps unaccepted values out of the page", async () => {
    const { showAutofillReview, captureAutofillForm } = await import("./content-script");
    document.body.innerHTML = `<form id="application"><label>Question <input name="answer" /></label></form>`;
    const snapshot=captureAutofillForm(document);
    const mapping=chosenMapping(snapshot, [{fact_id:"personal.email",value:"jordan@example.com"}]);
    const response=showAutofillReview({ok:true,profileVersion:1,fields:profileFields()},mapping);
    expect(response).toEqual({ok:true,status:"review_opened",suggestions:1,missing:0});
    expect(document.body.textContent).toContain("Profile value ready");
    expect(document.body.textContent).not.toContain("jordan@example.com");
    const input=document.querySelector("[name='answer']") as HTMLInputElement;
    expect(input.value).toBe("");
    const fill=Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Fill selected");
    fill?.click(); // Untrusted page clicks cannot authorize filling.
    expect(input.value).toBe("");
  });

  it("allows opposite valid model decisions for the same question", async () => {
    const { buildAutofillSuggestions, collectFieldTargets, captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<label>Question <input name="answer" /></label>`;
    const snapshot=captureAutofillForm(document),targets=collectFieldTargets(document);
    expect(buildAutofillSuggestions(profileFields(),targets,chosenMapping(snapshot,[{fact_id:"personal.email",value:"jordan@example.com"}]))).toHaveLength(1);
    expect(buildAutofillSuggestions(profileFields(),targets,chosenMapping(snapshot,[{decision:"unmapped",fact_id:null,value:""}]))).toEqual([]);
    expect(buildAutofillSuggestions(profileFields(),targets,chosenMapping(snapshot,[{decision:"missing",fact_id:null,value:""}]))[0]).toMatchObject({status:"missing",value:""});
  });

  it("fills confirmed mapped controls without submitting", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets, captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<form id="application"><input name="first" /><input name="second" /><input name="third" /><button type="submit">Submit</button></form>`;
    let submits=0;document.querySelector("form")!.addEventListener("submit",()=>submits++);
    const snapshot=captureAutofillForm(document),targets=collectFieldTargets(document);
    const mapping=chosenMapping(snapshot,[{fact_id:"personal.full_name",value:"Jordan Candidate"},{fact_id:"personal.email",value:"jordan@example.com"},{fact_id:"personal.linkedin_url",value:"https://linkedin.com/in/jordan"}]);
    expect(applyAcceptedSuggestions(buildAutofillSuggestions(profileFields(),targets,mapping))).toBe(3);
    expect(Array.from(document.querySelectorAll("form input")).map(input=>(input as HTMLInputElement).value)).toEqual(["Jordan Candidate","jordan@example.com","https://linkedin.com/in/jordan"]);
    expect(submits).toBe(0);
  });

  it("uses option IDs for radio and select controls", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets, captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<form><input type="radio" name="choice" value="a" /><input type="radio" name="choice" value="b" /><select name="choice2"><option value="a">A</option><option value="b">B</option></select></form>`;
    const snapshot=captureAutofillForm(document),targets=collectFieldTargets(document);
    const mapping=chosenMapping(snapshot,[{fact_id:"personal.email",value:"jordan@example.com",option_id:snapshot.questions[0]!.options[1]!.option_id},{fact_id:"personal.email",value:"jordan@example.com",option_id:snapshot.questions[1]!.options[1]!.option_id}]);
    expect(applyAcceptedSuggestions(buildAutofillSuggestions(profileFields(),targets,mapping))).toBe(2);
    expect((document.querySelector("input[value='b']") as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector("input[value='a']") as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("b");
  });

  it("captures only visible controls and rechecks visibility at confirmation", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets, captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<form><input name="hidden" style="display:none" /><div style="visibility:hidden"><input name="ancestor" /></div><input name="zero" data-rect="zero" /><input name="offscreen" data-rect="offscreen" /><input name="clipped" style="clip-path:inset(50%)" /><input name="visible" /></form>`;
    const snapshot=captureAutofillForm(document),targets=collectFieldTargets(document);
    expect(targets.map(target=>target.control.name)).toEqual(["visible"]);
    const suggestions=buildAutofillSuggestions(profileFields(),targets,chosenMapping(snapshot,[{fact_id:"personal.email",value:"jordan@example.com"}]));
    targets[0]!.control.style.display="none";
    expect(applyAcceptedSuggestions(suggestions)).toBe(0);
    expect(targets[0]!.control.value).toBe("");
  });

  it("refuses stale form snapshots and profile versions", async () => {
    const { showAutofillReview,captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<label>Question <input name="answer" /></label>`;
    const snapshot=captureAutofillForm(document),mapping=chosenMapping(snapshot,[{fact_id:"personal.email",value:"jordan@example.com"}]);
    expect(showAutofillReview({ok:true,profileVersion:2,fields:profileFields()},mapping)).toMatchObject({ok:false,error:"stale_form_snapshot"});
    document.querySelector("label")!.prepend("Changed ");
    expect(showAutofillReview({ok:true,profileVersion:1,fields:profileFields()},mapping)).toMatchObject({ok:false,error:"stale_form_snapshot"});
  });

  it("rejects non-web pages before opening review", async () => {
    const { showAutofillReview,captureAutofillForm } = await import("./content-script");
    document.body.innerHTML=`<input />`;
    const mapping=chosenMapping(captureAutofillForm(document),[{fact_id:"personal.email",value:"jordan@example.com"}]);
    expect(showAutofillReview({ok:true,profileVersion:1,fields:profileFields()},mapping,document,"file:///tmp/application.html")).toMatchObject({ok:false,error:"unsupported_page"});
  });

});

function profileFields(extra: ExtensionAutofillProfileField[] = []): ExtensionAutofillProfileField[] {
  return [
    field("personal.full_name", "Profile > Personal information > Full name", "Jordan Candidate"),
    field("personal.email", "Profile > Personal information > Email", "jordan@example.com"),
    field("personal.linkedin_url", "Profile > Personal information > LinkedIn URL", "https://linkedin.com/in/jordan"),
    ...extra,
  ];
}

function field(path: string, label: string, value: string): ExtensionAutofillProfileField {
  return {
    path,
    label,
    value,
    source: { kind: "profile", path, label },
  };
}

function syntheticRectFor(element: HTMLElement): DOMRect {
  if (element.dataset.rect === "zero") {
    return makeRect(8, 8, 0, 0);
  }
  if (element.dataset.rect === "offscreen") {
    return makeRect(-10_000, 8, 160, 24);
  }
  return makeRect(8, 8, 160, 24);
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function chosenMapping(snapshot:FormSnapshot,choices:Array<Partial<FormMappingResponse["mappings"][number]>>):FormMappingResponse {
 return {ok:true,snapshotId:snapshot.snapshotId,profileVersion:1,determinationId:"synthetic",mappings:choices.map((choice,index)=>({question_id:snapshot.questions[index]!.question_id,decision:"mapped",fact_id:null,value:"",option_id:null,citations:[],rationale:"Explicit model decision",...choice}))};
}
