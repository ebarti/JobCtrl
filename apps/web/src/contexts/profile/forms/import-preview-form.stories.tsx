import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportPreviewForm } from "./import-preview-form.js";

const meta = {
  title: "Contexts/Profile/Forms/ImportPreviewForm",
  component: ImportPreviewForm,
  parameters: {
    withRouter: true,
    initialPath: "/profile/import/preview",
  },
} satisfies Meta<typeof ImportPreviewForm>;

export default meta;
type Story = StoryObj<typeof meta>;

function StoreSeed({
  filename,
  importProfile,
  importStyle,
}: {
  filename: string;
  importProfile: boolean;
  importStyle: boolean;
}) {
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const setOptions = useProfileImportStore((state) => state.setOptions);
  const reset = useProfileImportStore((state) => state.reset);
  useEffect(() => {
    if (filename) {
      setUpload(filename, "JVBERi0xLjQK");
      setOptions(importProfile, importStyle);
    } else {
      reset();
    }
    return () => reset();
  }, [filename, importProfile, importStyle, setUpload, setOptions, reset]);
  return null;
}

export const NoUploadYet: Story = {
  render: () => (
    <>
      <StoreSeed filename="" importProfile={true} importStyle={true} />
      <ImportPreviewForm />
    </>
  ),
};

export const BothSelected: Story = {
  render: () => (
    <>
      <StoreSeed
        filename="jordan-resume-2026.pdf"
        importProfile={true}
        importStyle={true}
      />
      <ImportPreviewForm />
    </>
  ),
};

export const ProfileOnly: Story = {
  render: () => (
    <>
      <StoreSeed
        filename="jordan-resume-2026.pdf"
        importProfile={true}
        importStyle={false}
      />
      <ImportPreviewForm />
    </>
  ),
};
