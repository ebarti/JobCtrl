import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportUploadForm } from "./import-upload-form.js";

const meta = {
  title: "Contexts/Profile/Forms/ImportUploadForm",
  component: ImportUploadForm,
  parameters: {
    withRouter: true,
    initialPath: "/profile/import/upload",
  },
} satisfies Meta<typeof ImportUploadForm>;

export default meta;
type Story = StoryObj<typeof meta>;

function StoreSeed({ filename, pdfBase64 }: { filename: string; pdfBase64: string }) {
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const reset = useProfileImportStore((state) => state.reset);
  useEffect(() => {
    if (filename || pdfBase64) {
      setUpload(filename, pdfBase64);
    } else {
      reset();
    }
    return () => reset();
  }, [filename, pdfBase64, setUpload, reset]);
  return null;
}

export const Empty: Story = {
  render: () => (
    <>
      <StoreSeed filename="" pdfBase64="" />
      <ImportUploadForm />
    </>
  ),
};

export const FilePreloaded: Story = {
  render: () => (
    <>
      <StoreSeed filename="jordan-resume-2026.pdf" pdfBase64="JVBERi0xLjQK" />
      <ImportUploadForm />
    </>
  ),
};
