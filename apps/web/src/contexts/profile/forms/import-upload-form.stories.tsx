import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
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

function StoreSeed({
  filename,
  pdfBase64,
}: {
  filename: string;
  pdfBase64: string;
}) {
  const { storage } = usePorts();
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const reset = useProfileImportStore((state) => state.reset);
  useEffect(() => {
    let active = true;
    void (async () => {
      await useProfileImportStore.getState().hydrate(storage);
      if (!active) return;
      if (filename || pdfBase64)
        await setUpload(filename, pdfBase64, storage, () => active);
      else await reset(storage, () => active);
    })();
    return () => {
      active = false;
    };
  }, [filename, pdfBase64, setUpload, reset, storage]);
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
