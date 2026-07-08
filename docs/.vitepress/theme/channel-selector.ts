import type { Router } from "vitepress";

type WorkflowSurface = "web" | "cli";

const DEFAULT_SURFACE: WorkflowSurface = "web";
const SURFACES = new Set<WorkflowSurface>(["web", "cli"]);

let installed = false;
let selected: WorkflowSurface = DEFAULT_SURFACE;

function isWorkflowSurface(value: string | undefined): value is WorkflowSurface {
  return value === "web" || value === "cli";
}

function apply(): void {
  document.documentElement.dataset.jhWorkflowSurface = selected;

  document.querySelectorAll<HTMLButtonElement>("[data-jh-channel-tab]").forEach((button) => {
    const surface = button.dataset.jhChannelTab;
    const active = surface === selected;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll<HTMLElement>("[data-jh-channel-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.jhChannelPanel !== selected;
  });
}

function select(surface: WorkflowSurface): void {
  selected = surface;
  apply();
}

function moveFrom(button: HTMLButtonElement, direction: -1 | 1): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-jh-channel-tab]")];
  const current = tabs.indexOf(button);
  if (current === -1) return;
  const next = tabs[(current + direction + tabs.length) % tabs.length];
  const surface = next.dataset.jhChannelTab;
  if (!isWorkflowSurface(surface) || !SURFACES.has(surface)) return;
  select(surface);
  next.focus();
}

function onClick(event: MouseEvent): void {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-jh-channel-tab]");
  const surface = button?.dataset.jhChannelTab;
  if (!isWorkflowSurface(surface)) return;
  event.preventDefault();
  select(surface);
}

function onKeydown(event: KeyboardEvent): void {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-jh-channel-tab]");
  if (!button) return;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveFrom(button, 1);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveFrom(button, -1);
  } else if (event.key === "Home" || event.key === "End") {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-jh-channel-tab]")];
    const next = event.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
    const surface = next?.dataset.jhChannelTab;
    if (!next || !isWorkflowSurface(surface)) return;
    event.preventDefault();
    select(surface);
    next.focus();
  }
}

export function setupChannelSelector(router: Router): void {
  if (!installed) {
    installed = true;
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
  }

  const prior = router.onAfterRouteChange;
  router.onAfterRouteChange = async (to) => {
    await prior?.(to);
    requestAnimationFrame(apply);
  };

  requestAnimationFrame(apply);
}
