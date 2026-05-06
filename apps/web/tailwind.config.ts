import type { Config } from "tailwindcss";

export default {
  darkMode: ["selector", "[data-theme='dark']"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        rule: "var(--rule)",
        "rule-2": "var(--rule-2)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        soft: "var(--soft)",
        danger: "var(--danger)",
        warn: "var(--warn)",
        ok: "var(--ok)",
        info: "var(--info)",
      },
      fontFamily: {
        sans: ["var(--font)"],
        mono: ["var(--mono)"],
      },
    },
  },
} satisfies Config;
