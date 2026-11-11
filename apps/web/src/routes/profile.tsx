import { Outlet, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jobsSearchSchema } from "./-jobs.search.js";

const profileSearchSchema = z.object({
  // Keep omission distinct from an explicit selection so a legacy #profile-*
  // anchor can select its peer section. The location resolver supplies the
  // ordinary Experience default when neither is present.
  section: z.enum(["experience", "skills", "education", "personal", "resume"]).optional().catch(undefined),
  roleId: z.string().min(1).optional().catch(undefined),
  achievementId: z.string().min(1).optional().catch(undefined),
  returnRequirement: z.string().min(1).optional().catch(undefined),
  returnRequirementsFilter: z.string().optional().catch(undefined),
  returnJobId: z.string().min(1).max(200).optional().catch(undefined),
  returnJobs: jobsSearchSchema.optional().catch(undefined),
  returnResumeMode: z.enum(["baseline", "tailored"]).optional().catch(undefined),
});

export const Route = createFileRoute("/profile")({
  validateSearch: (search) => profileSearchSchema.parse(search),
  component: ProfileLayout,
});

function ProfileLayout() {
  return <Outlet />;
}
