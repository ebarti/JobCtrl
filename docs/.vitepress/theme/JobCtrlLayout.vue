<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
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
let preferencesReady = false;

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
  collapseButton.value?.focus();
}

function resetSidebarWidth(): void {
  sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH;
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
        aria-controls="VPSidebarNav"
        aria-expanded="false"
        @click="expandSidebar"
      >
        Show navigation
      </button>
    </template>

    <template #sidebar-nav-before>
      <div class="jh-sidebar-controls">
        <div class="jh-sidebar-controls__heading">
          <label for="jh-sidebar-width">Navigation width</label>
          <output for="jh-sidebar-width">{{ sidebarWidth }}px</output>
        </div>
        <input
          id="jh-sidebar-width"
          v-model.number="sidebarWidth"
          class="jh-sidebar-controls__range"
          type="range"
          :min="SIDEBAR_MIN_WIDTH"
          :max="SIDEBAR_MAX_WIDTH"
          step="8"
        />
        <div class="jh-sidebar-controls__actions">
          <button type="button" @click="resetSidebarWidth">Reset width</button>
          <button
            ref="collapseButton"
            type="button"
            aria-controls="VPSidebarNav"
            aria-expanded="true"
            @click="collapseSidebar"
          >
            Collapse navigation
          </button>
        </div>
      </div>
    </template>
  </VitePressLayout>
</template>
