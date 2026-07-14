import type { FileRoutesByFullPath } from "../../src/routeTree.gen.js";
import {
  PRODUCTION_SURFACE_ROUTE_PATHS,
  type ProductionSurfaceRoutePath,
} from "../../src/qa/semantic-parity-manifest.js";
import { expectTypeOf, test } from "vitest";

type RenderedProductionRoute = Exclude<
  keyof FileRoutesByFullPath,
  "/" | "/spikes/table-filters"
>;

test("semantic parity inventory remains exhaustive for the generated production router", () => {
  expectTypeOf<ProductionSurfaceRoutePath>().toEqualTypeOf<RenderedProductionRoute>();
  expectTypeOf<(typeof PRODUCTION_SURFACE_ROUTE_PATHS)[number]>().toEqualTypeOf<
    RenderedProductionRoute
  >();
});
