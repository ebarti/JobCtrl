import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

const jobctrlTheme = create({
  base: "light",
  brandTitle: "JobCtrl",
  brandTarget: "_self",
  colorPrimary: "#0f172a",
  colorSecondary: "#2563eb",
});

addons.setConfig({
  theme: jobctrlTheme,
  sidebar: {
    showRoots: true,
  },
});
