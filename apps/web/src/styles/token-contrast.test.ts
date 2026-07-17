import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(resolve(styleDir, "tokens.css"), "utf8");
const globalsCss = readFileSync(resolve(styleDir, "globals.css"), "utf8");

const AA_NORMAL = 4.5;
const NON_TEXT_UI = 3;

type Oklch = { L: number; C: number; H: number };

const lightBlock = tokensCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
const darkBlock = tokensCss.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";

function readToken(block: string, token: string): Oklch {
  const raw = block.match(new RegExp(`--${token}:\\s*oklch\\(([^)]+)\\)`))?.[1];
  if (!raw) throw new Error(`token --${token} not found`);
  const [L, C = 0, H = 0] = raw.trim().split(/\s+/).map(Number);
  if (L === undefined) throw new Error(`token --${token} has no lightness`);
  return { L, C, H };
}

// OKLCH -> linear sRGB (Björn Ottosson's matrices).
function oklchToLinearSrgb({ L, C, H }: Oklch): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const encodeSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// Round to the 8-bit sRGB a browser renders, which is what axe-core samples.
function to8Bit(color: Oklch): [number, number, number] {
  return oklchToLinearSrgb(color).map((c) => Math.round(encodeSrgb(clamp01(c)) * 255)) as [
    number,
    number,
    number,
  ];
}

// WCAG relative luminance from 8-bit sRGB channels.
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (v: number) => {
    const cs = v / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(fg: Oklch, bg: Oklch): number {
  const l1 = relativeLuminance(to8Bit(fg));
  const l2 = relativeLuminance(to8Bit(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function cardHeaderRule(): string {
  return globalsCss.match(/\.card-hd\s*\{([^}]*)\}/)?.[1] ?? "";
}

describe("muted-foreground WCAG AA contrast", () => {
  it("CardHeader `.meta` renders on the muted card-header band, not the card body", () => {
    expect(cardHeaderRule(), "card header must fill its band with --muted").toContain(
      "background: var(--muted)",
    );
    expect(globalsCss, "`.meta` must resolve its color to --muted-foreground").toMatch(
      /\.meta,[\s\S]*?\{[\s\S]*?color:\s*var\(--muted-foreground\)/,
    );
  });

  it("clears 4.5:1 for muted-foreground on the muted card-header band in both themes", () => {
    const light = contrastRatio(readToken(lightBlock, "muted-foreground"), readToken(lightBlock, "muted"));
    const dark = contrastRatio(readToken(darkBlock, "muted-foreground"), readToken(darkBlock, "muted"));

    expect(light, `light muted-foreground on --muted was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(dark, `dark muted-foreground on --muted was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("clears 4.5:1 for muted-foreground on the card surface in both themes", () => {
    const light = contrastRatio(readToken(lightBlock, "muted-foreground"), readToken(lightBlock, "card"));
    const dark = contrastRatio(readToken(darkBlock, "muted-foreground"), readToken(darkBlock, "card"));

    expect(light, `light muted-foreground on --card was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(dark, `dark muted-foreground on --card was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("computes the pre-fix regression value so the guard cannot silently drift", () => {
    const regressed = contrastRatio({ L: 0.556, C: 0, H: 0 }, readToken(lightBlock, "muted"));
    expect(regressed, "the old oklch(0.556 0 0) must still measure below AA on --muted").toBeLessThan(
      AA_NORMAL,
    );
  });
});

describe("JobCtrl violet interaction contrast", () => {
  it("clears 4.5:1 for primary action text in both themes", () => {
    const light = contrastRatio(readToken(lightBlock, "primary-foreground"), readToken(lightBlock, "primary"));
    const dark = contrastRatio(readToken(darkBlock, "primary-foreground"), readToken(darkBlock, "primary"));

    expect(light, `light primary text was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(dark, `dark primary text was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("clears 4.5:1 for violet selection text in both themes", () => {
    const light = contrastRatio(readToken(lightBlock, "accent-foreground"), readToken(lightBlock, "accent"));
    const dark = contrastRatio(readToken(darkBlock, "accent-foreground"), readToken(darkBlock, "accent"));

    expect(light, `light accent text was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(dark, `dark accent text was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("keeps the focus indicator above 3:1 against the app canvas", () => {
    const light = contrastRatio(readToken(lightBlock, "ring"), readToken(lightBlock, "background"));
    const dark = contrastRatio(readToken(darkBlock, "ring"), readToken(darkBlock, "background"));

    expect(light, `light focus ring was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(NON_TEXT_UI);
    expect(dark, `dark focus ring was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(NON_TEXT_UI);
  });

  it("keeps active navigation text readable on the tinted rail", () => {
    const light = contrastRatio(
      readToken(lightBlock, "sidebar-accent-foreground"),
      readToken(lightBlock, "sidebar"),
    );
    const dark = contrastRatio(
      readToken(darkBlock, "sidebar-accent-foreground"),
      readToken(darkBlock, "sidebar"),
    );

    expect(light, `light active navigation text was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(dark, `dark active navigation text was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("keeps the navigation selection rule visible on the tinted rail", () => {
    const light = contrastRatio(readToken(lightBlock, "sidebar-primary"), readToken(lightBlock, "sidebar"));
    const dark = contrastRatio(readToken(darkBlock, "sidebar-primary"), readToken(darkBlock, "sidebar"));

    expect(light, `light navigation selection rule was ${light.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      NON_TEXT_UI,
    );
    expect(dark, `dark navigation selection rule was ${dark.toFixed(3)}:1`).toBeGreaterThanOrEqual(
      NON_TEXT_UI,
    );
  });
});
