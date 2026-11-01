import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
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
  const { storage } = usePorts();
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const setOptions = useProfileImportStore((state) => state.setOptions);
  const reset = useProfileImportStore((state) => state.reset);
  useEffect(() => {
    let active = true;
    void (async () => {
      await useProfileImportStore.getState().hydrate(storage);
      if (!active) return;
      if (filename) {
        if (
          (await setUpload(filename, "JVBERi0xLjQK", storage, () => active)) &&
          active
        )
          await setOptions(importProfile, importStyle, storage);
      } else await reset(storage, () => active);
    })();
    return () => {
      active = false;
    };
  }, [
    filename,
    importProfile,
    importStyle,
    setUpload,
    setOptions,
    reset,
    storage,
  ]);
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
      <StoreSeed
        filename="jordan-resume-2026.pdf"
        importProfile={true}
        importStyle={true}
      />
      <ImportConfirmForm />
    </>
  ),
};

export const ConfirmProfileOnly: Story = {
  render: () => (
    <>
      <StoreSeed
        filename="jordan-resume-2026.pdf"
        importProfile={true}
        importStyle={false}
      />
      <ImportConfirmForm />
    </>
  ),
};
