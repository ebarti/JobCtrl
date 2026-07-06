import type { Meta, StoryObj } from "@storybook/react-vite";

import { ContactForm } from "./contact-form.js";

const meta = {
  title: "Contexts/Outreach/Forms/ContactForm",
  component: ContactForm,
  args: { submitLabel: "add contact", pending: false, onSubmit: () => undefined },
} satisfies Meta<typeof ContactForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Prefilled: Story = {
  args: {
    initialValues: {
      role: "recruiter",
      employer: "Acme",
      attributes: [
        { kind: "name", value: "Dana Reyes" },
        { kind: "email", value: "dana.reyes@acme.example" },
      ],
    },
  },
};

export const Saving: Story = {
  args: { pending: true },
};

export const WithError: Story = {
  args: {
    errorMessage: "A contact must link to at least one of employer or jobId.",
  },
};
