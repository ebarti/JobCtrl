import { useState, type ReactElement, type JSX } from "react";

/**
 * Keep open-page work mounted under the immutable target that owns it. A
 * target switch hides/inerts the old session synchronously, so a cached new
 * recipient cannot acquire its editor, pending callbacks or reconciliation.
 * Callers key this boundary by tenant to drop private work on tenant changes.
 */
export function RetainedOutreachSessions({
  targetKey,
  children,
}: {
  targetKey: string;
  children: ReactElement;
}): JSX.Element {
  const [sessions, setSessions] = useState([{ targetKey, content: children }]);
  if (!sessions.some((session) => session.targetKey === targetKey)) {
    // Adjust during render, before any new target UI commits; an effect would
    // leave a render in which the old session could act on the new target.
    setSessions([...sessions, { targetKey, content: children }]);
  }
  return <>{sessions.map((session) => (
    <div key={session.targetKey} hidden={session.targetKey !== targetKey} inert={session.targetKey !== targetKey}>
      {session.targetKey === targetKey ? children : session.content}
    </div>
  ))}</>;
}
