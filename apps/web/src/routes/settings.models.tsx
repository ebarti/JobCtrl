import { createFileRoute } from "@tanstack/react-router";

// Retained deep link; the parent presents model controls in Connections.
export const Route = createFileRoute("/settings/models")({ component: () => null });
