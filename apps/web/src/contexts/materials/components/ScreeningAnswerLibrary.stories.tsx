import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { ScreeningAnswerLibrary } from "./ScreeningAnswerLibrary.js";

const binding = { profileVersion: 1, profileHash: "a".repeat(64), postingHash: "b".repeat(64), destination: "https://example.test/apply", posting: "Synthetic posting", materials: [], facts: [], sensitiveFactIds: [] };
const meta = {
  title: "Contexts/Materials/ScreeningAnswerLibrary", component: ScreeningAnswerLibrary,
  parameters: { msw: { handlers: [http.get("*/v1/jobs/job-1/screening-answers", () => HttpResponse.json({ ok: true, jobId: "job-1", questions: [], history: [], library: [], facts: [], sourceBinding: binding, sourceFailure: null, determinations: [], failures: [] }))] } },
} satisfies Meta<typeof ScreeningAnswerLibrary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Capture: Story = { args: { jobId: "job-1", initialOpen: true } };
export const Unavailable: Story = { args: { jobId: "job-1", initialOpen: true }, parameters: { msw: { handlers: [http.get("*/v1/jobs/job-1/screening-answers", () => HttpResponse.json({ error: "unavailable" }, { status: 503 }))] } } };
