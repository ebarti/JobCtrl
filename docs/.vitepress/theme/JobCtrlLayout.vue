<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import DefaultTheme from "vitepress/theme";

const VitePressLayout = DefaultTheme.Layout;

const SIDEBAR_STORAGE_KEY = "jobctrl-docs-sidebar";
const SIDEBAR_MIN_WIDTH = 224;
const SIDEBAR_DEFAULT_WIDTH = 272;
const SIDEBAR_MAX_WIDTH = 320;

const sidebarExpanded = ref(true);
const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const collapseButton = ref<HTMLButtonElement | null>(null);
const restoreButton = ref<HTMLButtonElement | null>(null);
const resizeHandle = ref<HTMLElement | null>(null);
let preferencesReady = false;
let activePointerId: number | null = null;
let dragStartX = 0;
let dragStartWidth = SIDEBAR_DEFAULT_WIDTH;

function clampSidebarWidth(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(numeric)));
}

function applyPreferences(): void {
  document.documentElement.dataset.jhSidebarExpanded = String(sidebarExpanded.value);
  document.documentElement.style.setProperty("--jh-sidebar-width", `${sidebarWidth.value}px`);
}

function persistPreferences(): void {
  try {
    localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      JSON.stringify({ expanded: sidebarExpanded.value, width: sidebarWidth.value }),
    );
  } catch {
    // Storage can be unavailable in privacy modes. The deterministic in-memory
    // defaults still leave navigation reachable for the current page.
  }
}

async function collapseSidebar(): Promise<void> {
  sidebarExpanded.value = false;
  await nextTick();
  restoreButton.value?.focus();
}

async function expandSidebar(): Promise<void> {
  sidebarExpanded.value = true;
  await nextTick();
  const visibleCollapseButton = collapseButton.value?.getClientRects().length
    ? collapseButton.value
    : null;
  const fallbackTarget = document.querySelector<HTMLAnchorElement>(".VPNavBarTitle .title");
  (visibleCollapseButton ?? fallbackTarget)?.focus();
}

function resetSidebarWidth(): void {
  sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH;
}

function beginSidebarResize(event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0) return;

  activePointerId = event.pointerId;
  dragStartX = event.clientX;
  dragStartWidth = sidebarWidth.value;
  resizeHandle.value?.setPointerCapture(event.pointerId);
  document.documentElement.dataset.jhSidebarResizing = "true";
  event.preventDefault();
}

function resizeSidebar(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;

  const direction = getComputedStyle(document.documentElement).direction === "rtl" ? -1 : 1;
  sidebarWidth.value = clampSidebarWidth(
    dragStartWidth + ((event.clientX - dragStartX) * direction),
  );
}

function finishSidebarResize(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;

  if (resizeHandle.value?.hasPointerCapture(event.pointerId)) {
    resizeHandle.value.releasePointerCapture(event.pointerId);
  }
  activePointerId = null;
  delete document.documentElement.dataset.jhSidebarResizing;
}

function resizeSidebarWithKeyboard(event: KeyboardEvent): void {
  const direction = getComputedStyle(document.documentElement).direction === "rtl" ? -1 : 1;
  const increments: Partial<Record<KeyboardEvent["key"], number>> = {
    ArrowLeft: -8 * direction,
    ArrowRight: 8 * direction,
  };

  if (event.key === "Home") {
    sidebarWidth.value = SIDEBAR_MIN_WIDTH;
  } else if (event.key === "End") {
    sidebarWidth.value = SIDEBAR_MAX_WIDTH;
  } else if (increments[event.key] !== undefined) {
    sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + increments[event.key]!);
  } else {
    return;
  }

  event.preventDefault();
}

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_STORAGE_KEY) ?? "null") as {
      expanded?: unknown;
      width?: unknown;
    } | null;
    sidebarExpanded.value = typeof stored?.expanded === "boolean" ? stored.expanded : true;
    sidebarWidth.value = clampSidebarWidth(stored?.width);
  } catch {
    sidebarExpanded.value = true;
    sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH;
  }

  preferencesReady = true;
  applyPreferences();
});

onBeforeUnmount(() => {
  delete document.documentElement.dataset.jhSidebarResizing;
});

watch([sidebarExpanded, sidebarWidth], () => {
  sidebarWidth.value = clampSidebarWidth(sidebarWidth.value);
  if (!preferencesReady) return;
  applyPreferences();
  persistPreferences();
});
</script>

<template>
  <VitePressLayout>
    <template #nav-bar-content-before>
      <button
        v-if="!sidebarExpanded"
        ref="restoreButton"
        type="button"
        class="jh-sidebar-restore"
        aria-label="Show navigation"
        aria-controls="VPSidebarNav"
        aria-expanded="false"
        title="Show navigation"
        @click="expandSidebar"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <rect x="2.5" y="3" width="15" height="14" rx="2" />
          <path d="M7 3v14M10.5 7.5 13 10l-2.5 2.5" />
        </svg>
      </button>
    </template>

    <template #layout-bottom>
      <div v-if="sidebarExpanded" class="jh-sidebar-rail">
        <div
          ref="resizeHandle"
          class="jh-sidebar-resizer"
          role="separator"
          aria-label="Resize navigation"
          aria-controls="VPSidebarNav"
          aria-orientation="vertical"
          :aria-valuemin="SIDEBAR_MIN_WIDTH"
          :aria-valuemax="SIDEBAR_MAX_WIDTH"
          :aria-valuenow="sidebarWidth"
          :aria-valuetext="`${sidebarWidth} pixels`"
          tabindex="0"
          title="Drag to resize navigation. Double-click to reset."
          @pointerdown="beginSidebarResize"
          @pointermove="resizeSidebar"
          @pointerup="finishSidebarResize"
          @pointercancel="finishSidebarResize"
          @lostpointercapture="finishSidebarResize"
          @keydown="resizeSidebarWithKeyboard"
          @dblclick="resetSidebarWidth"
        />
        <button
          ref="collapseButton"
          type="button"
          class="jh-sidebar-collapse"
          aria-label="Collapse navigation"
          aria-controls="VPSidebarNav"
          aria-expanded="true"
          title="Collapse navigation"
          @click="collapseSidebar"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <rect x="2.5" y="3" width="15" height="14" rx="2" />
            <path d="M7 3v14m5.5-9.5L10 10l2.5 2.5" />
          </svg>
        </button>
      </div>
    </template>
  </VitePressLayout>
</template>
