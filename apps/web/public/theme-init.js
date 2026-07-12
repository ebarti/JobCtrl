// Pre-paint theme to avoid FOUC. Reads the Zustand persist serialization for
// useUiPreferencesStore (key jh:ui-preferences, version 1). A future persisted
// state migration must keep this small pre-paint reader in sync.
(function () {
  try {
    var raw = window.localStorage.getItem("jh:ui-preferences");
    var theme = "light";
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.state && parsed.state.theme === "dark") {
        theme = "dark";
      }
    }
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
