// Small accessibility repair for VitePress local search.
//
// The stock local-search icon buttons expose useful `title` attributes, but
// not stable accessible names. Keep the patch in the theme layer so upstream
// VitePress markup stays untouched and the fix survives route changes.

let installed = false;

const SEARCH_BUTTON_LABELS: Array<[string, string]> = [
  [".VPLocalSearchBox .back-button", "Close search"],
  [".VPLocalSearchBox .toggle-layout-button", "Toggle detailed search results"],
  [".VPLocalSearchBox .clear-button", "Clear search"],
];

export function setupSearchA11y(): void {
  if (installed) return;
  installed = true;

  const apply = (): void => {
    for (const [selector, fallback] of SEARCH_BUTTON_LABELS) {
      document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
        const label = button.getAttribute("title") || fallback;
        if (!button.getAttribute("aria-label")) {
          button.setAttribute("aria-label", label);
        }
      });
    }
  };

  apply();
  new MutationObserver(apply).observe(document.body, {
    childList: true,
    subtree: true,
  });
}
