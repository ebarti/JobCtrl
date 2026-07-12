interface DemoEdgeEnv {
  DEMO_TELEMETRY_DB: D1Database;
  PUBLIC_INGRESS_LIMITER: RateLimit;
  TELEMETRY_EDGE_LIMITER: RateLimit;
  DEMO_RELEASE: string;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}
