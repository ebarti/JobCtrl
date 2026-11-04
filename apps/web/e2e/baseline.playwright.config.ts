import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// This flow edits the canonical synthetic profile and its material generations.
// Run in a fresh owned workspace, separate from unrelated browser fixtures.
export default defineConfig({ ...base, testDir: "./baseline-tests" });
