import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { sampleInterviewCatalogResponse } from "../../../test/fixtures/interviews.js";
import { InterviewLibraryGraph } from "./InterviewLibraryGraph.js";

const catalog = sampleInterviewCatalogResponse.catalog;
function props() { return { catalog, questions: catalog.questions, selectedQuestionId: "C01", topicId: "", sourceId: "", onSelectQuestion: vi.fn(), onSelectTopic: vi.fn(), onSelectSource: vi.fn(), onOverview: vi.fn() }; }

describe("whole interview atlas", () => {
  it("represents every canonical question once and keeps overview while selecting a question", async () => {
    const p = props(); const user = userEvent.setup(); const view = render(<InterviewLibraryGraph {...p} />);
    expect(view.container.querySelectorAll(".interview-atlas__cluster")).toHaveLength(15);
    expect(Array.from(view.container.querySelectorAll("[data-graph-question-id]")).map((node) => node.getAttribute("data-graph-question-id")).sort()).toEqual(catalog.questions.map((question) => question.id).sort());
    await user.click(screen.getByRole("button", { name: `B11: ${catalog.questions.find((question) => question.id === "B11")!.title}` }));
    expect(p.onSelectQuestion).toHaveBeenCalledWith("B11");
    expect(view.container.querySelectorAll("[data-graph-question-id]")).toHaveLength(121);
    expect(view.container.querySelector('path[data-edge-kind="editorial"]')).toBeInTheDocument();
    const result = await axe(view.container);
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });
  it("drills into a topic with readable labels and returns through Overview", async () => {
    const p = props(); const user = userEvent.setup(); const view = render(<InterviewLibraryGraph {...p} />); const topic = catalog.topics[0]!;
    await user.click(screen.getByRole("button", { name: `${topic.name}: ${topic.questionIds.length} questions` }));
    expect(p.onSelectTopic).toHaveBeenCalledWith(topic.id);
    view.rerender(<InterviewLibraryGraph {...p} topicId={topic.id} questions={catalog.questions.filter((question) => question.topic === topic.id)} />);
    expect(view.container.querySelectorAll(".interview-atlas__named-node")).toHaveLength(topic.questionIds.length);
    await user.click(within(screen.getByRole("region", { name: "Whole interview library graph" })).getByRole("button", { name: "Overview" }));
    expect(p.onOverview).toHaveBeenCalled();
  });
  it("shows all57 canonical sources by author with attribution edges and source selection", async () => {
    const p = props(); const user = userEvent.setup(); const view = render(<InterviewLibraryGraph {...p} />);
    await user.click(screen.getByRole("button", { name: "Sources" }));
    expect(view.container.querySelectorAll("[data-graph-source-id]")).toHaveLength(57);
    expect(view.container.querySelector('[data-edge-kind="source"]')).toBeInTheDocument();
    const source = catalog.sources[0]!;
    await user.click(screen.getByRole("button", { name: `${source.id}: ${source.title}` }));
    expect(p.onSelectSource).toHaveBeenCalledWith(source.id);
  });
  it("offers zoom and keyboard pan with reset without changing selected questions", async () => {
    const p = props(); const user = userEvent.setup(); const view = render(<InterviewLibraryGraph {...p} />);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("120%")).toBeInTheDocument();
    const canvas = screen.getByRole("group", { name: "Interview graph canvas" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(view.container.querySelector(".interview-atlas__world")).toHaveStyle({ transform: "translate(-40px, 0px) scale(1.2)" });
    fireEvent.keyDown(canvas, { key: "Home" });
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(p.onSelectQuestion).not.toHaveBeenCalled();
  });
  it("retains unlinked reading-ledger sources without inventing question attribution", () => {
    const p = props(); const source = catalog.sources.find((item) => item.id === "TR02")!;
    const view = render(<InterviewLibraryGraph {...p} questions={[]} sourceId={source.id} />);
    expect(screen.getByRole("heading", { name: source.title })).toBeInTheDocument();
    expect(screen.getByText("No linked questions in the current filters.")).toBeInTheDocument();
    expect(view.container.querySelectorAll(".interview-atlas__named-node")).toHaveLength(0);
  });
});
