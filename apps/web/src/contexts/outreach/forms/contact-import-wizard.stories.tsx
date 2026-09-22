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

function StoreSeed({ filename, content }: { filename: string; content: string }) {
  const setUpload = useOutreachImportStore((state) => state.setUpload);
  const reset = useOutreachImportStore((state) => state.reset);
  useEffect(() => {
    if (filename || content) {
      setUpload("csv", filename, content);
    } else {
      reset();
    }
    return () => reset();
  }, [filename, content, setUpload, reset]);
  return null;
}

export const Empty: Story = {
  render: () => (
    <>
      <StoreSeed filename="" content="" />
      <ContactImportWizard />
    </>
  ),
};

export const Prefilled: Story = {
  render: () => (
    <>
      <StoreSeed
        filename="contacts-2026-06.csv"
        content={"name,email,employer\nDana Reyes,dana@acme.example,Acme\nMorgan Blake,morgan@acme.example,Acme"}
      />
      <ContactImportWizard />
    </>
  ),
};
