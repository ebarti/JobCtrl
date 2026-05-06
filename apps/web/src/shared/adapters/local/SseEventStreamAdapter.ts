import type {
  EventStreamPort,
  EventStreamStatus,
  EventStreamSubscription,
} from "../../ports/EventStreamPort.js";

export class SseEventStreamAdapter implements EventStreamPort {
  readonly status: EventStreamStatus = "stub";

  subscribe(): EventStreamSubscription {
    return {
      status: "stub",
      on: () => () => undefined,
      onStatusChange: () => () => undefined,
      close: () => undefined,
    };
  }
}
