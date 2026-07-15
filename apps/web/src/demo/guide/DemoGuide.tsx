import {
  IconArrowRight,
  IconExternalLink,
  IconRefresh,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { classifyDemoRoute } from "../consent/DemoTelemetryAdapter.js";
import { useDemoWorkspace } from "../workspace/DemoWorkspaceProvider.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useToastStore } from "../../shared/stores/toasts.js";
import { Button } from "../../shared/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog.js";

const GUIDE_STATE_KEY = "demo.guide.state";
const DEMO_JOB_ID = "job-northwind-platform";
const DEMO_ARTIFACT_ID = "artifact-tailored-resume";

type DemoGuideFeature = "scoring" | "materials" | "apply_review" | "pipeline";

interface DemoGuideState {
  readonly open: boolean;
}

function isGuideOpen(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    (value as DemoGuideState).open === true
  );
}

/**
 * A small, non-modal orientation control for the consented synthetic demo.
 * Its only persisted state is whether this panel is expanded in the current
 * browser session; the workspace remains the authority for all demo data.
 */
export function DemoGuide() {
  const workspaceContext = useDemoWorkspace();
  const { storage, telemetry } = usePorts();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToastStore((state) => state.toast);
  const [open, setOpen] = useState(() =>
    isGuideOpen(storage.get(GUIDE_STATE_KEY)),
  );
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(open);

  useEffect(() => {
    if (open && !previousOpen.current) closeRef.current?.focus();
    if (!open && previousOpen.current) launcherRef.current?.focus();
    previousOpen.current = open;
  }, [open]);

  if (workspaceContext.mode === "local") return null;

  const route = classifyDemoRoute(location.pathname);
  const setGuideOpen = (next: boolean) => {
    storage.set<DemoGuideState>(GUIDE_STATE_KEY, { open: next });
    setOpen(next);
  };
  const recordFeatureShortcut = (feature: DemoGuideFeature) => {
    telemetry.event("demo_feature_opened", { route, feature });
    setGuideOpen(false);
  };
  const resetWorkspace = async () => {
    setIsResetting(true);
    setResetStatus("Resetting synthetic demo data…");
    try {
      await workspaceContext.workspace.reset();
      telemetry.event("demo_workspace_reset", { route });
      const message =
        "Synthetic demo data reset. The seeded examples are ready again.";
      setResetStatus(message);
      toast({ title: "Demo data reset", message, variant: "success" });
      setConfirmResetOpen(false);
      await navigate({ to: "/dashboard" });
    } catch {
      const message = "Demo data could not be reset. Try again.";
      setResetStatus(message);
      toast({ title: "Demo reset unavailable", message, variant: "error" });
      setConfirmResetOpen(false);
    } finally {
      setIsResetting(false);
    }
  };

  if (!open) {
    return (
      <div className="fixed bottom-4 right-4 z-40 motion-reduce:transition-none">
        <Button
          ref={launcherRef}
          type="button"
          variant="secondary"
          onClick={() => setGuideOpen(true)}
          aria-expanded="false"
          aria-label="Open demo guide"
        >
          <IconSparkles aria-hidden="true" size={16} />
          Demo guide
        </Button>
      </div>
    );
  }

  return (
    <aside
      className="demo-guide-panel fixed bottom-4 right-4 z-40 grid w-[min(22rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-[var(--shadow-panel)] motion-reduce:transition-none"
      aria-labelledby="demo-guide-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Demo mode</p>
          <h2
            id="demo-guide-title"
            className="mt-1 text-base font-bold tracking-tight"
          >
            Try the synthetic workflow
          </h2>
        </div>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-2 -mt-1 shrink-0"
          onClick={() => setGuideOpen(false)}
          aria-label="Hide demo guide"
        >
          <IconX aria-hidden="true" size={16} />
        </Button>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Every record and action in this demo is simulated and synthetic. Nothing
        is sent to an employer, mailbox, or external service.
      </p>

      <nav aria-label="Synthetic demo shortcuts">
        <ul className="grid gap-1">
          <li>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between px-2 py-2 text-left"
              nativeButton={false}
              render={
                <Link
                  to="/jobs/$jobId"
                  params={{ jobId: DEMO_JOB_ID }}
                  onClick={() => recordFeatureShortcut("scoring")}
                  role="link"
                />
              }
            >
              <span>Inspect synthetic scoring evidence</span>
              <IconArrowRight aria-hidden="true" size={15} />
            </Button>
          </li>
          <li>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between px-2 py-2 text-left"
              nativeButton={false}
              render={
                <Link
                  to="/artifacts/$artifactId"
                  params={{ artifactId: DEMO_ARTIFACT_ID }}
                  onClick={() => recordFeatureShortcut("materials")}
                  role="link"
                />
              }
            >
              <span>Review synthetic tailored materials</span>
              <IconArrowRight aria-hidden="true" size={15} />
            </Button>
          </li>
          <li>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between px-2 py-2 text-left"
              nativeButton={false}
              render={
                <Link
                  to="/apply-review"
                  search={{ jobKey: DEMO_JOB_ID }}
                  onClick={() => recordFeatureShortcut("apply_review")}
                  role="link"
                />
              }
            >
              <span>Open simulated Apply Review and dry run</span>
              <IconArrowRight aria-hidden="true" size={15} />
            </Button>
          </li>
          <li>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between px-2 py-2 text-left"
              nativeButton={false}
              render={
                <Link
                  to="/runs"
                  onClick={() => recordFeatureShortcut("pipeline")}
                  role="link"
                />
              }
            >
              <span>See simulated run history</span>
              <IconArrowRight aria-hidden="true" size={15} />
            </Button>
          </li>
        </ul>
      </nav>

      <div className="grid gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => setConfirmResetOpen(true)}
        >
          <IconRefresh aria-hidden="true" size={15} />
          Reset synthetic demo data
        </Button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <a
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            href="https://jobctrl.dev/user/getting-started"
            target="_blank"
            rel="noreferrer"
            onClick={() =>
              telemetry.event("demo_install_cta_clicked", { route })
            }
          >
            Install & setup
            <IconExternalLink aria-hidden="true" size={13} />
          </a>
          <a
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            href="https://jobctrl.dev/"
            target="_blank"
            rel="noreferrer"
            onClick={() => telemetry.event("demo_docs_cta_clicked", { route })}
          >
            Docs
            <IconExternalLink aria-hidden="true" size={13} />
          </a>
          <a
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            href="https://jobctrl.dev/user/data-and-safety"
            target="_blank"
            rel="noreferrer"
            onClick={() => telemetry.event("demo_docs_cta_clicked", { route })}
          >
            Privacy
            <IconExternalLink aria-hidden="true" size={13} />
          </a>
        </div>
        {resetStatus ? (
          <p className="text-xs leading-5 text-muted-foreground" role="status">
            {resetStatus}
          </p>
        ) : null}
      </div>

      <Dialog
        open={confirmResetOpen}
        onOpenChange={(next) => {
          if (!isResetting) setConfirmResetOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset synthetic demo data?</DialogTitle>
            <DialogDescription>
              This replaces the browser-local demo workspace with its original
              seeded examples and removes simulated changes and receipts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmResetOpen(false)}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void resetWorkspace()}
              disabled={isResetting}
            >
              {isResetting ? "Resetting…" : "Reset demo data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
