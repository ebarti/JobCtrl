import { createRequire } from "node:module";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(path.join(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

// Render only the canonical mark and the owned synthetic dashboard. No host
// profile, provider, browser state, external image or network request is used.
export async function renderDocsBrandAssets() {
  const source = await readFile(path.join(root, "apps/web/public/favicon.svg"), "utf8");
  const palettes = [...source.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) => match[1]);
  if (palettes.length !== 2) throw new Error("Expected light and dark palettes in the canonical favicon.");
  const fixedMark = (palette) => source.replace(/<style>[\s\S]*?<\/style>/, `<style>:root {${palette}}</style>`);
  const light = fixedMark(palettes[0]);
  const dark = fixedMark(palettes[1]);
  const dashboard = await readFile(path.join(root, "docs/assets/screenshots/dashboard.png"));
  const outputs = new Map([
    ["docs/public/favicon.svg", source],
    ["docs/public/assets/brand/app-mark-light.svg", light],
    ["docs/public/assets/brand/app-mark-dark.svg", dark],
  ]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, colorScheme: "light" });
    await page.route(/^https?:/, (route) => route.abort("blockedbyclient"));
    await page.setContent(`<html><body style="margin:0;background:white"><img alt="JobCtrl" style="width:100%;display:block" src="${dataUrl("image/svg+xml", light)}"></body></html>`);
    await page.locator("img").evaluate((image) => image.decode());
    const icon = await page.screenshot();
    outputs.set("docs/assets/brand/app-icon.png", icon);
    outputs.set("docs/public/assets/brand/app-icon.png", icon);
    await page.setViewportSize({ width: 180, height: 180 });
    outputs.set("docs/public/apple-touch-icon.png", await page.screenshot());

    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff; color: #0a0a0a; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
      main { width: 1200px; height: 630px; padding: 60px 62px 32px; position: relative; }
      .label { font-size: 16px; font-weight: 700; letter-spacing: 2px; }
      h1 { font-size: 48px; line-height: 1.12; letter-spacing: -1.5px; margin: 48px 0 38px; }
      p { font-size: 23px; line-height: 1.6; margin: 0; }
      .product { position: absolute; right: 44px; top: 108px; width: 552px; border: 1px solid #ccc; border-top: 3px solid #171717; }
      .brand { position: absolute; bottom: 60px; left: 62px; display: flex; gap: 12px; align-items: center; }
      .mark { width: 58px; height: 58px; }
      .name { font-size: 32px; font-weight: 700; line-height: 1.2; }
      .url { font-size: 20px; color: #626262; margin-top: 5px; }
      .rule { position: absolute; bottom: 32px; left: 62px; right: 62px; border-top: 1px solid #ccc; }
    </style></head><body><main>
      <div class="label">OPEN SOURCE · LOCAL-FIRST</div>
      <h1>Run your job search.<br>Keep your data.</h1>
      <p>Discover roles. Prove the fit.<br>Tailor truthfully. Approve before live submission.</p>
      <img class="product" alt="Synthetic JobCtrl dashboard" src="${dataUrl("image/png", dashboard)}">
      <div class="brand"><img class="mark" alt="" src="${dataUrl("image/svg+xml", light)}"><div><div class="name">JobCtrl</div><div class="url">jobctrl.dev</div></div></div>
      <div class="rule"></div>
    </main></body></html>`);
    await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    await page.evaluate(() => document.fonts.ready);
    outputs.set("docs/public/assets/brand/social-preview.png", await page.screenshot());
  } finally {
    await browser.close();
  }
  // Finish every render before replacing any accepted brand asset.
  for (const [relativePath, bytes] of outputs) {
    const destination = path.join(root, relativePath);
    const staged = `${destination}.next-${process.pid}`;
    await writeFile(staged, bytes);
    await rename(staged, destination);
  }
  console.log(`Rendered ${outputs.size} documentation brand assets from the canonical mark and synthetic dashboard.`);
}
