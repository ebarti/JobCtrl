import type { QueryKey } from "@tanstack/react-query";

import type { DomainEventEnvelope } from "./EventStreamPort.js";

/** Each feature maps a committed event to its own affected query keys. */
export interface FeatureEventHandler {
  readonly eventTypes: readonly string[];
  handle(event: DomainEventEnvelope, invalidate: (queryKey: QueryKey) => void): void;
}
