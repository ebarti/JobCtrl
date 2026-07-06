import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { useMemo } from "react";

import { outreachSearchSchema } from "../../routes/-outreach.search.js";
import { makeContactListResponse } from "../../test/fixtures/contacts.js";
import { OutreachView } from "./OutreachView.js";

const meta = {
  title: "Views/Outreach/OutreachView",
  component: OutreachView,
} satisfies Meta<typeof OutreachView>;

export default meta;
type Story = StoryObj<typeof meta>;

function OutreachViewHost() {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const outreach = createRoute({
      getParentRoute: () => root,
      path: "/outreach",
      validateSearch: (search) => outreachSearchSchema.parse(search),
      component: OutreachView,
    });
    const detail = createRoute({
      getParentRoute: () => outreach,
      path: "$contactId",
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([outreach.addChildren([detail])]),
      history: createMemoryHistory({ initialEntries: ["/outreach"] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <OutreachViewHost />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/contacts", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(makeContactListResponse());
        }),
      ],
    },
  },
  render: () => <OutreachViewHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("*/v1/contacts", () => HttpResponse.json(makeContactListResponse([])))],
    },
  },
  render: () => <OutreachViewHost />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/contacts", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <OutreachViewHost />,
};
