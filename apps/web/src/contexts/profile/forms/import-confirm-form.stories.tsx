import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportConfirmForm } from "./import-confirm-form.js";

const meta = {
  title: "Contexts/Profile/Forms/ImportConfirmForm",
  component: ImportConfirmForm,
  parameters: {
    withRouter: true,
    initialPath: "/profile/import/confirm",
  },
} satisfies Meta<typeof ImportConfirmForm>;

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
      <ImportConfirmForm />
    </>
  ),
};

export const ConfirmBoth: Story = {
  render: () => (
    <>
      <StoreSeed filename="jordan-resume-2026.pdf" importProfile={true} importStyle={true} />
      <ImportConfirmForm />
    </>
  ),
};

export const ConfirmProfileOnly: Story = {
  render: () => (
    <>
      <StoreSeed filename="jordan-resume-2026.pdf" importProfile={true} importStyle={false} />
      <ImportConfirmForm />
    </>
  ),
};
