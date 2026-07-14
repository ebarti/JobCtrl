import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

const meta = {
  title: "Contexts/Profile/StructuredProfileEditor",
  component: StructuredProfileEditor,
  args: {
    profileText: JSON.stringify(sampleProfileResponse.profile, null, 2),
    styleText: JSON.stringify(sampleProfileResponse.style, null, 2),
    onProfileTextChange: () => {},
    onStyleTextChange: () => {},
  },
} satisfies Meta<typeof StructuredProfileEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const completeProfileSeed = (() => {
  const profile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
  profile.personal = {
    ...profile.personal,
    preferred_name: "Jordan",
    phone: "+34 600 000 000",
    address: "Example address",
    city: "Barcelona",
    country: "Spain",
    postal_code: "08001",
    linkedin_url: "https://www.linkedin.com/in/jordan-candidate",
  };
  profile.experience = {
    years_of_experience_total: "12",
    education_level: "Bachelor's degree",
    current_job_title: "Director of Platform",
    current_company: "Initech",
  };
  profile.resume = {
    ...profile.resume,
    education_entries: [
      {
        id: "education-1",
        date: "2014-06",
        degree: "BSc Computer Science",
        institution: "Example University",
        location: "Barcelona",
      },
    ],
    skill_categories: [
      {
        id: "skills-1",
        label: "Platform engineering",
        items: ["TypeScript", "Kubernetes", "Observability"],
      },
    ],
    tailoring_rules: {
      ...profile.resume.tailoring_rules,
      required_experience_entry_ids: ["exp-1"],
      required_education_entry_ids: ["education-1"],
      required_skill_category_ids: ["skills-1"],
      required_bullets_by_experience_id: { "exp-1": ["Scaled the platform 10x."] },
      required_skills_by_category_id: { "skills-1": ["Kubernetes"] },
    },
  };
  profile.resume_constraints = { real_metrics: ["10x platform scale"] };
  profile.eeo_voluntary = {
    gender: "Prefer not to say",
    race_ethnicity: "Prefer not to say",
    veteran_status: "Prefer not to say",
    disability_status: "Prefer not to say",
  };
  return JSON.stringify(profile, null, 2);
})();

function Stateful({
  profileSeed,
  styleSeed,
  mode,
}: {
  profileSeed: string;
  styleSeed: string;
  mode?: "profile" | "preferences" | "target-search";
}) {
  const [profileText, setProfileText] = useState(profileSeed);
  const [styleText, setStyleText] = useState(styleSeed);
  const modeProps = mode ? { mode } : {};
  return (
    <StructuredProfileEditor
      {...modeProps}
      profileText={profileText}
      styleText={styleText}
      onProfileTextChange={setProfileText}
      onStyleTextChange={setStyleText}
    />
  );
}

export const Populated: Story = {
  render: () => (
    <Stateful
      profileSeed={JSON.stringify(sampleProfileResponse.profile, null, 2)}
      styleSeed={JSON.stringify(sampleProfileResponse.style, null, 2)}
    />
  ),
};

export const CompleteProfile: Story = {
  render: () => (
    <Stateful
      profileSeed={completeProfileSeed}
      styleSeed={JSON.stringify(sampleProfileResponse.style, null, 2)}
    />
  ),
};

export const Preferences: Story = {
  render: () => (
    <Stateful
      mode="preferences"
      profileSeed={JSON.stringify(
        {
          personal: { password: "" },
          work_authorization: {
            legally_authorized_to_work: "Yes",
            require_sponsorship: "No",
            work_permit_type: "EU citizen",
          },
          availability: {
            earliest_start_date: "2026-08-01",
            available_for_full_time: "Yes",
            available_for_contract: "No",
          },
          compensation: {
            salary_expectation: "150000",
            salary_currency: "EUR",
            salary_range_min: "140000",
            salary_range_max: "165000",
            currency_conversion_note: "Use the application currency when possible.",
          },
          resume: {
            tailoring_rules: {
              tailoring_policy: {
                claim_mode: "adjacent_translation",
                allow_minor_inference: true,
                allow_adjacent_achievement_drafts: false,
                auto_approvable_claim_modes: ["verified_only", "evidence_reframing"],
                allow_summary_rewrite: true,
                allow_achievement_rewriting: true,
                allow_skill_reordering: true,
              },
              writing_style: {
                tone: "executive",
                verbosity: "balanced",
                keyword_density: "natural",
                avoid_first_person: true,
              },
              revision_gates: {
                min_fit_score: 8,
                must_have_coverage: 0.85,
                max_revision_attempts: 1,
              },
              custom_tailoring_prompt: "Keep evidence gaps explicit.",
            },
          },
        },
        null,
        2,
      )}
      styleSeed={JSON.stringify(
        {
          document_font_size: "11pt",
          font_family: "sans",
          body_alignment: "left",
          moderncv_style: "banking",
          moderncv_color: "blue",
          paper_size: "a4paper",
          page_scale: 0.9,
          hints_column_width_cm: 3.1,
        },
        null,
        2,
      )}
    />
  ),
};

export const InvalidJson: Story = {
  render: () => (
    <Stateful profileSeed='{"this is": "not valid json' styleSeed="{}" />
  ),
};
