import { handlers } from "./handlers.js";
import { resetInterviewMocks } from "./interview-handlers.js";
import { installDefaultHandlers } from "./server.js";

// Only provider-backed tests need the full API fixture graph. The shared setup
// still rejects unhandled requests in all other tests.
installDefaultHandlers(handlers, resetInterviewMocks);
