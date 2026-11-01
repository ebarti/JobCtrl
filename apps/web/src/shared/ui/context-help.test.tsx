import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { ContextHelp } from "./context-help.js";

describe("ContextHelp", () => {
  it.each(["{Enter}", " "])(
    "opens from the keyboard with %s and restores focus after Escape",
    async (key) => {
      const user = userEvent.setup();
      render(<ContextHelp label="Model agreement" description="Exact requirement and keyword overlap, not factual confidence." />);
      const trigger = screen.getByRole("button", { name: "Help for Model agreement" });

      await user.tab();
      expect(trigger).toHaveFocus();
      await user.keyboard(key);
      const dialog = await screen.findByRole("dialog", { name: "Model agreement explanation" });
      expect(dialog).toHaveTextContent("not factual confidence");
      expect(await axe(document.body)).toHaveNoViolations();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    },
  );
});
