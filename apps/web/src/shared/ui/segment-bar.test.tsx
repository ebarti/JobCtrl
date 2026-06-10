import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SegmentBar } from "./segment-bar.js";
import { SEGMENT_BAR_TONES } from "./status-tokens.js";

describe("<SegmentBar>", () => {
  it("renders only the closed segment tone classes", () => {
    const { container } = render(
      <SegmentBar
        total={SEGMENT_BAR_TONES.length}
        values={SEGMENT_BAR_TONES.map((tone) => [tone, 1] as const)}
      />,
    );

    for (const tone of SEGMENT_BAR_TONES) {
      expect(container.querySelector(`.seg-${tone}`)).toBeTruthy();
    }
  });
});

