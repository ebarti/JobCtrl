import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const jobhunterTheme = create({
  base: "light",
  brandTitle: "JobHunter",
  brandTarget: "_self",
  colorPrimary: "#0f172a",
  colorSecondary: "#2563eb",
});

addons.setConfig({
  theme: jobhunterTheme,
  sidebar: {
    showRoots: true,
  },
});
