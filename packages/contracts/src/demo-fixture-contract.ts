/**
 * Semantic overlap between the long-lived API QA workspace and the public
 * demo seed. This is deliberately small: the QA fixture is a database setup,
 * while the P0 demo is an ApiClientPort-shaped browser fixture. Full response
 * parity requires the P2 adapter/read API; until then both fixtures must keep
 * these existing stage lifecycle facts.
 */
export const QA_DEMO_SHARED_LIFECYCLE_STATES = ["succeeded", "failed", "blocked"] as const;
