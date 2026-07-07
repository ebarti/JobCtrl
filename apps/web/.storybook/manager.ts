import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const jobctlTheme = create({
  base: "light",
  brandTitle: "JobCtl",
  brandTarget: "_self",
  colorPrimary: "#0f172a",
  colorSecondary: "#2563eb",
});

addons.setConfig({
  theme: jobctlTheme,
  sidebar: {
    showRoots: true,
  },
});
