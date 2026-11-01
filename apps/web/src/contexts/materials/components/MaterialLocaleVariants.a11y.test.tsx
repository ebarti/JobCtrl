import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { MaterialLocalePanel } from "./MaterialLocaleVariants.js";
import { sampleLocaleHistory } from "./MaterialLocaleVariants.stories.js";

describe("locale variant accessibility", () => {
  it.each([false, true])("has labeled review/export controls accepted=%s", async accepted => {
    const view = render(<MaterialLocalePanel history={sampleLocaleHistory(accepted)} pending={false} onRequest={vi.fn()} onExport={vi.fn()} />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
