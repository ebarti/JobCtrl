<script setup lang="ts">
import {
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import {
  docsAnalyticsControllerKey,
  type DocsAnalyticsConsentChoice,
} from "./docs-analytics";

const controller = inject(docsAnalyticsControllerKey);
if (!controller) {
  throw new Error("Docs analytics controller is unavailable.");
}

const mounted = ref(false);
const open = ref(false);
const choice = ref<DocsAnalyticsConsentChoice | null>(null);
const heading = ref<HTMLHeadingElement | null>(null);
const announcement = ref("");
let returnFocus: HTMLElement | null = null;

function focusSettings(): void {
  void nextTick(() => heading.value?.focus());
}

function openSettings(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest<HTMLElement>("[data-jh-cookie-settings]");
  if (!trigger) return;

  event.preventDefault();
  returnFocus = trigger;
  open.value = true;
  focusSettings();
}

function closeSettings(): void {
  if (choice.value === null) return;
  open.value = false;
  const target = returnFocus;
  returnFocus = null;
  void nextTick(() => {
    const fallback = document.querySelector<HTMLElement>(
      ".VPNavBarTitle .title",
    );
    (target ?? fallback)?.focus();
  });
}

function selectChoice(nextChoice: DocsAnalyticsConsentChoice): void {
  let reloadToUnloadAnalytics = false;
  if (nextChoice === "denied") {
    // An explicit decline is authoritative even if this tab has stale UI
    // state from before another tab changed the origin-wide stored choice.
    reloadToUnloadAnalytics = controller.deny();
    announcement.value = "Documentation analytics disabled.";
    choice.value = nextChoice;
  } else if (nextChoice !== choice.value) {
    controller.grant();
    announcement.value = "Documentation analytics enabled.";
    choice.value = nextChoice;
  }
  if (reloadToUnloadAnalytics) {
    window.location.reload();
    return;
  }
  closeSettings();
}

onMounted(() => {
  mounted.value = true;
  choice.value = controller.getConsentChoice();
  open.value = choice.value === null;
  document.addEventListener("click", openSettings);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", openSettings);
});
</script>

<template>
  <p class="jh-visually-hidden" aria-live="polite">{{ announcement }}</p>
  <aside
    v-if="mounted && open"
    class="jh-cookie-banner"
    aria-labelledby="jh-cookie-banner-title"
    data-jh-cookie-banner
  >
    <button
      v-if="choice !== null"
      type="button"
      class="jh-cookie-banner__close"
      aria-label="Close cookie settings"
      @click="closeSettings"
    >
      <span aria-hidden="true">×</span>
    </button>
    <div class="jh-cookie-banner__copy">
      <p class="jh-cookie-banner__eyebrow">Your privacy choice</p>
      <h2
        id="jh-cookie-banner-title"
        ref="heading"
        tabindex="-1"
      >
        Optional documentation analytics
      </h2>
      <p>
        Google Analytics helps us understand which docs are useful. It stays
        off until you accept, and advertising and personalization signals are
        disabled.
      </p>
      <p v-if="choice !== null" class="jh-cookie-banner__current">
        Current choice:
        <strong>{{ choice === "granted" ? "analytics enabled" : "analytics disabled" }}</strong>.
      </p>
      <a href="/user/data-and-safety#documentation-site-analytics">
        Read the analytics and cookie details
      </a>
    </div>
    <div class="jh-cookie-banner__actions">
      <button
        type="button"
        class="jh-cookie-banner__button jh-cookie-banner__button--secondary"
        @click="selectChoice('denied')"
      >
        Decline analytics
      </button>
      <button
        type="button"
        class="jh-cookie-banner__button jh-cookie-banner__button--primary"
        @click="selectChoice('granted')"
      >
        Accept analytics
      </button>
    </div>
  </aside>
</template>
