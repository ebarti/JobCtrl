import { createFileRoute } from "@tanstack/react-router";

import { InterviewsView } from "../views/interviews/InterviewsView.js";
import { interviewsSearchSchema } from "./-interviews.search.js";

export const Route = createFileRoute("/interviews")({
  validateSearch: (search) => interviewsSearchSchema.parse(search),
  component: InterviewsView,
});
