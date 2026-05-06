import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";

export const Route = createFileRoute("/profile/")({
  component: ProfileEditor,
});
