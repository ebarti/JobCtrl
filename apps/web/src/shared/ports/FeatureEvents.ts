import type { QueryClient } from "@tanstack/react-query";

import type { DomainEventEnvelope } from "./EventStreamPort.js";

/** A feature declares its committed event names and owns their cache effects. */
export interface FeatureEventHandler {
  readonly eventTypes: readonly string[];
  handle(event: DomainEventEnvelope, queryClient: QueryClient): void;
}
