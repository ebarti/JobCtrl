<script setup lang="ts">
import { computed, ref } from "vue";
import resumeScreenshot from "../../assets/screenshots/original-resume.png";
import jobsScreenshot from "../../assets/screenshots/original-jobs.png";

const screenshots = [
  {
    alt: "Original Jobs table with recorded pay, fit and application state",
    caption: "compare recorded pay, fit and application state",
    image: jobsScreenshot,
    title: "Jobs",
  },
  {
    alt: "Selected job Resume tab with the actual Plate editor",
    caption: "prepare and edit the actual document beside its job",
    image: resumeScreenshot,
    title: "Resume",
  },
] as const;

const activeIndex = ref(0);
const activeScreenshot = computed(() => screenshots[activeIndex.value] ?? screenshots[0]);

function showPrevious(): void {
  activeIndex.value = Math.max(0, activeIndex.value - 1);
}

function showNext(): void {
  activeIndex.value = Math.min(screenshots.length - 1, activeIndex.value + 1);
}
</script>

<template>
  <section
    class="jh-comparison-screenshot-carousel"
    data-jh-comparison-carousel
    role="group"
    aria-roledescription="carousel"
    aria-label="JobCtrl product screenshots"
  >
    <figure class="jh-comparison-screenshot-carousel__figure">
      <img
        :key="activeScreenshot.image"
        class="jh-comparison-screenshot-carousel__image"
        :src="activeScreenshot.image"
        :alt="activeScreenshot.alt"
      />
      <figcaption class="jh-comparison-screenshot-carousel__caption">
        <strong>{{ activeScreenshot.title }}</strong> — {{ activeScreenshot.caption }}
      </figcaption>
    </figure>

    <div class="jh-comparison-screenshot-carousel__controls">
      <button
        type="button"
        class="jh-comparison-screenshot-carousel__button"
        :disabled="activeIndex === 0"
        @click="showPrevious"
      >
        Previous
      </button>
      <p
        class="jh-comparison-screenshot-carousel__status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ activeIndex + 1 }} of {{ screenshots.length }}
      </p>
      <button
        type="button"
        class="jh-comparison-screenshot-carousel__button"
        :disabled="activeIndex === screenshots.length - 1"
        @click="showNext"
      >
        Next
      </button>
    </div>
  </section>
</template>
