import { useLayoutEffect, useState, type RefObject } from "react";

/** Allocate a desktop stage from its actual document position, independent of scroll. */
export function useAvailableViewportHeight(ref: RefObject<HTMLElement | null>, bottomPadding: number) {
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const documentTop = element.getBoundingClientRect().top + window.scrollY;
      const available = window.innerWidth > 900
        ? Math.max(96, Math.floor(window.innerHeight - documentTop - bottomPadding))
        : undefined;
      setHeight((previous) => previous === available ? previous : available);
    };
    const observer = new ResizeObserver(measure);
    // Header, toolbar and native density changes can move the stage without resizing it.
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, bottomPadding]);

  return height;
}
