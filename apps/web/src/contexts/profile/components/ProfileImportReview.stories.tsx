import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { useProfileImportReviewStore, type ProfileImportReviewDraft } from "../stores/profile-import-review-store.js";
import { ProfileImportReview } from "./ProfileImportReview.js";

const meta = {
  title: "Contexts/Profile/ImportReview",
  component: ProfileImportReview,
} satisfies Meta<typeof ProfileImportReview>;
export default meta;
type Story = StoryObj<typeof meta>;

function SyntheticDraft() {
  const tenantId = useTenantId();
  const { storage } = usePorts();
  useEffect(() => {
    const store = useProfileImportReviewStore.getState();
    let active = true;
    let draft: ProfileImportReviewDraft | undefined;
    void store.stage({
      tenantId,
      filename: "synthetic-resume.pdf",
      importProfile: true,
      importStyle: true,
      base: sampleProfileResponse,
      result: {
        profile: {
          personal: { full_name: "Synthetic candidate" },
          resume: {
            experience_entries: [
              {
                title: "Platform engineer",
                company: "Example company",
                bullets: ["Built a synthetic platform."],
              },
            ],
          },
        },
        style: { font_family: "sans" },
        source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64),
          extractedPersonal: { full_name: "Synthetic candidate" }, styleReceiptId: "00000000-0000-4000-8000-000000000001",
          inferredStyle: { font_family: "sans" } },
      },
    }, storage).then(() => {
      draft = useProfileImportReviewStore.getState().drafts.find((item) => item.filename === "synthetic-resume.pdf");
      if (!active && draft) void useProfileImportReviewStore.getState().discard(draft, storage);
    });
    return () => {
      active = false;
      if (draft) void useProfileImportReviewStore.getState().discard(draft, storage);
    };
  }, [tenantId, storage]);
  return <ProfileImportReview />;
}

export const Draft: Story = { render: () => <SyntheticDraft /> };
