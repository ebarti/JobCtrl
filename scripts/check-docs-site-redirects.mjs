#!/usr/bin/env node
// Post-build redirect contract for the static Cloudflare Pages deployment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] ?? "docs/.vitepress/dist";
const redirect = "/user/screenshots /user/product-tour 301";
const redirectsPath = join(dist, "_redirects");
const productTourPage = join(dist, "user", "product-tour.html");
const legacyTourPage = join(dist, "user", "screenshots.html");

if (!existsSync(redirectsPath)) {
  console.error(`docs redirect check FAILED: missing ${redirectsPath}`);
  process.exit(1);
}

const redirects = readFileSync(redirectsPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

if (!redirects.includes(redirect)) {
  console.error(`docs redirect check FAILED: missing ${redirect}`);
  process.exit(1);
}
if (!existsSync(productTourPage)) {
  console.error(`docs redirect check FAILED: missing canonical page ${productTourPage}`);
  process.exit(1);
}
if (existsSync(legacyTourPage)) {
  console.error(`docs redirect check FAILED: legacy page was emitted at ${legacyTourPage}`);
  process.exit(1);
}

console.log("docs redirect check passed: legacy Product Tour URL permanently redirects to /user/product-tour.");
