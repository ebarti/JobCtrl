import type { Meta, StoryObj } from "@storybook/react-vite";

import { ArtifactTypeBadge } from "./ArtifactTypeBadge.js";

const meta = {
  title: "Contexts/Materials/ArtifactTypeBadge",
  component: ArtifactTypeBadge,
} satisfies Meta<typeof ArtifactTypeBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResumePdf: Story = { args: { artifactType: "resume_pdf" } };
export const ResumeTex: Story = { args: { artifactType: "resume_tex" } };
export const CoverPdf: Story = { args: { artifactType: "cover_pdf" } };
export const CoverDocx: Story = { args: { artifactType: "cover_docx" } };
export const Unknown: Story = { args: { artifactType: "unknown_blob" } };
