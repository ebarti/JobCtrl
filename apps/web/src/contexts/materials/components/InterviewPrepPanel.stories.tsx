import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo } from "react";

import { evidenceMapSearchSchema } from "../../../routes/-evidence-map.search.js";
import { sampleInterviewPrep } from "../../../test/fixtures/projections.js";
import { InterviewPrepPanel, type InterviewPrepPanelProps } from "./InterviewPrepPanel.js";

const meta = {
  title: "Contexts/Materials/InterviewPrepPanel",
  component: InterviewPrepPanel,
} satisfies Meta<typeof InterviewPrepPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function InterviewPrepPanelHost(props: InterviewPrepPanelProps) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const home = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <InterviewPrepPanel {...props} />,
    });
    const evidenceMap = createRoute({
      getParentRoute: () => root,
      path: "/evidence-map",
      validateSearch: (search) => evidenceMapSearchSchema.parse(search),
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([home, evidenceMap]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, [props]);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  args: { jobId: "job-1", prep: sampleInterviewPrep },
  render: (args) => <InterviewPrepPanelHost {...args} />,
};

export const Empty: Story = {
  args: { jobId: "job-1", prep: null },
  render: (args) => <InterviewPrepPanelHost {...args} />,
};
