import { useState, type JSX } from "react";

import type {
  DemoConsentChoice,
  DemoConsentClient,
  DemoConsentDecision,
} from "./DemoConsentClient.js";
import { Button } from "../../shared/ui/button.js";
import "./DemoConsentGate.css";

export interface DemoConsentGateProps {
  readonly client: DemoConsentClient;
  readonly initialChoice: DemoConsentChoice;
  readonly onDecisionStarted?: (choice: DemoConsentDecision) => void;
  readonly onGranted: () => void | Promise<void>;
  readonly onDeclined: () => void;
}

export function DemoConsentGate({
  client,
  initialChoice,
  onDecisionStarted,
  onGranted,
  onDeclined,
}: DemoConsentGateProps): JSX.Element {
  const [pending, setPending] = useState<"granted" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (): Promise<void> => {
    onDecisionStarted?.("granted");
    setPending("granted");
    setError(null);
    try {
      await client.submitChoice("granted");
      await onGranted();
    } catch {
      setError("The consent service is unavailable. Please try again to enter the demo.");
      setPending(null);
    }
  };

  const decline = async (): Promise<void> => {
    onDecisionStarted?.("denied");
    setPending("denied");
    setError(null);
    await Promise.race([
      client.submitChoice("denied").catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    onDeclined();
  };

  return (
    <main className="demo-consent-shell">
      <section className="demo-consent-card" aria-labelledby="demo-consent-title">
        <div className="demo-consent-mark" aria-hidden="true">JC</div>
        <p className="demo-consent-kicker">JobCtrl public demo</p>
        <h1 id="demo-consent-title">Explore JobCtrl with synthetic data</h1>
        <p className="demo-consent-requirement">
          The live demo can only be used after accepting first-party analytics cookies.
        </p>
        <p>
          Acceptance lets us measure coarse routes and demo actions so we can improve the
          experience. The demo uses synthetic jobs and stays in this browser; do not enter
          personal data, credentials, or secrets.
        </p>
        {initialChoice === "denied" ? (
          <p className="demo-consent-return-note">
            You previously declined. Accept now to enter, or decline again to return to
            jobctrl.dev.
          </p>
        ) : null}
        <p className="demo-consent-links">
          Read the <a href="https://jobctrl.dev/user/data-and-safety#public-demo">demo data notice</a>
          {" and "}
          <a href="https://jobctrl.dev/user/security#public-demo-boundary">security boundary</a>.
        </p>
        {error ? <p className="demo-consent-error" role="alert">{error}</p> : null}
        <div className="demo-consent-actions">
          <Button
            className="demo-consent-accept"
            size="lg"
            disabled={pending !== null}
            aria-busy={pending === "granted" || undefined}
            onClick={() => void accept()}
            type="button"
          >
            {pending === "granted" ? "Confirming…" : "Accept cookies and enter demo"}
          </Button>
          <Button
            className="demo-consent-decline"
            size="lg"
            variant="outline"
            disabled={pending !== null}
            aria-busy={pending === "denied" || undefined}
            onClick={() => void decline()}
            type="button"
          >
            {pending === "denied" ? "Leaving…" : "Decline and return to jobctrl.dev"}
          </Button>
        </div>
      </section>
    </main>
  );
}
