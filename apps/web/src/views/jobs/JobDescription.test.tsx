import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JobDescription } from "./JobDescription.js";

describe("JobDescription", () => {
  it("renders captured markdown without injecting raw html", () => {
    render(
      <JobDescription
        text={[
          "**Welcome to the good side of tech 👋**",
          "Build [patient-facing products](https://example.com) with a platform-as-product mindset.",
          "",
          "- Lead engineering teams",
          "- Improve `SDLC` automation",
          "",
          "<script>alert('xss')</script>",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "Welcome to the good side of tech 👋" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "patient-facing products" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("SDLC")).toBeInTheDocument();
    expect(screen.getByText("<script>alert('xss')</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
});
