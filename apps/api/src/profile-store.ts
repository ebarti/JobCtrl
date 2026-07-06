import type {
  ExtensionAutofillProfileField,
  ExtensionAutofillProfileResponse,
  ProfileConfigResponse,
  ProfileShape,
  ProfileUpdateRequest,
} from "./contracts.js";
import { ProfileSchema } from "./contracts.js";
import type { SqliteDatabase } from "./db.js";

const TENANT_ID = "local";
const PROFILE_ID = "default";

export class ProfileInputError extends Error {}

const CHILD_TABLES = [
  "candidate_profile_experience_bullets",
  "candidate_profile_achievement_evidence",
  "candidate_profile_experience_entries",
  "candidate_profile_education_entries",
  "candidate_profile_skill_items",
  "candidate_profile_skill_categories",
  "candidate_profile_required_experience_entries",
  "candidate_profile_required_education_entries",
  "candidate_profile_required_skill_categories",
  "candidate_profile_required_bullets",
  "candidate_profile_required_skills",
  "candidate_profile_resume_constraint_metrics",
] as const;

const STYLE_CHOICES = {
  document_font_size: new Set(["10pt", "11pt", "12pt"]),
  paper_size: new Set(["a4paper", "letterpaper"]),
  font_family: new Set(["sans", "roman"]),
  moderncv_style: new Set(["banking", "classic", "casual", "oldstyle", "fancy"]),
  moderncv_color: new Set(["black", "blue", "burgundy", "green", "grey", "orange", "purple", "red"]),
  body_alignment: new Set(["justified", "left"]),
};

const DEFAULT_STYLE = {
  document_font_size: "11pt",
  paper_size: "a4paper",
  font_family: "sans",
  moderncv_style: "banking",
  moderncv_color: "black",
  page_scale: 0.85,
  hints_column_width_cm: 3.0,
  body_alignment: "justified",
};

const DEFAULT_RESUME_TEMPLATE = String.raw`\documentclass[11pt,a4paper,sans]{moderncv}

\moderncvstyle{banking}
\moderncvcolor{black}

\usepackage[utf8]{inputenc}
\usepackage[english]{babel}
\usepackage[scale=0.85]{geometry}
\usepackage{enumitem}

\setlength{\hintscolumnwidth}{3cm}

{{ personal_data }}

\begin{document}

\makecvtitle
\vspace*{-1.5em}

{{ resume_body }}

\end{document}
`;

const SUPPORTED_PROFILE_TOP_LEVEL_KEYS = new Set([
  "personal",
  "work_authorization",
  "availability",
  "compensation",
  "experience",
  "eeo_voluntary",
  "resume",
  "resume_constraints",
  // Legacy file metadata, not Candidate Profile data.
  "schema_version",
  // Legacy snapshot-only fields are derived from normalized profile sections.
  "skills_boundary",
  "resume_facts",
]);

const ROOT_COLUMNS = [
  "tenant_id",
  "profile_id",
  "personal_full_name",
  "personal_preferred_name",
  "personal_email",
  "personal_phone",
  "personal_address",
  "personal_city",
  "personal_province_state",
  "personal_country",
  "personal_postal_code",
  "personal_linkedin_url",
  "personal_github_url",
  "personal_portfolio_url",
  "personal_website_url",
  "personal_password",
  "work_legally_authorized_to_work",
  "work_require_sponsorship",
  "work_work_permit_type",
  "compensation_salary_expectation",
  "compensation_salary_currency",
  "compensation_salary_range_min",
  "compensation_salary_range_max",
  "compensation_currency_note",
  "experience_years_total",
  "experience_education_level",
  "experience_current_job_title",
  "experience_current_company",
  "experience_target_role",
  "experience_target_track",
  "experience_target_seniority_floor",
  "experience_target_functions",
  "experience_target_specializations",
  "experience_target_locations",
  "experience_target_work_models",
  "availability_earliest_start_date",
  "availability_full_time",
  "availability_contract",
  "eeo_gender",
  "eeo_race_ethnicity",
  "eeo_veteran_status",
  "eeo_disability_status",
  "resume_baseline_text",
  "tailoring_mode",
  "tailoring_allow_title_reframing",
  "tailoring_allow_achievement_rewriting",
  "tailoring_allow_skill_reordering",
  "tailoring_allow_summary_rewrite",
  "tailoring_allow_minor_inference",
  "tailoring_claim_mode",
  "tailoring_auto_approvable_claim_modes_json",
  "tailoring_allow_adjacent_achievement_drafts",
  "writing_tone",
  "writing_bullet_style",
  "writing_verbosity",
  "writing_keyword_density",
  "writing_avoid_first_person",
  "max_experience_bullets",
  "custom_tailoring_prompt",
  "revision_min_fit_score",
  "revision_must_have_coverage",
  "revision_max_attempts",
  "resume_style_document_font_size",
  "resume_style_paper_size",
  "resume_style_font_family",
  "resume_style_moderncv_style",
  "resume_style_moderncv_color",
  "resume_style_page_scale",
  "resume_style_hints_column_width_cm",
  "resume_style_body_alignment",
  "resume_template_text",
  "version",
  "updated_at",
] as const;

type RootColumn = (typeof ROOT_COLUMNS)[number];
type ProfileRow = Record<RootColumn, string | number | null>;

export function ensureProfileTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_profiles (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      profile_id TEXT NOT NULL DEFAULT 'default',
      personal_full_name TEXT NOT NULL DEFAULT '',
      personal_preferred_name TEXT NOT NULL DEFAULT '',
      personal_email TEXT NOT NULL DEFAULT '',
      personal_phone TEXT NOT NULL DEFAULT '',
      personal_address TEXT NOT NULL DEFAULT '',
      personal_city TEXT NOT NULL DEFAULT '',
      personal_province_state TEXT NOT NULL DEFAULT '',
      personal_country TEXT NOT NULL DEFAULT '',
      personal_postal_code TEXT NOT NULL DEFAULT '',
      personal_linkedin_url TEXT NOT NULL DEFAULT '',
      personal_github_url TEXT NOT NULL DEFAULT '',
      personal_portfolio_url TEXT NOT NULL DEFAULT '',
      personal_website_url TEXT NOT NULL DEFAULT '',
      personal_password TEXT NOT NULL DEFAULT '',
      work_legally_authorized_to_work TEXT NOT NULL DEFAULT '',
      work_require_sponsorship TEXT NOT NULL DEFAULT '',
      work_work_permit_type TEXT NOT NULL DEFAULT '',
      compensation_salary_expectation TEXT NOT NULL DEFAULT '',
      compensation_salary_currency TEXT NOT NULL DEFAULT 'USD',
      compensation_salary_range_min TEXT NOT NULL DEFAULT '',
      compensation_salary_range_max TEXT NOT NULL DEFAULT '',
      compensation_currency_note TEXT NOT NULL DEFAULT '',
      experience_years_total TEXT NOT NULL DEFAULT '',
      experience_education_level TEXT NOT NULL DEFAULT '',
      experience_current_job_title TEXT NOT NULL DEFAULT '',
      experience_current_company TEXT NOT NULL DEFAULT '',
      experience_target_role TEXT NOT NULL DEFAULT '',
      experience_target_track TEXT NOT NULL DEFAULT '',
      experience_target_seniority_floor TEXT NOT NULL DEFAULT '',
      experience_target_functions TEXT NOT NULL DEFAULT '',
      experience_target_specializations TEXT NOT NULL DEFAULT '',
      experience_target_locations TEXT NOT NULL DEFAULT '',
      experience_target_work_models TEXT NOT NULL DEFAULT '',
      availability_earliest_start_date TEXT NOT NULL DEFAULT '',
      availability_full_time TEXT NOT NULL DEFAULT '',
      availability_contract TEXT NOT NULL DEFAULT '',
      eeo_gender TEXT NOT NULL DEFAULT 'Decline to self-identify',
      eeo_race_ethnicity TEXT NOT NULL DEFAULT 'Decline to self-identify',
      eeo_veteran_status TEXT NOT NULL DEFAULT 'Decline to self-identify',
      eeo_disability_status TEXT NOT NULL DEFAULT 'Decline to self-identify',
      resume_baseline_text TEXT NOT NULL DEFAULT '',
      tailoring_mode TEXT NOT NULL DEFAULT 'balanced',
      tailoring_allow_title_reframing INTEGER NOT NULL DEFAULT 0,
      tailoring_allow_achievement_rewriting INTEGER NOT NULL DEFAULT 1,
      tailoring_allow_skill_reordering INTEGER NOT NULL DEFAULT 1,
      tailoring_allow_summary_rewrite INTEGER NOT NULL DEFAULT 1,
      tailoring_allow_minor_inference INTEGER NOT NULL DEFAULT 0,
      tailoring_claim_mode TEXT NOT NULL DEFAULT 'evidence_reframing',
      tailoring_auto_approvable_claim_modes_json TEXT NOT NULL DEFAULT '["verified_only","evidence_reframing"]',
      tailoring_allow_adjacent_achievement_drafts INTEGER NOT NULL DEFAULT 0,
      writing_tone TEXT NOT NULL DEFAULT 'direct',
      writing_bullet_style TEXT NOT NULL DEFAULT 'balanced',
      writing_verbosity TEXT NOT NULL DEFAULT 'balanced',
      writing_keyword_density TEXT NOT NULL DEFAULT 'natural',
      writing_avoid_first_person INTEGER NOT NULL DEFAULT 1,
      max_experience_bullets INTEGER NOT NULL DEFAULT 4,
      custom_tailoring_prompt TEXT NOT NULL DEFAULT '',
      revision_min_fit_score INTEGER NOT NULL DEFAULT 8,
      revision_must_have_coverage REAL NOT NULL DEFAULT 0.85,
      revision_max_attempts INTEGER NOT NULL DEFAULT 1,
      resume_style_document_font_size TEXT NOT NULL DEFAULT '11pt',
      resume_style_paper_size TEXT NOT NULL DEFAULT 'a4paper',
      resume_style_font_family TEXT NOT NULL DEFAULT 'sans',
      resume_style_moderncv_style TEXT NOT NULL DEFAULT 'banking',
      resume_style_moderncv_color TEXT NOT NULL DEFAULT 'black',
      resume_style_page_scale REAL NOT NULL DEFAULT 0.85,
      resume_style_hints_column_width_cm REAL NOT NULL DEFAULT 3.0,
      resume_style_body_alignment TEXT NOT NULL DEFAULT 'justified',
      resume_template_text TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_experience_entries (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      date_range TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, profile_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_experience_bullets (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      bullet_index INTEGER NOT NULL,
      bullet_text TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_achievement_evidence (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      evidence_index INTEGER NOT NULL,
      evidence_id TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL DEFAULT '[]',
      metrics_json TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL DEFAULT '',
      seniority_signal TEXT NOT NULL DEFAULT '',
      evidence_strength TEXT NOT NULL DEFAULT 'supported',
      claim_confidence REAL NOT NULL DEFAULT 0,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (tenant_id, profile_id, entry_id, evidence_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_education_entries (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      date TEXT NOT NULL DEFAULT '',
      degree TEXT NOT NULL DEFAULT '',
      institution TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, profile_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_skill_categories (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, profile_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_skill_items (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      item_text TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, category_id, item_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_required_experience_entries (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, position_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_required_education_entries (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, position_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_required_skill_categories (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      position_index INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, position_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_required_bullets (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      bullet_index INTEGER NOT NULL,
      bullet_text TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_required_skills (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      skill_index INTEGER NOT NULL,
      skill_text TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, category_id, skill_index)
    );
    CREATE TABLE IF NOT EXISTS candidate_profile_resume_constraint_metrics (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      metric_index INTEGER NOT NULL,
      metric_text TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id, metric_index)
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_profile_experience_order
      ON candidate_profile_experience_entries(tenant_id, profile_id, position_index);
    CREATE INDEX IF NOT EXISTS idx_candidate_profile_education_order
      ON candidate_profile_education_entries(tenant_id, profile_id, position_index);
    CREATE INDEX IF NOT EXISTS idx_candidate_profile_skill_order
      ON candidate_profile_skill_categories(tenant_id, profile_id, position_index);
  `);
  ensureCandidateProfileColumns(db);
}

const CANDIDATE_PROFILE_COLUMN_MIGRATIONS: Record<string, string> = {
  experience_target_track: "TEXT NOT NULL DEFAULT ''",
  experience_target_seniority_floor: "TEXT NOT NULL DEFAULT ''",
  experience_target_functions: "TEXT NOT NULL DEFAULT ''",
  experience_target_specializations: "TEXT NOT NULL DEFAULT ''",
  experience_target_locations: "TEXT NOT NULL DEFAULT ''",
  experience_target_work_models: "TEXT NOT NULL DEFAULT ''",
  tailoring_claim_mode: "TEXT NOT NULL DEFAULT 'evidence_reframing'",
  tailoring_auto_approvable_claim_modes_json: "TEXT NOT NULL DEFAULT '[\"verified_only\",\"evidence_reframing\"]'",
  tailoring_allow_adjacent_achievement_drafts: "INTEGER NOT NULL DEFAULT 0",
  revision_min_fit_score: "INTEGER NOT NULL DEFAULT 8",
  revision_must_have_coverage: "REAL NOT NULL DEFAULT 0.85",
  revision_max_attempts: "INTEGER NOT NULL DEFAULT 1",
};

function ensureCandidateProfileColumns(db: SqliteDatabase): void {
  const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(candidate_profiles)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );

  for (const [column, definition] of Object.entries(CANDIDATE_PROFILE_COLUMN_MIGRATIONS)) {
    if (!existingColumns.has(column)) {
      db.exec(`ALTER TABLE candidate_profiles ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function readProfileConfig(db: SqliteDatabase): ProfileConfigResponse {
  ensureProfileTables(db);
  const row = getProfileRow(db);
  if (!row) {
    return { ok: true, profile: {}, style: DEFAULT_STYLE, templateText: DEFAULT_RESUME_TEMPLATE };
  }
  return {
    ok: true,
    profile: rowToProfile(db, row),
    style: styleFromRow(row),
    templateText: String(row.resume_template_text || DEFAULT_RESUME_TEMPLATE),
  };
}

export function readExtensionAutofillProfile(db: SqliteDatabase): ExtensionAutofillProfileResponse {
  ensureProfileTables(db);
  const row = getProfileRow(db);
  if (!row) {
    return { ok: true, profileVersion: null, fields: [] };
  }
  const profile = rowToProfile(db, row);
  return {
    ok: true,
    profileVersion: Number(row.version ?? 1),
    fields: extensionAutofillFields(profile),
  };
}

export function writeProfileConfig(
  db: SqliteDatabase,
  request: ProfileUpdateRequest,
): ProfileConfigResponse {
  ensureProfileTables(db);

  let wrote = false;
  let profile: ProfileShape | undefined;
  let stylePatch: Record<string, unknown> | undefined;
  let templateText: string | undefined;

  if (request.profile !== undefined || request.profileText !== undefined) {
    profile = parseProfileInput(request.profile, request.profileText);
    wrote = true;
  }
  if (request.style !== undefined || request.styleText !== undefined) {
    stylePatch = parseJsonObjectInput(request.style, request.styleText, "resume style settings");
    wrote = true;
  }
  if (request.templateText !== undefined) {
    if (!request.templateText.trim()) {
      throw new ProfileInputError("resume template cannot be empty.");
    }
    templateText = request.templateText;
    wrote = true;
  }
  if (!wrote) {
    throw new ProfileInputError("At least one profile, style, or template field is required.");
  }

  const existing = getProfileRow(db);
  if (!existing && !profile) {
    throw new ProfileInputError("profile must be initialized before updating style or template settings.");
  }
  const nextProfile = profile ?? rowToProfile(db, existing as ProfileRow);
  const existingStyle = existing ? styleFromRow(existing) : DEFAULT_STYLE;
  const nextStyle = stylePatch ? normalizeStyle({ ...existingStyle, ...stylePatch }) : existingStyle;
  const nextTemplate =
    templateText ??
    (existing ? String(existing.resume_template_text || DEFAULT_RESUME_TEMPLATE) : DEFAULT_RESUME_TEMPLATE);
  const nextVersion = existing ? Number(existing.version ?? 0) + 1 : 1;

  replaceProfile(db, nextProfile, nextStyle, nextTemplate, nextVersion);
  return readProfileConfig(db);
}

export function parseProfileUpdateProfile(request: ProfileUpdateRequest): ProfileShape | undefined {
  if (request.profile === undefined && request.profileText === undefined) {
    return undefined;
  }
  return parseProfileInput(request.profile, request.profileText);
}

function replaceProfile(
  db: SqliteDatabase,
  profile: ProfileShape,
  style: Record<string, string | number>,
  templateText: string,
  version: number,
): void {
  const transaction = db.transaction(() => {
    for (const table of CHILD_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND profile_id = ?`).run(TENANT_ID, PROFILE_ID);
    }

    const assignments = ROOT_COLUMNS
      .filter((column) => column !== "tenant_id" && column !== "profile_id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    db.prepare(`
      INSERT INTO candidate_profiles (${ROOT_COLUMNS.join(", ")})
      VALUES (${ROOT_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT(tenant_id, profile_id) DO UPDATE SET ${assignments}
    `).run(...rootValues(profile, style, templateText, version));

    insertChildren(db, profile);
  });
  transaction();
}

function insertChildren(db: SqliteDatabase, profile: ProfileShape): void {
  const experienceEntries = asRecordArray(record(profile.resume).experience_entries);
  const insertExperience = db.prepare(`
    INSERT INTO candidate_profile_experience_entries (
      tenant_id, profile_id, entry_id, position_index, date_range, title, company, location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBullet = db.prepare(`
    INSERT INTO candidate_profile_experience_bullets (
      tenant_id, profile_id, entry_id, bullet_index, bullet_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertEvidence = db.prepare(`
    INSERT INTO candidate_profile_achievement_evidence (
      tenant_id, profile_id, entry_id, evidence_index,
      evidence_id, source_text, scope, action, tools_json,
      metrics_json, outcome, seniority_signal, evidence_strength,
      claim_confidence, user_confirmed, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  experienceEntries.forEach((entry, index) => {
    const entryId = text(entry.id);
    insertExperience.run(
      TENANT_ID,
      PROFILE_ID,
      entryId,
      index,
      text(entry.date_range),
      text(entry.title),
      text(entry.company),
      text(entry.location),
    );
    asTextArray(entry.bullets).forEach((bullet, bulletIndex) => {
      insertBullet.run(TENANT_ID, PROFILE_ID, entryId, bulletIndex, bullet);
    });
    asRecordArray(entry.achievement_evidence).forEach((evidence, evidenceIndex) => {
      insertEvidence.run(
        TENANT_ID,
        PROFILE_ID,
        entryId,
        evidenceIndex,
        text(evidence.id),
        text(evidence.source_text),
        text(evidence.scope),
        text(evidence.action),
        jsonTextArray(evidence.tools),
        jsonTextArray(evidence.metrics),
        text(evidence.outcome),
        text(evidence.seniority_signal),
        text(evidence.evidence_strength, "supported"),
        confidenceNumber(evidence.claim_confidence),
        boolInt(evidence.user_confirmed, false),
        jsonTextArray(evidence.tags),
      );
    });
  });

  const insertEducation = db.prepare(`
    INSERT INTO candidate_profile_education_entries (
      tenant_id, profile_id, entry_id, position_index, date, degree, institution, location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  asRecordArray(record(profile.resume).education_entries).forEach((entry, index) => {
    insertEducation.run(
      TENANT_ID,
      PROFILE_ID,
      text(entry.id),
      index,
      text(entry.date),
      text(entry.degree),
      text(entry.institution),
      text(entry.location),
    );
  });

  const insertCategory = db.prepare(`
    INSERT INTO candidate_profile_skill_categories (
      tenant_id, profile_id, category_id, position_index, label
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertSkillItem = db.prepare(`
    INSERT INTO candidate_profile_skill_items (
      tenant_id, profile_id, category_id, item_index, item_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  asRecordArray(record(profile.resume).skill_categories).forEach((category, index) => {
    const categoryId = text(category.id);
    insertCategory.run(TENANT_ID, PROFILE_ID, categoryId, index, text(category.label));
    asTextArray(category.items).forEach((item, itemIndex) => {
      insertSkillItem.run(TENANT_ID, PROFILE_ID, categoryId, itemIndex, item);
    });
  });

  const rules = record(record(profile.resume).tailoring_rules);
  insertRequiredIds(db, "candidate_profile_required_experience_entries", "entry_id", asTextArray(rules.required_experience_entry_ids));
  insertRequiredIds(db, "candidate_profile_required_education_entries", "entry_id", asTextArray(rules.required_education_entry_ids));
  insertRequiredIds(db, "candidate_profile_required_skill_categories", "category_id", asTextArray(rules.required_skill_category_ids));

  const insertRequiredBullet = db.prepare(`
    INSERT INTO candidate_profile_required_bullets (
      tenant_id, profile_id, entry_id, bullet_index, bullet_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [entryId, bullets] of Object.entries(record(rules.required_bullets_by_experience_id))) {
    asTextArray(bullets).forEach((bullet, index) => insertRequiredBullet.run(TENANT_ID, PROFILE_ID, entryId, index, bullet));
  }

  const insertRequiredSkill = db.prepare(`
    INSERT INTO candidate_profile_required_skills (
      tenant_id, profile_id, category_id, skill_index, skill_text
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [categoryId, skills] of Object.entries(record(rules.required_skills_by_category_id))) {
    asTextArray(skills).forEach((skill, index) => insertRequiredSkill.run(TENANT_ID, PROFILE_ID, categoryId, index, skill));
  }

  const insertMetric = db.prepare(`
    INSERT INTO candidate_profile_resume_constraint_metrics (
      tenant_id, profile_id, metric_index, metric_text
    ) VALUES (?, ?, ?, ?)
  `);
  asTextArray(record(profile.resume_constraints).real_metrics).forEach((metric, index) => {
    insertMetric.run(TENANT_ID, PROFILE_ID, index, metric);
  });
}

function insertRequiredIds(db: SqliteDatabase, table: string, column: string, values: string[]): void {
  const statement = db.prepare(`
    INSERT INTO ${table} (tenant_id, profile_id, position_index, ${column})
    VALUES (?, ?, ?, ?)
  `);
  values.forEach((value, index) => statement.run(TENANT_ID, PROFILE_ID, index, value));
}

function rowToProfile(db: SqliteDatabase, row: ProfileRow): ProfileShape {
  const profile = {
    personal: {
      full_name: stringColumn(row.personal_full_name),
      preferred_name: stringColumn(row.personal_preferred_name),
      email: stringColumn(row.personal_email),
      phone: stringColumn(row.personal_phone),
      address: stringColumn(row.personal_address),
      city: stringColumn(row.personal_city),
      province_state: stringColumn(row.personal_province_state),
      country: stringColumn(row.personal_country),
      postal_code: stringColumn(row.personal_postal_code),
      linkedin_url: stringColumn(row.personal_linkedin_url),
      github_url: stringColumn(row.personal_github_url),
      portfolio_url: stringColumn(row.personal_portfolio_url),
      website_url: stringColumn(row.personal_website_url),
      password: stringColumn(row.personal_password),
    },
    work_authorization: {
      legally_authorized_to_work: stringColumn(row.work_legally_authorized_to_work),
      require_sponsorship: stringColumn(row.work_require_sponsorship),
      work_permit_type: stringColumn(row.work_work_permit_type),
    },
    availability: {
      earliest_start_date: stringColumn(row.availability_earliest_start_date),
      available_for_full_time: stringColumn(row.availability_full_time),
      available_for_contract: stringColumn(row.availability_contract),
    },
    compensation: {
      salary_expectation: stringColumn(row.compensation_salary_expectation),
      salary_currency: stringColumn(row.compensation_salary_currency, "USD"),
      salary_range_min: stringColumn(row.compensation_salary_range_min),
      salary_range_max: stringColumn(row.compensation_salary_range_max),
      currency_conversion_note: stringColumn(row.compensation_currency_note),
    },
    experience: {
      years_of_experience_total: stringColumn(row.experience_years_total),
      education_level: stringColumn(row.experience_education_level),
      current_job_title: stringColumn(row.experience_current_job_title),
      current_company: stringColumn(row.experience_current_company),
      target_role: stringColumn(row.experience_target_role),
      target_track: stringColumn(row.experience_target_track),
      target_seniority_floor: stringColumn(row.experience_target_seniority_floor),
      target_functions: stringColumn(row.experience_target_functions),
      target_specializations: stringColumn(row.experience_target_specializations),
      target_locations: stringColumn(row.experience_target_locations),
      target_work_models: stringColumn(row.experience_target_work_models),
    },
    eeo_voluntary: {
      gender: stringColumn(row.eeo_gender, "Decline to self-identify"),
      race_ethnicity: stringColumn(row.eeo_race_ethnicity, "Decline to self-identify"),
      veteran_status: stringColumn(row.eeo_veteran_status, "Decline to self-identify"),
      disability_status: stringColumn(row.eeo_disability_status, "Decline to self-identify"),
    },
    resume: {
      executive_profile: { baseline_text: stringColumn(row.resume_baseline_text) },
      experience_entries: experienceRows(db),
      education_entries: educationRows(db),
      skill_categories: skillRows(db),
      tailoring_rules: tailoringRules(db, row),
    },
    resume_constraints: {
      real_metrics: orderedValues(db, "candidate_profile_resume_constraint_metrics", "metric_text", "metric_index"),
    },
  };
  return ProfileSchema.parse(profile);
}

function extensionAutofillFields(profile: ProfileShape): ExtensionAutofillProfileField[] {
  const fields: ExtensionAutofillProfileField[] = [];
  addProfileField(fields, profile, "personal.full_name", "Profile > Personal information > Full name");
  addProfileField(fields, profile, "personal.preferred_name", "Profile > Personal information > Preferred name");
  addProfileField(fields, profile, "personal.email", "Profile > Personal information > Email");
  addProfileField(fields, profile, "personal.phone", "Profile > Personal information > Phone");
  addProfileField(fields, profile, "personal.address", "Profile > Personal information > Address");
  addProfileField(fields, profile, "personal.city", "Profile > Personal information > City");
  addProfileField(fields, profile, "personal.province_state", "Profile > Personal information > State / province");
  addProfileField(fields, profile, "personal.country", "Profile > Personal information > Country");
  addProfileField(fields, profile, "personal.postal_code", "Profile > Personal information > Postal code");
  addProfileField(fields, profile, "personal.linkedin_url", "Profile > Personal information > LinkedIn URL");
  addProfileField(fields, profile, "personal.github_url", "Profile > Personal information > GitHub URL");
  addProfileField(fields, profile, "personal.portfolio_url", "Profile > Personal information > Portfolio URL");
  addProfileField(fields, profile, "personal.website_url", "Profile > Personal information > Website URL");
  addProfileField(
    fields,
    profile,
    "work_authorization.legally_authorized_to_work",
    "Profile > Work authorization > Legally authorized to work",
  );
  addProfileField(
    fields,
    profile,
    "work_authorization.require_sponsorship",
    "Profile > Work authorization > Requires sponsorship",
  );
  addProfileField(fields, profile, "work_authorization.work_permit_type", "Profile > Work authorization > Work permit type");
  addProfileField(fields, profile, "compensation.salary_expectation", "Profile > Compensation > Salary expectation");
  addProfileField(fields, profile, "compensation.salary_currency", "Profile > Compensation > Currency");
  addProfileField(fields, profile, "compensation.salary_range_min", "Profile > Compensation > Salary range minimum");
  addProfileField(fields, profile, "compensation.salary_range_max", "Profile > Compensation > Salary range maximum");
  addProfileField(fields, profile, "availability.earliest_start_date", "Profile > Availability > Earliest start date");
  addProfileField(fields, profile, "availability.available_for_full_time", "Profile > Availability > Full time");
  addProfileField(fields, profile, "availability.available_for_contract", "Profile > Availability > Contract");
  addProfileField(fields, profile, "eeo_voluntary.gender", "Profile > Voluntary EEO > Gender");
  addProfileField(fields, profile, "eeo_voluntary.race_ethnicity", "Profile > Voluntary EEO > Race / ethnicity");
  addProfileField(fields, profile, "eeo_voluntary.veteran_status", "Profile > Voluntary EEO > Veteran status");
  addProfileField(fields, profile, "eeo_voluntary.disability_status", "Profile > Voluntary EEO > Disability status");
  return fields;
}

function addProfileField(
  fields: ExtensionAutofillProfileField[],
  profile: ProfileShape,
  path: string,
  label: string,
): void {
  const value = textAtPath(profile, path);
  if (!value) {
    return;
  }
  fields.push({
    path,
    label,
    value,
    source: { kind: "profile", path, label },
  });
}

function textAtPath(value: unknown, path: string): string {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return "";
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current.trim() : "";
}

function experienceRows(db: SqliteDatabase): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT entry_id, date_range, title, company, location
    FROM candidate_profile_experience_entries
    WHERE tenant_id = ? AND profile_id = ?
    ORDER BY position_index, entry_id
  `).all(TENANT_ID, PROFILE_ID) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: text(row.entry_id),
    date_range: text(row.date_range),
    title: text(row.title),
    company: text(row.company),
    location: text(row.location),
    bullets: orderedValues(db, "candidate_profile_experience_bullets", "bullet_text", "bullet_index", "entry_id = ?", [text(row.entry_id)]),
    achievement_evidence: achievementEvidenceRows(db, text(row.entry_id)),
  }));
}

function achievementEvidenceRows(db: SqliteDatabase, entryId: string): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT evidence_id, source_text, scope, action, tools_json, metrics_json,
           outcome, seniority_signal, evidence_strength, claim_confidence,
           user_confirmed, tags_json
    FROM candidate_profile_achievement_evidence
    WHERE tenant_id = ? AND profile_id = ? AND entry_id = ?
    ORDER BY evidence_index
  `).all(TENANT_ID, PROFILE_ID, entryId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: text(row.evidence_id),
    source_text: text(row.source_text),
    scope: text(row.scope),
    action: text(row.action),
    tools: parseTextArray(row.tools_json),
    metrics: parseTextArray(row.metrics_json),
    outcome: text(row.outcome),
    seniority_signal: text(row.seniority_signal),
    evidence_strength: text(row.evidence_strength, "supported"),
    claim_confidence: confidenceNumber(row.claim_confidence),
    user_confirmed: Boolean(Number(row.user_confirmed ?? 0)),
    tags: parseTextArray(row.tags_json),
  }));
}

function educationRows(db: SqliteDatabase): Array<Record<string, unknown>> {
  return (db.prepare(`
    SELECT entry_id, date, degree, institution, location
    FROM candidate_profile_education_entries
    WHERE tenant_id = ? AND profile_id = ?
    ORDER BY position_index, entry_id
  `).all(TENANT_ID, PROFILE_ID) as Array<Record<string, unknown>>).map((row) => ({
    id: text(row.entry_id),
    date: text(row.date),
    degree: text(row.degree),
    institution: text(row.institution),
    location: text(row.location),
  }));
}

function skillRows(db: SqliteDatabase): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT category_id, label
    FROM candidate_profile_skill_categories
    WHERE tenant_id = ? AND profile_id = ?
    ORDER BY position_index, category_id
  `).all(TENANT_ID, PROFILE_ID) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: text(row.category_id),
    label: text(row.label),
    items: orderedValues(db, "candidate_profile_skill_items", "item_text", "item_index", "category_id = ?", [text(row.category_id)]),
  }));
}

function tailoringRules(db: SqliteDatabase, row: ProfileRow): Record<string, unknown> {
  return {
    required_experience_entry_ids: orderedValues(db, "candidate_profile_required_experience_entries", "entry_id", "position_index"),
    required_education_entry_ids: orderedValues(db, "candidate_profile_required_education_entries", "entry_id", "position_index"),
    required_skill_category_ids: orderedValues(db, "candidate_profile_required_skill_categories", "category_id", "position_index"),
    required_bullets_by_experience_id: groupedValues(db, "candidate_profile_required_bullets", "entry_id", "bullet_text", "bullet_index"),
    required_skills_by_category_id: groupedValues(db, "candidate_profile_required_skills", "category_id", "skill_text", "skill_index"),
    max_experience_bullets: Number(row.max_experience_bullets ?? 4),
    custom_tailoring_prompt: stringColumn(row.custom_tailoring_prompt),
    tailoring_policy: {
      mode: stringColumn(row.tailoring_mode, "balanced"),
      allow_title_reframing: Boolean(Number(row.tailoring_allow_title_reframing ?? 0)),
      allow_achievement_rewriting: Boolean(Number(row.tailoring_allow_achievement_rewriting ?? 1)),
      allow_skill_reordering: Boolean(Number(row.tailoring_allow_skill_reordering ?? 1)),
      allow_summary_rewrite: Boolean(Number(row.tailoring_allow_summary_rewrite ?? 1)),
      allow_minor_inference: Boolean(Number(row.tailoring_allow_minor_inference ?? 0)),
      claim_mode: stringColumn(row.tailoring_claim_mode, "evidence_reframing"),
      auto_approvable_claim_modes: parseTextArray(row.tailoring_auto_approvable_claim_modes_json),
      allow_adjacent_achievement_drafts: Boolean(Number(row.tailoring_allow_adjacent_achievement_drafts ?? 0)),
    },
    writing_style: {
      tone: stringColumn(row.writing_tone, "direct"),
      bullet_style: stringColumn(row.writing_bullet_style, "balanced"),
      verbosity: stringColumn(row.writing_verbosity, "balanced"),
      keyword_density: stringColumn(row.writing_keyword_density, "natural"),
      avoid_first_person: Boolean(Number(row.writing_avoid_first_person ?? 1)),
    },
    revision_gates: {
      min_fit_score: Number(row.revision_min_fit_score ?? 8),
      must_have_coverage: Number(row.revision_must_have_coverage ?? 0.85),
      max_revision_attempts: Number(row.revision_max_attempts ?? 1),
    },
  };
}

function orderedValues(
  db: SqliteDatabase,
  table: string,
  valueColumn: string,
  orderColumn: string,
  extraWhere = "",
  extraParams: string[] = [],
): string[] {
  const where = extraWhere ? ` AND ${extraWhere}` : "";
  const rows = db.prepare(`
    SELECT ${valueColumn} AS value
    FROM ${table}
    WHERE tenant_id = ? AND profile_id = ?${where}
    ORDER BY ${orderColumn}
  `).all(TENANT_ID, PROFILE_ID, ...extraParams) as Array<{ value: unknown }>;
  return rows.map((row) => text(row.value));
}

function groupedValues(
  db: SqliteDatabase,
  table: string,
  keyColumn: string,
  valueColumn: string,
  orderColumn: string,
): Record<string, string[]> {
  const rows = db.prepare(`
    SELECT ${keyColumn} AS key, ${valueColumn} AS value
    FROM ${table}
    WHERE tenant_id = ? AND profile_id = ?
    ORDER BY ${keyColumn}, ${orderColumn}
  `).all(TENANT_ID, PROFILE_ID) as Array<{ key: unknown; value: unknown }>;
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    const key = text(row.key);
    grouped[key] = grouped[key] ?? [];
    grouped[key].push(text(row.value));
  }
  return grouped;
}

function rootValues(
  profile: ProfileShape,
  style: Record<string, string | number>,
  templateText: string,
  version: number,
): unknown[] {
  const personal = record(profile.personal);
  const work = record(profile.work_authorization);
  const compensation = record(profile.compensation);
  const experience = record(profile.experience);
  const availability = record(profile.availability);
  const eeo = record(profile.eeo_voluntary);
  const resume = record(profile.resume);
  const executive = record(resume.executive_profile);
  const rules = record(resume.tailoring_rules);
  const policy = record(rules.tailoring_policy);
  const writing = record(rules.writing_style);
  const revisionGates = record(rules.revision_gates);

  return [
    TENANT_ID,
    PROFILE_ID,
    text(personal.full_name),
    text(personal.preferred_name),
    text(personal.email),
    text(personal.phone),
    text(personal.address),
    text(personal.city),
    text(personal.province_state),
    text(personal.country),
    text(personal.postal_code),
    text(personal.linkedin_url),
    text(personal.github_url),
    text(personal.portfolio_url),
    text(personal.website_url),
    text(personal.password),
    text(work.legally_authorized_to_work),
    text(work.require_sponsorship),
    text(work.work_permit_type),
    text(compensation.salary_expectation),
    text(compensation.salary_currency, "USD"),
    text(compensation.salary_range_min),
    text(compensation.salary_range_max),
    text(compensation.currency_conversion_note),
    text(experience.years_of_experience_total),
    text(experience.education_level),
    text(experience.current_job_title),
    text(experience.current_company),
    text(experience.target_role),
    text(experience.target_track),
    text(experience.target_seniority_floor),
    text(experience.target_functions),
    text(experience.target_specializations),
    text(experience.target_locations),
    text(experience.target_work_models),
    text(availability.earliest_start_date),
    text(availability.available_for_full_time),
    text(availability.available_for_contract),
    text(eeo.gender, "Decline to self-identify"),
    text(eeo.race_ethnicity, "Decline to self-identify"),
    text(eeo.veteran_status, "Decline to self-identify"),
    text(eeo.disability_status, "Decline to self-identify"),
    text(executive.baseline_text),
    text(policy.mode, "balanced"),
    boolInt(policy.allow_title_reframing, false),
    boolInt(policy.allow_achievement_rewriting, true),
    boolInt(policy.allow_skill_reordering, true),
    boolInt(policy.allow_summary_rewrite, true),
    boolInt(policy.allow_minor_inference, false),
    text(policy.claim_mode, "evidence_reframing"),
    jsonTextArray(policy.auto_approvable_claim_modes),
    boolInt(policy.allow_adjacent_achievement_drafts, false),
    text(writing.tone, "direct"),
    text(writing.bullet_style, "balanced"),
    text(writing.verbosity, "balanced"),
    text(writing.keyword_density, "natural"),
    boolInt(writing.avoid_first_person, true),
    Number(rules.max_experience_bullets ?? 4),
    text(rules.custom_tailoring_prompt),
    boundedInteger("revision_gates.min_fit_score", revisionGates.min_fit_score ?? 8, 1, 10),
    boundedNumber("revision_gates.must_have_coverage", revisionGates.must_have_coverage ?? 0.85, 0, 1),
    boundedInteger("revision_gates.max_revision_attempts", revisionGates.max_revision_attempts ?? 1, 0, 10),
    style.document_font_size,
    style.paper_size,
    style.font_family,
    style.moderncv_style,
    style.moderncv_color,
    style.page_scale,
    style.hints_column_width_cm,
    style.body_alignment,
    templateText,
    version,
    new Date().toISOString(),
  ];
}

function styleFromRow(row: ProfileRow): Record<string, string | number> {
  return normalizeStyle({
    document_font_size: row.resume_style_document_font_size,
    paper_size: row.resume_style_paper_size,
    font_family: row.resume_style_font_family,
    moderncv_style: row.resume_style_moderncv_style,
    moderncv_color: row.resume_style_moderncv_color,
    page_scale: row.resume_style_page_scale,
    hints_column_width_cm: row.resume_style_hints_column_width_cm,
    body_alignment: row.resume_style_body_alignment,
  });
}

function normalizeStyle(value: Record<string, unknown>): Record<string, string | number> {
  const merged = { ...DEFAULT_STYLE, ...value };
  return {
    document_font_size: pickStyle("document_font_size", merged.document_font_size),
    paper_size: pickStyle("paper_size", merged.paper_size),
    font_family: pickStyle("font_family", merged.font_family),
    moderncv_style: pickStyle("moderncv_style", merged.moderncv_style),
    moderncv_color: pickStyle("moderncv_color", merged.moderncv_color),
    page_scale: boundedNumber("page_scale", merged.page_scale, 0.7, 1.0),
    hints_column_width_cm: boundedNumber("hints_column_width_cm", merged.hints_column_width_cm, 1.5, 5.0),
    body_alignment: pickStyle("body_alignment", merged.body_alignment),
  };
}

function pickStyle(key: keyof typeof STYLE_CHOICES, value: unknown): string {
  const normalized = text(value, String(DEFAULT_STYLE[key]));
  if (!STYLE_CHOICES[key].has(normalized)) {
    throw new ProfileInputError(`${key} must be one of: ${[...STYLE_CHOICES[key]].sort().join(", ")}.`);
  }
  return normalized;
}

function boundedNumber(key: string, value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ProfileInputError(`${key} must be a number.`);
  }
  if (parsed < min || parsed > max) {
    throw new ProfileInputError(`${key} must be between ${min} and ${max}.`);
  }
  return Math.round(parsed * 100) / 100;
}

function boundedInteger(key: string, value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ProfileInputError(`${key} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new ProfileInputError(`${key} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseProfileInput(profile: unknown, profileText: string | undefined): ProfileShape {
  const candidate = parseJsonObjectInput(profile, profileText, "profile data");
  rejectUnsupportedProfileTopLevelFields(candidate);
  const validated = ProfileSchema.safeParse(candidate);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "profile";
    throw new ProfileInputError(`profile validation failed at ${path}: ${issue?.message ?? "invalid input"}`);
  }
  return validated.data;
}

function rejectUnsupportedProfileTopLevelFields(candidate: Record<string, unknown>): void {
  const unsupported = Object.keys(candidate)
    .filter((key) => !SUPPORTED_PROFILE_TOP_LEVEL_KEYS.has(key))
    .sort();
  if (unsupported.length) {
    throw new ProfileInputError(
      `profile contains unsupported top-level profile field(s): ${unsupported.join(", ")}. ` +
        "SQLite profile storage only supports normalized Candidate Profile sections.",
    );
  }
}

function parseJsonObjectInput(value: unknown, textValue: string | undefined, label: string): Record<string, unknown> {
  let candidate = value;
  if (textValue !== undefined) {
    try {
      candidate = JSON.parse(textValue) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new ProfileInputError(`${label} is not valid JSON: ${message}`);
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProfileInputError(`${label} must be a JSON object.`);
  }
  return candidate as Record<string, unknown>;
}

function getProfileRow(db: SqliteDatabase): ProfileRow | undefined {
  return db
    .prepare("SELECT * FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?")
    .get(TENANT_ID, PROFILE_ID) as ProfileRow | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function jsonTextArray(value: unknown): string {
  return JSON.stringify(asTextArray(value));
}

function parseTextArray(value: unknown): string[] {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      candidate = [];
    }
  }
  return asTextArray(candidate);
}

function text(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function confidenceNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(1, parsed));
}

function stringColumn(value: string | number | null, fallback = ""): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function boolInt(value: unknown, fallback: boolean): number {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return ["true", "yes", "y", "1", "on"].includes(value.trim().toLowerCase()) ? 1 : 0;
  return value ? 1 : 0;
}
