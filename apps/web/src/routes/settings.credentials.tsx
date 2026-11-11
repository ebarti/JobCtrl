import { createFileRoute } from "@tanstack/react-router";

// Retained deep link; the parent presents provider controls in Connections.
export const Route = createFileRoute("/settings/credentials")({ component: () => null });
