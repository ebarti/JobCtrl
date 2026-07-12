<script setup lang="ts">
import { computed, ref } from "vue";
import applyReviewScreenshot from "../../assets/screenshots/apply-review.png";
import jobsScreenshot from "../../assets/screenshots/jobs.png";

const screenshots = [
  {
    alt: "Jobs table with fit scores, stages, and filters",
    caption: "scored and filterable, with every score inspectable",
    image: jobsScreenshot,
    title: "Jobs",
  },
  {
    alt: "Apply Review editing a tailored resume with audit evidence",
    caption: "edit and approve the exact resume that ships",
    image: applyReviewScreenshot,
    title: "Apply Review",
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
