import { invalidationRouter, type InvalidationRouter } from "../invalidation-router.js";

// Module-level singleton — stable reference for EventStreamProvider effect
// deps per target §7.3. If per-tenant routers ever ship, swap for a memoized
// cache without changing the hook signature.
export function useInvalidationRouter(): InvalidationRouter {
  return invalidationRouter;
}
