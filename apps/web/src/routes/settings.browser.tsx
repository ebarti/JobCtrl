import { createFileRoute } from "@tanstack/react-router";

// Retained deep link; the parent opens Browser and extension in Connections.
export const Route = createFileRoute("/settings/browser")({ component: () => null });
