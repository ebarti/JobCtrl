import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_SURFACE_ROUTE_PATHS,
  SEMANTIC_PARITY_MANIFEST,
  routeCoverageFromManifest,
  type SemanticCategory,
} from "./semantic-parity-manifest.js";

const WEB_ROOT = process.cwd();
const REQUIRED_CATEGORIES: readonly SemanticCategory[] = [
  "visibleData",
  "controls",
  "unavailableStates",
  "auditProvenance",
];

describe("semantic parity manifest", () => {
  it("covers every rendered production route exactly once", () => {
    const routes = routeCoverageFromManifest();

    expect([...routes].sort()).toEqual([...PRODUCTION_SURFACE_ROUTE_PATHS].sort());
    expect(new Set(routes)).toHaveLength(routes.length);
  });

  it("keeps each surface reviewable through concrete categories, states, and locations", () => {
    expect(new Set(SEMANTIC_PARITY_MANIFEST.map((surface) => surface.id))).toHaveLength(
      SEMANTIC_PARITY_MANIFEST.length,
    );

    for (const surface of SEMANTIC_PARITY_MANIFEST) {
      expect(Object.keys(surface.categories).sort()).toEqual([...REQUIRED_CATEGORIES].sort());
      for (const category of REQUIRED_CATEGORIES) {
        expect(surface.categories[category].every((entry) => entry.trim().length > 0)).toBe(true);
      }

      expect(surface.locations.every((location) => location.keyboardReachable)).toBe(true);
      expect(surface.locations.every((location) => location.label.trim().length > 0)).toBe(true);
      expect(surface.proof.fixture.trim().length).toBeGreaterThan(0);
      expect(surface.proof.values.every((value) => value.trim().length > 0)).toBe(true);
      expect(surface.proof.roles.every((role) => role.trim().length > 0)).toBe(true);
      expect(surface.proof.labels.every((label) => label.trim().length > 0)).toBe(true);
      expect(surface.proof.statusDiscriminants.every((status) => status.trim().length > 0)).toBe(true);
    }
  });

  it("points to current route and component owners rather than an abstract checklist", () => {
    for (const surface of SEMANTIC_PARITY_MANIFEST) {
      for (const owner of [...surface.owners.routeModules, ...surface.owners.components]) {
        expect(existsSync(resolve(WEB_ROOT, owner))).toBe(true);
      }
    }
  });
});
