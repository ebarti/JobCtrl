import type { Meta, StoryObj } from "@storybook/react-vite";
import { sampleCompanyBriefing } from "../../../test/fixtures/company-briefing.js";
import { CompanyBriefingPanel } from "./CompanyBriefingPanel.js";
const meta = { title: "Contexts/Materials/CompanyBriefingPanel", component: CompanyBriefingPanel } satisfies Meta<typeof CompanyBriefingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StaleAfterFailure: Story = { args: { briefing: sampleCompanyBriefing } };
export const Missing: Story = { args: { briefing: { ...sampleCompanyBriefing, accepted: null, lastAttempt: null, staleReasons: [], status: "missing" } } };
export const IdentityReview: Story = { args: { briefing: { ...sampleCompanyBriefing, status: "needs_review", staleReasons: ["identity_review_required"] } } };
