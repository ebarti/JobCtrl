import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useOutreachImportStore } from "../stores/outreach-import-store.js";
import { ContactImportWizard } from "./contact-import-wizard.js";

const meta = {
  title: "Contexts/Outreach/Forms/ContactImportWizard",
  component: ContactImportWizard,
} satisfies Meta<typeof ContactImportWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

function StoreSeed({ filename, csvText }: { filename: string; csvText: string }) {
  const setUpload = useOutreachImportStore((state) => state.setUpload);
  const reset = useOutreachImportStore((state) => state.reset);
  useEffect(() => {
    if (filename || csvText) {
      setUpload(filename, csvText);
    } else {
      reset();
    }
    return () => reset();
  }, [filename, csvText, setUpload, reset]);
  return null;
}

export const Empty: Story = {
  render: () => (
    <>
      <StoreSeed filename="" csvText="" />
      <ContactImportWizard />
    </>
  ),
};

export const Prefilled: Story = {
  render: () => (
    <>
      <StoreSeed
        filename="contacts-2026-06.csv"
        csvText={"name,email,employer\nDana Reyes,dana@acme.example,Acme\nMorgan Blake,morgan@acme.example,Acme"}
      />
      <ContactImportWizard />
    </>
  ),
};
