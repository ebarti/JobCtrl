import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { sampleMaterialExports } from "../../../test/fixtures/material-exports.js";
import { AcceptedMaterialExportPanel } from "./AcceptedMaterialExports.js";

const meta = {
  title: "Contexts/Materials/AcceptedMaterialExports",
  component: AcceptedMaterialExportPanel,
  args: {
    history: sampleMaterialExports(),
    pending: false,
    onExport: fn(),
    onDownload: fn(),
  },
} satisfies Meta<typeof AcceptedMaterialExportPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Accepted: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Letter" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Export resume DOCX" }),
    );
    await expect(args.onExport).toHaveBeenCalledWith(
      expect.objectContaining({
        paper: "Letter",
        sourceArtifactId: "accepted-resume",
      }),
    );
  },
};
export const Retained: Story = {
  args: { history: sampleMaterialExports(true) },
};
export const Creating: Story = {
  args: { history: sampleMaterialExports(true), pending: true },
};
export const SourceUnavailable: Story = {
  args: { history: sampleMaterialExports(true), sourceUnavailable: true },
};
export const NoAcceptedSource: Story = {
  args: { history: { ...sampleMaterialExports(), sources: [] } },
};
