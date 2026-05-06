import type { Meta, StoryObj } from "@storybook/react-vite";

import { CredentialForm } from "./credential-form.js";

const meta = {
  title: "Contexts/Profile/Forms/CredentialForm",
  component: CredentialForm,
  args: {
    credentialKey: "OPENAI_API_KEY",
    label: "OpenAI API key",
    configured: false,
  },
} satisfies Meta<typeof CredentialForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Missing: Story = {};

export const Configured: Story = {
  args: { configured: true },
};

export const Gemini: Story = {
  args: { credentialKey: "GEMINI_API_KEY", label: "Gemini API key", configured: true },
};

export const Endpoint: Story = {
  args: { credentialKey: "LLM_URL", label: "LLM endpoint", configured: false },
};
