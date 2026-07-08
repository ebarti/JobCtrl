<template>
  <div class="jh-channel-panel" :data-jh-channel-panel="surface">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  surface: "web" | "cli";
}>();
</script>
