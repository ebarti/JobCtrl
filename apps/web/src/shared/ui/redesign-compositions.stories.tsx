import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { AdaptiveFieldGrid, AdaptiveFieldSpan } from "./adaptive-field-grid.js";
import { Button } from "./button.js";
import { ChoiceControl } from "./choice-control.js";
import { DisclosureSection } from "./disclosure-section.js";
import { Input } from "./input.js";
import { PreviewWorkbench } from "./preview-workbench.js";
import { SegmentedField } from "./segmented-field.js";
import { SelectField } from "./select-field.js";
import { TabsContent, TabsTrigger } from "./tabs.js";
import { SectionTabs, SectionTabsList } from "./section-tabs.js";

const meta = {
  title: "Shared/Compositions/Redesign system",
  component: DisclosureSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DisclosureSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const sizeOptions = [
  { value: "small", label: "Small" },
  { value: "regular", label: "Regular" },
  { value: "large", label: "Large" },
] as const;

export const PreferencesSections: Story = {
  render: function PreferencesSectionsStory() {
    const [size, setSize] = useState("regular");
    const [tone, setTone] = useState("executive");
    return (
      <div className="grid gap-4">
        <DisclosureSection
          title="Tailoring controls"
          description="Evidence rules remain enforced"
          collapsedSummary="3 generation permissions · Executive voice · 85% coverage"
          helpHref="https://jobctrl.dev/architecture/tailoring#inputs-to-tailoring"
          helpLabel="Tailoring guide"
        >
          <SectionTabs defaultValue="content">
            <SectionTabsList>
              <TabsTrigger value="content">Content rules</TabsTrigger>
              <TabsTrigger value="voice">Voice & language</TabsTrigger>
              <TabsTrigger value="quality">Quality gates</TabsTrigger>
            </SectionTabsList>
            <TabsContent value="content">
              <AdaptiveFieldGrid columns={2} minColumnWidth={260}>
                <div>
                  <ChoiceControl label="Rewrite executive summary" defaultChecked />
                  <ChoiceControl label="Rewrite achievement bullets" defaultChecked />
                  <ChoiceControl
                    label="Change experience titles"
                    disabledReason="Titles stay grounded in profile evidence."
                    disabled
                  />
                </div>
                <div>
                  <ChoiceControl label="Impact" defaultChecked locked />
                  <ChoiceControl label="Technical depth" defaultChecked locked />
                  <ChoiceControl label="Leadership" defaultChecked locked />
                </div>
              </AdaptiveFieldGrid>
            </TabsContent>
            <TabsContent value="voice">
              <SelectField
                label="Writing tone"
                value={tone}
                onValueChange={setTone}
                options={[
                  { value: "direct", label: "Direct" },
                  { value: "executive", label: "Executive" },
                  { value: "technical", label: "Technical" },
                ]}
              />
            </TabsContent>
            <TabsContent value="quality">Quality gate controls</TabsContent>
          </SectionTabs>
        </DisclosureSection>
        <DisclosureSection title="Resume style" description="Profile-level defaults">
          <AdaptiveFieldGrid columns={4} minColumnWidth={164}>
            <SegmentedField
              label="Text size"
              value={size}
              onValueChange={setSize}
              options={sizeOptions}
            />
            <SelectField
              label="Template style"
              defaultValue="banking"
              options={[
                { value: "banking", label: "Banking" },
                { value: "classic", label: "Classic" },
                { value: "casual", label: "Casual" },
              ]}
            />
            <AdaptiveFieldSpan span="full">
              <label className="field">
                Additional guidance
                <Input defaultValue="Keep certification gaps explicit." />
              </label>
            </AdaptiveFieldSpan>
          </AdaptiveFieldGrid>
        </DisclosureSection>
      </div>
    );
  },
};

export const FullWidthPreview: Story = {
  render: () => (
    <PreviewWorkbench
      title="Resume template"
      description="Current template · Modern editorial"
      status="Default"
      primaryControls={
        <>
          <SelectField
            label="Template"
            defaultValue="modern"
            options={[{ value: "modern", label: "Modern editorial" }]}
          />
          <label className="field">
            Name
            <Input defaultValue="Modern editorial" />
          </label>
        </>
      }
      actions={
        <>
          <Button variant="outline" size="sm">Save version</Button>
          <Button size="sm">Save default</Button>
        </>
      }
      previewLabel="Resume template preview"
    >
      <div className="mx-auto my-6 min-h-[560px] max-w-[760px] bg-card p-12 shadow-sm">
        Production resume editor region
      </div>
    </PreviewWorkbench>
  ),
};
