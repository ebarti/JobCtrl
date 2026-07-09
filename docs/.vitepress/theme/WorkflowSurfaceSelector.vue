<template>
  <div class="jh-channel-selector" role="tablist" aria-label="Choose workflow surface">
    <button
      type="button"
      class="jh-channel-selector__tab"
      data-jh-channel-tab="web"
      aria-selected="true"
    >
      Web app
    </button>
    <button
      type="button"
      class="jh-channel-selector__tab"
      data-jh-channel-tab="cli"
      aria-selected="false"
      tabindex="-1"
    >
      CLI
    </button>
  </div>
</template>
