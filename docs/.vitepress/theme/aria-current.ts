import type { Router } from "vitepress";

// VitePress marks the active sidebar/nav link with CSS classes only; assistive
// tech needs aria-current="page". Applied by href comparison after every route
// change (progressive enhancement — nothing here affects rendering).

function normalize(pathname: string): string {
  return pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
}

function apply(): void {
  const current = normalize(location.pathname);
  const links = document.querySelectorAll<HTMLAnchorElement>(
    ".VPSidebar a[href], .VPNavBar a[href]",
  );
  for (const a of links) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      a.removeAttribute("aria-current");
      continue;
    }
    const target = normalize(new URL(href, location.origin).pathname);
    if (target === current) {
      a.setAttribute("aria-current", "page");
    } else {
      a.removeAttribute("aria-current");
    }
  }
}

export function setupAriaCurrent(router: Router): void {
  const prior = router.onAfterRouteChange;
  router.onAfterRouteChange = async (to) => {
    await prior?.(to);
    // The sidebar re-renders in the same tick; defer one frame + a beat so the
    // active trail (including auto-expanded groups) is in the DOM.
    requestAnimationFrame(() => setTimeout(apply, 60));
  };
  requestAnimationFrame(() => setTimeout(apply, 60));
}
