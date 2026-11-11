import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Reveal the current route within its own scrollable tab strip. */
export function WorkspaceTabs({
  label,
  activeKey,
  className = "",
  children,
}: {
  readonly label: string;
  readonly activeKey: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!nav || !active) return;

    const reveal = () => {
      const container = nav.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      const right = container.left + nav.clientWidth;
      if (tab.left < container.left) nav.scrollLeft += tab.left - container.left;
      else if (tab.right > right) nav.scrollLeft += tab.right - right;
    };

    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    observer.observe(active);
    return () => observer.disconnect();
  }, [activeKey]);

  return <nav ref={navRef} className={`workspace-tabs ${className}`.trim()} aria-label={label}>{children}</nav>;
}
