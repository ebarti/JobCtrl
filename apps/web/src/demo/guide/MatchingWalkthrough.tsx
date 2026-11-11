import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../../shared/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../shared/ui/dialog.js";

type EditExample = "fact" | "wording";
type UpdateExample = "completed" | "stopped" | "partial";
type WordingExample = "approval" | "deferral";
type DemoDestination = "job" | "profile" | "evidence";

const STEPS = ["Catalog", "Profile", "Update", "Wording"] as const;

/** A fixed teaching example: no workspace writes, provider calls or invented receipts. */
export function MatchingWalkthrough({ jobId, onNavigate }: {
  readonly jobId: string;
  readonly onNavigate: (destination: DemoDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [edit, setEdit] = useState<EditExample>("fact");
  const [update, setUpdate] = useState<UpdateExample | null>(null);
  const [wording, setWording] = useState<WordingExample | null>(null);

  const resetExample = () => {
    setStep(0);
    setEdit("fact");
    setUpdate(null);
    setWording(null);
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) resetExample();
  };
  const navigate = (destination: DemoDestination) => {
    changeOpen(false);
    onNavigate(destination);
  };

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-between px-2 py-2 text-left" />}>
      <span>Explore matching and wording</span>
      <IconArrowRight aria-hidden="true" size={15} />
    </DialogTrigger>
    <DialogContent className="demo-matching-dialog max-h-[calc(100dvh-2rem)] w-[min(46rem,calc(100vw-2rem))] gap-4 overflow-y-auto sm:max-w-[46rem]">
      <DialogHeader>
        <p className="eyebrow">Guided illustration</p>
        <DialogTitle data-typography="section-title">How matching and wording work</DialogTitle>
        <DialogDescription className="mt-2 border border-border bg-muted p-3 text-foreground">
          This is a synthetic illustration. No model runs and no changes are saved. The real update action is unavailable in this demo.
        </DialogDescription>
      </DialogHeader>

      <ol aria-label="Walkthrough steps" className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined}
          className={`border px-2 py-1 ${index === step ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`} data-typography="label">
          {index + 1}. {label}
        </li>)}
      </ol>

      <section aria-labelledby="matching-example-step" className="grid min-w-0 gap-3">
        <div aria-live="polite" aria-atomic="true">
          <p className="muted" data-typography="metadata">Step {step + 1} of {STEPS.length}</p>
          <h3 id="matching-example-step" data-typography="component-title">
            {step === 0 ? "One catalog, separate posting sources" : step === 1 ? "Saved changes wait for review" : step === 2 ? "Choose when to update" : "Reuse wording with your approval"}
          </h3>
        </div>

        {step === 0 ? <>
          <p data-typography="body">After extraction, one model comparison considers all incoming requirements against the entire saved catalog, including each definition, scope and qualifiers.</p>
          <div className="grid gap-2 border border-border bg-muted/40 p-3">
            <p data-typography="label">Example qualified meaning</p>
            <p data-typography="strong-body">Lead incident recovery for production services</p>
            <p data-typography="body">Scope: production services · Responsibility: lead</p>
            <div className="grid gap-1" data-typography="body">
              <p><strong>Posting 1:</strong> “Lead incident recovery for production services.”</p>
              <p><strong>Posting 2:</strong> “Lead production incident recovery.”</p>
            </div>
            <p data-typography="body">Illustrative mapping: if the comparison confirms the same full meaning, both postings can link here while keeping separate source occurrences.</p>
          </div>
          <p data-typography="body">Different scope or responsibility may mean a distinct requirement. An uncertain or refused comparison stays unresolved; it does not publish a partial decision.</p>
          <div><Button variant="ghost" size="sm" className="h-auto whitespace-normal px-0 text-left" nativeButton={false}
            render={<Link to="/jobs/$jobId" params={{ jobId }} onClick={() => navigate("job")} role="link" />}>
            Open demo job <IconArrowRight aria-hidden="true" size={15} />
          </Button></div>
        </> : null}

        {step === 1 ? <>
          <p data-typography="body">Choose an example edit to see how saved changes affect matching.</p>
          <div role="group" aria-label="Choose an example edit" className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={edit === "fact" ? "default" : "outline"} aria-pressed={edit === "fact"} onClick={() => setEdit("fact")}>Fact or source edit</Button>
            <Button type="button" size="sm" variant={edit === "wording" ? "default" : "outline"} aria-pressed={edit === "wording"} onClick={() => setEdit("wording")}>Approved wording change</Button>
          </div>
          <div className="grid gap-2 border border-border bg-muted/40 p-3" role="status">
            {edit === "fact" ? <>
              <p data-typography="label">Example: pending review</p>
              <p data-typography="body">A new saved fact can affect a requirement previously marked missing or never linked. The earlier assessment remains available and can be out of date until an explicit update.</p>
            </> : <>
              <p data-typography="label">Example: wording coverage needs review</p>
              <p data-typography="body">Changing approved wording does not change person qualification or its score. Current exact coverage links are reused; new coverage waits for an explicit update.</p>
            </>}
          </div>
          <p data-typography="body">Saving a fact, source or wording decision does not itself run a model or regenerate a resume.</p>
          <div><Button variant="ghost" size="sm" className="h-auto whitespace-normal px-0 text-left" nativeButton={false}
            render={<Link to="/profile" onClick={() => navigate("profile")} role="link" />}>
            Open demo Profile <IconArrowRight aria-hidden="true" size={15} />
          </Button></div>
        </> : null}

        {step === 2 ? <>
          <p data-typography="body">In the local app, Update affected matches reviews the saved catalog and reassesses only selected affected requirements. Current links can be reused; selected job scores and wording coverage are separate outcomes.</p>
          <p data-typography="body">Choose an example outcome. These controls do not start an update.</p>
          <div role="group" aria-label="Choose an example update outcome" className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={update === "completed" ? "default" : "outline"} aria-pressed={update === "completed"} onClick={() => setUpdate("completed")}>Show completed example</Button>
            <Button type="button" size="sm" variant={update === "stopped" ? "default" : "outline"} aria-pressed={update === "stopped"} onClick={() => setUpdate("stopped")}>Show stopped example</Button>
            <Button type="button" size="sm" variant={update === "partial" ? "default" : "outline"} aria-pressed={update === "partial"} onClick={() => setUpdate("partial")}>Show partial example</Button>
          </div>
          <div className="grid gap-2 border border-border bg-muted/40 p-3" role="status">
            {update === "completed" ? <><p data-typography="label">Example: completed</p><p data-typography="body">Affected assessments and selected job scores can update; current records are reused and previously accepted work remains available.</p></>
              : update === "stopped" ? <><p data-typography="label">Example: stopped before factual publication</p><p data-typography="body">No new factual results are published. Previously accepted scores remain available.</p></>
              : update === "partial" ? <><p data-typography="label">Example: partial result</p><p data-typography="body">The factual stage published, but later wording preparation failed. The recorded result shows that boundary and keeps existing accepted artifacts.</p><p data-typography="body">In the local app, Retry failed wording explicitly retries selected eligible failures without rerunning factual assessments or updating scores. Approval remains separate.</p></>
              : <p data-typography="body">Select an outcome to see what remains available.</p>}
          </div>
          <p data-typography="body">The local action has work limits, cancellation and recorded status; this illustration does not submit it.</p>
        </> : null}

        {step === 3 ? <>
          <p data-typography="body">A current exact approved-wording link can be reused without a new model call. Several expression gaps for one achievement can instead produce one grouped proposal.</p>
          <div className="grid gap-2 border border-border bg-muted/40 p-3">
            <p data-typography="label">One synthetic achievement · saved facts</p>
            <p data-typography="body">Led recovery for 12 production incidents; created response runbooks used by 3 teams.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid content-start gap-2 border border-border bg-card p-3">
                <p data-typography="label">Example approved wording</p>
                <p data-typography="body">“Led recovery for 12 production incidents.”</p>
                <p className="border border-border px-2 py-1" data-typography="label">R1 · Lead production incident recovery</p>
                <p data-typography="body">Reuse its current exact link for R1.</p>
              </div>
              <div className="grid content-start gap-2 border border-border bg-card p-3">
                <p data-typography="label">One grouped proposal · not approved</p>
                <p data-typography="body">“Led recovery for 12 production incidents and created response runbooks used by 3 teams.”</p>
                <div className="flex flex-wrap gap-1">
                  <span className="border border-border px-2 py-1" data-typography="label">R1 · Lead production incident recovery</span>
                  <span className="border border-border px-2 py-1" data-typography="label">R2 · Create response runbooks used by multiple teams</span>
                </div>
                <p data-typography="body">Both claims come from the example achievement.</p>
              </div>
            </div>
          </div>
          <p data-typography="body">A proposal is not approved until you decide. Choose an example decision; it changes only this illustration, not the Profile.</p>
          <div role="group" aria-label="Choose an example wording decision" className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={wording === "approval" ? "default" : "outline"} aria-pressed={wording === "approval"} onClick={() => setWording("approval")}>Show approval example</Button>
            <Button type="button" size="sm" variant={wording === "deferral" ? "default" : "outline"} aria-pressed={wording === "deferral"} onClick={() => setWording("deferral")}>Show deferral example</Button>
          </div>
          <div className="grid gap-2 border border-border bg-muted/40 p-3" role="status">
            {wording === "approval" ? <><p data-typography="label">Example: approval outcome</p><p data-typography="body">If approved in the local app, that expression can be reused where its recorded coverage applies. This example did not save an approval.</p></>
              : wording === "deferral" ? <><p data-typography="label">Example: deferral outcome</p><p data-typography="body">A deferred decision remains recorded rather than being regenerated for every posting. This example did not change the Profile.</p></>
              : <p data-typography="body">Select a decision to see the example outcome.</p>}
          </div>
          <div><Button variant="ghost" size="sm" className="h-auto whitespace-normal px-0 text-left" nativeButton={false}
            render={<Link to="/requirements" search={{ q: "" }} onClick={() => navigate("evidence")} role="link" />}>
            Open demo requirements library <IconArrowRight aria-hidden="true" size={15} />
          </Button></div>
        </> : null}
      </section>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>Previous step</Button>
        {step < STEPS.length - 1 ? <Button type="button" onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}>Next step</Button>
          : <Button type="button" onClick={resetExample}>Start example again</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
