import {
  STAGE_STATE_KINDS,
  serializeStageState,
  type SerializedStageState,
  type StageStateKind,
} from "@jobctrl/domain-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StageState } from "../../operations/types.js";
import { StageBadge } from "./StageBadge.js";

const TONE_PATTERN = /^(ok|warn|danger|muted|info)$/;

function serializedFor(kind: StageStateKind): SerializedStageState {
  return serializeStageState({ kind } as { kind: StageStateKind } as Parameters<
    typeof serializeStageState
  >[0]);
}

describe("stage-state parity (the second-most important test in the app)", () => {
  it("STAGE_STATE_KINDS lists exactly the variants the app supports", () => {
    expect(STAGE_STATE_KINDS).toHaveLength(11);
    expect(new Set(STAGE_STATE_KINDS).size).toBe(STAGE_STATE_KINDS.length);
  });

  it("every domain kind serializes to the contracts StageState alphabet `<StageBadge>` accepts", () => {
    for (const kind of STAGE_STATE_KINDS) {
      const serialized = serializedFor(kind);
      expect(serialized).toMatch(/^[a-z_]+$/);
    }
  });

  for (const kind of STAGE_STATE_KINDS) {
    it(`<StageBadge state> renders a non-default tone for kind=${kind}`, () => {
      const state = serializedFor(kind) as StageState;
      render(<StageBadge state={state} />);
      const badge = screen.getByText(state);
      expect(badge).toHaveAttribute("data-slot", "status-badge");
      expect(badge.getAttribute("data-status-tone")).toMatch(TONE_PATTERN);
    });
  }
});
