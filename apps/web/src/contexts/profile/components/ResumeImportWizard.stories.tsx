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

import { ResumeImportWizard } from "./ResumeImportWizard.js";

const meta = {
  title: "Contexts/Profile/ResumeImportWizard",
  component: ResumeImportWizard,
} satisfies Meta<typeof ResumeImportWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

function WizardHost({ initialPath }: { initialPath: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const profileImport = createRoute({
      getParentRoute: () => root,
      path: "/profile/import",
      component: ResumeImportWizard,
    });
    const upload = createRoute({
      getParentRoute: () => profileImport,
      path: "upload",
      component: () => <p className="text-sm text-muted-foreground">Drop a resume PDF to start.</p>,
    });
    const preview = createRoute({
      getParentRoute: () => profileImport,
      path: "preview",
      component: () => <p className="text-sm text-muted-foreground">Review the parsed sections.</p>,
    });
    const confirm = createRoute({
      getParentRoute: () => profileImport,
      path: "confirm",
      component: () => <p className="text-sm text-muted-foreground">Confirm and apply.</p>,
    });
    return createRouter({
      routeTree: root.addChildren([
        profileImport.addChildren([upload, preview, confirm]),
      ]),
      history: createMemoryHistory({ initialEntries: [initialPath] }),
    });
  }, [initialPath]);
  return <RouterProvider router={router} />;
}

export const StepUpload: Story = {
  render: () => <WizardHost initialPath="/profile/import/upload" />,
};

export const StepPreview: Story = {
  render: () => <WizardHost initialPath="/profile/import/preview" />,
};

export const StepConfirm: Story = {
  render: () => <WizardHost initialPath="/profile/import/confirm" />,
};
