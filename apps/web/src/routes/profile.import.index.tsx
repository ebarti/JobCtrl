import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/profile/import/")({
  beforeLoad: () => {
    throw redirect({ to: "/profile/import/upload" });
  },
});
