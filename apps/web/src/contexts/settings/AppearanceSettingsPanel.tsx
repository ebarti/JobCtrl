import { COLOR_SCHEMES, FONT_SCHEMES, isColorScheme, isFontScheme } from "../../shared/stores/appearance-options.js";
import { useUiPreferencesStore } from "../../shared/stores/ui-preferences.js";
import { Button } from "../../shared/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";

export function AppearanceSettingsPanel() {
  const theme = useUiPreferencesStore((state) => state.theme);
  const density = useUiPreferencesStore((state) => state.density);
  const setTheme = useUiPreferencesStore((state) => state.setTheme);
  const setDensity = useUiPreferencesStore((state) => state.setDensity);
  const colorScheme = useUiPreferencesStore((state) => state.colorScheme);
  const fontScheme = useUiPreferencesStore((state) => state.fontScheme);
  const setColorScheme = useUiPreferencesStore((state) => state.setColorScheme);
  const setFontScheme = useUiPreferencesStore((state) => state.setFontScheme);
  const resetAppearance = useUiPreferencesStore((state) => state.resetAppearance);

  return (
    <section className="appearance-settings" aria-labelledby="appearance-settings-title">
      <div className="appearance-settings__intro">
        <h2 id="appearance-settings-title">Make it yours</h2>
        <p>Changes apply immediately and save automatically in this browser.</p>
      </div>
      <div className="appearance-settings__content">
        <div className="appearance-settings__fields">
          <div className="appearance-settings__field">
            <label htmlFor="appearance-theme">Mode</label>
            <Select value={theme} onValueChange={(value) => { if (value === "light" || value === "dark") setTheme(value); }}>
              <SelectTrigger id="appearance-theme"><SelectValue>{theme === "light" ? "Light" : "Dark"}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="appearance-settings__field">
            <label htmlFor="appearance-density">Density</label>
            <Select value={density} onValueChange={(value) => { if (value === "compact" || value === "regular" || value === "comfy") setDensity(value); }}>
              <SelectTrigger id="appearance-density"><SelectValue>{({ compact: "Compact", regular: "Regular", comfy: "Comfy" } as const)[density]}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="compact">Compact</SelectItem><SelectItem value="regular">Regular</SelectItem><SelectItem value="comfy">Comfy</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="appearance-settings__field">
            <label htmlFor="appearance-color-scheme">Color scheme</label>
            <Select value={colorScheme} onValueChange={(value) => { if (isColorScheme(value)) setColorScheme(value); }}>
              <SelectTrigger id="appearance-color-scheme"><SelectValue>{COLOR_SCHEMES.find((item) => item.id === colorScheme)?.label}</SelectValue></SelectTrigger>
              <SelectContent>{COLOR_SCHEMES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="appearance-settings__field">
            <label htmlFor="appearance-font-scheme">Font scheme</label>
            <Select value={fontScheme} onValueChange={(value) => { if (isFontScheme(value)) setFontScheme(value); }}>
              <SelectTrigger id="appearance-font-scheme"><SelectValue>{FONT_SCHEMES.find((item) => item.id === fontScheme)?.label}</SelectValue></SelectTrigger>
              <SelectContent>{FONT_SCHEMES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="appearance-settings__sample">
          <span className="appearance-settings__eyebrow">Preview</span>
          <h3>A little more you.</h3>
          <p>Your opportunities, experience and next steps, in a workspace that feels right.</p>
          <div className="appearance-settings__sample-meta"><span className="appearance-settings__saved">Saved</span><span>Body text · 14 px</span><span className="appearance-settings__swatch" aria-label="Selected accent color" /></div>
        </div>
        <div className="appearance-settings__actions">
          <Button variant="outline" onClick={resetAppearance}>Restore Graphite &amp; Geist</Button>
          <span>Resume typography follows its document template.</span>
        </div>
      </div>
    </section>
  );
}
