// Click-to-expand lightbox for VitePress docs. Zero dependencies.
//
// Mermaid diagrams are rendered CLIENT-SIDE after hydration, so eligibility is
// resolved through a single document-level click listener (event delegation)
// rather than binding to elements at mount time. The overlay is created on
// open and torn down on close so each session starts from clean state.

const MAX_SCALE = 8; // upper wheel/zoom bound
const HARD_MIN_SCALE = 0.25; // lower wheel/zoom bound (relaxed for huge diagrams)
const FIT_PADDING = 48; // px of breathing room around the fitted content
const ZOOM_STEP = 1.4; // toolbar-button / keyboard zoom multiplier
const WHEEL_SENSITIVITY = 0.0015; // deltaY -> scale factor
const DRAG_THRESHOLD = 4; // px of travel before a press counts as a pan
const MIN_IMAGE_SIZE = 100; // px; smaller images (icons) are not zoomable

type TriggerKind = "svg" | "img";

interface Trigger {
  kind: TriggerKind;
  // Source node cloned into the overlay + measured for fit. Mermaid replaces
  // its <svg> on re-render, so this is resolved fresh at open time.
  el: SVGSVGElement | HTMLImageElement;
  // Stable element that owns keyboard focus and receives it back on close. For
  // mermaid this is the persistent `.mermaid` container (the <svg> is swapped).
  focusTarget: HTMLElement | SVGElement;
}

interface Size {
  w: number;
  h: number;
}

let installed = false;
let overlayOpen = false;

/**
 * Install the document-level delegation. Idempotent so dev-server HMR cannot
 * stack duplicate listeners.
 */
export function setupLightbox(): void {
  if (installed) return;
  installed = true;

  // Opening is resolved via delegation (mermaid renders after hydration), but
  // triggers are also marked focusable + keyboard-activatable so keyboard users
  // can open the lightbox and focus can return to the trigger on close.
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentActivateKey);

  // Tag existing content, then keep tagging as client-rendered mermaid SVGs and
  // route changes add nodes. A MutationObserver (not per-node click binding) is
  // what makes this robust to VitePress's SPA navigation.
  const scheduleTag = rafDebounce(tagTriggers);
  scheduleTag();
  new MutationObserver(scheduleTag).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function onDocumentClick(event: MouseEvent): void {
  if (overlayOpen) return;
  // Leave modified clicks (open-in-new-tab, selection, etc.) untouched.
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const trigger = findTrigger(event.target as Element | null);
  if (!trigger) return;
  event.preventDefault();
  openLightbox(trigger);
}

function onDocumentActivateKey(event: KeyboardEvent): void {
  if (overlayOpen) return;
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  const active = document.activeElement as (HTMLElement & SVGElement) | null;
  if (!active?.dataset?.jhZoomable) return;
  const trigger = findTrigger(active);
  if (!trigger) return;
  event.preventDefault();
  openLightbox(trigger);
}

/** requestAnimationFrame-debounced wrapper so batched mutations run once. */
function rafDebounce(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

const pendingImages = new WeakSet<HTMLImageElement>();

/** Mark zoomable diagrams and images focusable, labelled, and cursor-hinted. */
function tagTriggers(): void {
  // Tag the persistent mermaid CONTAINER, not the <svg> (mermaid swaps the svg
  // on re-render, which would strip attributes set on it).
  document
    .querySelectorAll<HTMLElement>(
      ".vp-doc .mermaid:not([data-jh-zoomable]), .vp-doc .mermaid-wrapper:not([data-jh-zoomable])",
    )
    .forEach((container) => {
      if (container.querySelector("svg")) {
        tagTrigger(container, "svg", "Expand diagram (opens a zoomable view)");
      }
    });

  document
    .querySelectorAll<HTMLImageElement>(".vp-doc img:not([data-jh-zoomable])")
    .forEach((img) => {
      if (img.closest("a")) return;
      const evaluate = (): void => {
        const width = img.getBoundingClientRect().width || img.naturalWidth;
        if (width >= MIN_IMAGE_SIZE) {
          const label = img.alt ? `Expand image: ${img.alt}` : "Expand image (opens a zoomable view)";
          tagTrigger(img, "img", label);
        }
      };
      if (img.complete && (img.naturalWidth || img.getBoundingClientRect().width)) {
        evaluate();
      } else if (!pendingImages.has(img)) {
        pendingImages.add(img);
        img.addEventListener("load", evaluate, { once: true });
      }
    });
}

function tagTrigger(el: HTMLElement | SVGElement, kind: TriggerKind, label: string): void {
  el.dataset.jhZoomable = kind;
  el.setAttribute("tabindex", "0");
  el.setAttribute("role", "button");
  if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", label);
  el.style.cursor = "zoom-in";
}

/** Resolve the click target to a zoomable diagram or image, if any. */
function findTrigger(target: Element | null): Trigger | null {
  if (!target || typeof target.closest !== "function") return null;

  // Mermaid container (vitepress-plugin-mermaid renders into `.mermaid`). The
  // container is the stable focus target; the <svg> inside is re-resolved here.
  const container = target.closest<HTMLElement>(".vp-doc .mermaid, .vp-doc .mermaid-wrapper");
  if (container) {
    const svg = container.querySelector("svg");
    if (svg) return { kind: "svg", el: svg as SVGSVGElement, focusTarget: container };
  }

  // Fallback: a mermaid SVG reached directly (ids are `mermaid-*`).
  const svg = target.closest(".vp-doc svg") as SVGSVGElement | null;
  if (svg && (svg.id?.startsWith("mermaid") || svg.closest(".mermaid, .mermaid-wrapper"))) {
    return { kind: "svg", el: svg, focusTarget: svg };
  }

  // Content images: skip linked images (they navigate) and tiny icons.
  const img = target.closest(".vp-doc img") as HTMLImageElement | null;
  if (img && !img.closest("a")) {
    const width = img.getBoundingClientRect().width || img.naturalWidth;
    if (width >= MIN_IMAGE_SIZE) return { kind: "img", el: img, focusTarget: img };
  }

  return null;
}

/** Intrinsic size of the content to display (used for fit + centering math). */
function contentSize(trigger: Trigger): Size {
  if (trigger.kind === "img") {
    const img = trigger.el as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    return {
      w: img.naturalWidth || rect.width || 1,
      h: img.naturalHeight || rect.height || 1,
    };
  }
  const svg = trigger.el as SVGSVGElement;
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { w: box.width, h: box.height };
  }
  const rect = svg.getBoundingClientRect();
  return { w: rect.width || 1, h: rect.height || 1 };
}

/**
 * Produce the node shown in the overlay — always an <img>.
 *
 * Live mermaid SVGs must NOT be cloned into the DOM: the clone keeps the
 * original's id, and the mermaid component's re-render finds the duplicate and
 * corrupts it (doubled foreignObject label layers, wiped styles). Serializing
 * a detached copy into a data: URL <img> makes the expanded view a standalone
 * SVG document — immune to ids, observers, and component re-renders — and it
 * still scales as crisp vectors.
 */
function cloneContent(trigger: Trigger, size: Size): HTMLElement {
  const img = new Image();
  if (trigger.kind === "img") {
    const source = trigger.el as HTMLImageElement;
    img.src = source.currentSrc || source.src;
    img.alt = source.alt || "";
  } else {
    const svg = trigger.el.cloneNode(true) as SVGSVGElement;
    // KEEP the id: mermaid's embedded stylesheet is scoped to `#mermaid-N`
    // selectors, so stripping it renders everything with default (black) SVG
    // fills. Inside the standalone image document the duplicate id is harmless.
    // Pin real pixel dimensions (mermaid emits width="100%" + a max-width cap)
    // so the serialized document has an intrinsic size.
    svg.style.maxWidth = "none";
    svg.setAttribute("width", String(size.w));
    svg.setAttribute("height", String(size.h));
    if (!svg.getAttribute("xmlns")) {
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    const xml = new XMLSerializer().serializeToString(svg);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    img.alt = "Expanded diagram";
  }
  img.width = size.w;
  img.height = size.h;
  img.draggable = false;
  return img;
}

/** Open the overlay for the given trigger. */
function openLightbox(trigger: Trigger): void {
  if (overlayOpen) return;
  overlayOpen = true;

  const opener = document.activeElement as HTMLElement | null;
  // Focus returns to the stable trigger on close. Ensure it is focusable even
  // when the tagging pass has not reached it yet (e.g. a very fast mouse click).
  const focusTarget = trigger.focusTarget;
  if (!focusTarget.hasAttribute("tabindex")) focusTarget.setAttribute("tabindex", "-1");
  const size = contentSize(trigger);

  // --- scaffold ---------------------------------------------------------
  const overlay = document.createElement("div");
  overlay.className = "jh-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", trigger.kind === "svg" ? "Expanded diagram" : "Expanded image");
  overlay.tabIndex = -1;

  const stage = document.createElement("div");
  stage.className = "jh-lightbox__stage";

  const content = document.createElement("div");
  content.className = "jh-lightbox__content";
  content.style.width = `${size.w}px`;
  content.style.height = `${size.h}px`;
  content.appendChild(cloneContent(trigger, size));
  stage.appendChild(content);

  const toolbar = document.createElement("div");
  toolbar.className = "jh-lightbox__toolbar";
  const button = (label: string, glyph: string): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "jh-lightbox__btn";
    el.setAttribute("aria-label", label);
    el.textContent = glyph;
    return el;
  };
  const zoomOutBtn = button("Zoom out", "−"); // minus sign
  const zoomInBtn = button("Zoom in", "+");
  const resetBtn = button("Reset zoom", "⤢"); // fit / diagonal-resize glyph
  const closeBtn = button("Close", "×"); // multiplication sign
  toolbar.append(zoomOutBtn, zoomInBtn, resetBtn, closeBtn);

  overlay.append(stage, toolbar);
  document.body.appendChild(overlay);
  document.documentElement.classList.add("jh-lightbox-open");

  // --- transform state --------------------------------------------------
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const stageSize = (): Size => {
    const rect = stage.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  };

  const fitScale = (): number => {
    const st = stageSize();
    return Math.min((st.w - FIT_PADDING) / size.w, (st.h - FIT_PADDING) / size.h);
  };

  // Allow zooming out to whichever is smaller: the hard floor, or the scale
  // that fits an oversized diagram (so it is always fully viewable).
  const minScale = (): number => Math.min(HARD_MIN_SCALE, fitScale());

  const apply = (): void => {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const centerAt = (nextScale: number): void => {
    const st = stageSize();
    scale = nextScale;
    tx = (st.w - size.w * scale) / 2;
    ty = (st.h - size.h * scale) / 2;
    apply();
  };

  // Zoom to `nextScale` while keeping the content point under (cx, cy) fixed.
  const zoomTo = (nextScale: number, cx: number, cy: number): void => {
    const clamped = Math.max(minScale(), Math.min(MAX_SCALE, nextScale));
    const px = (cx - tx) / scale;
    const py = (cy - ty) / scale;
    scale = clamped;
    tx = cx - px * scale;
    ty = cy - py * scale;
    apply();
  };

  const reset = (): void => centerAt(fitScale());

  const zoomFromCenter = (multiplier: number): void => {
    const st = stageSize();
    zoomTo(scale * multiplier, st.w / 2, st.h / 2);
  };

  // --- lifecycle --------------------------------------------------------
  const focusable: HTMLButtonElement[] = [zoomOutBtn, zoomInBtn, resetBtn, closeBtn];

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      // Trap focus among the toolbar controls.
      const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
      if (index === -1) {
        event.preventDefault();
        focusable[0].focus();
      } else if (event.shiftKey && index === 0) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && index === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      }
      return;
    }
    if (event.key === "+" || event.key === "=") zoomFromCenter(ZOOM_STEP);
    else if (event.key === "-" || event.key === "_") zoomFromCenter(1 / ZOOM_STEP);
    else if (event.key === "0") reset();
  };

  const onResize = (): void => reset();

  function close(): void {
    if (!overlayOpen) return;
    overlayOpen = false;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
    document.documentElement.classList.remove("jh-lightbox-open");
    // Restore focus BEFORE removing the overlay: tearing down the currently
    // focused overlay would otherwise bounce focus to <body>. Fall back to
    // whatever was focused before if the trigger left the DOM.
    if (focusTarget.isConnected && typeof focusTarget.focus === "function") {
      focusTarget.focus({ preventScroll: true });
    } else if (opener && typeof opener.focus === "function") {
      opener.focus({ preventScroll: true });
    }
    overlay.remove();
  }

  // --- interaction ------------------------------------------------------
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * WHEEL_SENSITIVITY);
      zoomTo(scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;
  let activePointer = -1;

  stage.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = false;
    activePointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startTx = tx;
    startTy = ty;
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      moved = true;
      content.classList.add("is-panning");
    }
    if (moved) {
      tx = startTx + dx;
      ty = startTy + dy;
      apply();
    }
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    content.classList.remove("is-panning");
    if (activePointer !== -1 && stage.hasPointerCapture(activePointer)) {
      stage.releasePointerCapture(activePointer);
    }
    activePointer = -1;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Click on empty backdrop (not the diagram) closes; a completed pan does not.
  // Hit-test by coordinates, not event.target: setPointerCapture retargets the
  // derived click event to the stage, so target comparison would treat every
  // click on the content as a backdrop click and close the overlay.
  stage.addEventListener("click", (event) => {
    if (moved) return;
    const rect = content.getBoundingClientRect();
    const inContent =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inContent) close();
  });

  stage.addEventListener("dblclick", (event) => {
    const rect = stage.getBoundingClientRect();
    const fit = fitScale();
    if (Math.abs(scale - fit) < 0.01) {
      zoomTo(1, event.clientX - rect.left, event.clientY - rect.top);
    } else {
      reset();
    }
  });

  zoomInBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    zoomFromCenter(ZOOM_STEP);
  });
  zoomOutBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    zoomFromCenter(1 / ZOOM_STEP);
  });
  resetBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    reset();
  });
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
  });

  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);

  // Initial state: fit to viewport, centered, focus moved into the dialog.
  reset();
  overlay.focus();
}
