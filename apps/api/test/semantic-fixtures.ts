import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import schemas from "../../../packages/contracts/src/semantic-result-schemas.json" with { type: "json" };

// Explicit model decisions for read-side contracts. These are not semantic
// expectations for source prose; tests choose the verdict they need to exercise.
export function recordModelDecision(
  db: Database.Database,
  kind: keyof typeof schemas,
  entityId: string,
  result: object,
  tenantId = "local",
): string {
  const contract = schemas[kind];
  const id = createHash("sha256")
    .update(JSON.stringify({ kind, entityId, result, tenantId }))
    .digest("hex");
  const envelope = {
    determination_id: id,
    tenant_id: tenantId,
    entity_id: entityId,
    kind,
    schema_version: contract.schemaVersion,
    prompt_version: contract.promptVersion,
    provider: "synthetic",
    model: "synthetic",
    lane: ["message_outcome", "message_link"].includes(kind)
      ? "enrichment"
      : [
            "repeat_equivalence",
            "form_mapping",
            "apply_terminal_report",
          ].includes(kind)
        ? "apply"
        : ["posting_triage", "discovery_query_plan"].includes(kind)
          ? "discovery"
          : [
                "required_bullet_coaching",
                "candidate_interpretation",
                "search_preferences",
                "resume_extraction",
              ].includes(kind)
            ? "profile"
            : ["benchmark_classification", "posted_compensation"].includes(kind)
              ? "compensation"
              : kind === "job_interpretation"
                ? "enrichment"
                : kind === "scoring"
                  ? "scoring"
                  : "tailoring",
    input_fingerprint: id,
    created_at: "2026-10-07T00:00:00Z",
    result,
  };
  db.prepare(
    "INSERT OR IGNORE INTO semantic_determinations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    tenantId,
    id,
    entityId,
    kind,
    envelope.schema_version,
    envelope.prompt_version,
    envelope.provider,
    envelope.model,
    envelope.lane,
    id,
    envelope.created_at,
    JSON.stringify(envelope),
  );
  return id;
}

export function bindDecision(
  db: Database.Database,
  entityKind: string,
  entityId: string,
  entityVersion: string,
  kind: string,
  id: string,
  tenantId = "local",
): void {
  db.prepare(
    "INSERT OR REPLACE INTO semantic_entity_bindings VALUES (?,?,?,?,?,?)",
  ).run(tenantId, entityKind, entityId, entityVersion, kind, id);
}

export function recordOutcomeDecision(
  db: Database.Database,
  suggestionId: string,
  messageId: string,
  kind: string,
  confidence: number,
  text: string,
): void {
  const id = recordModelDecision(db, "message_outcome", messageId, {
    kind,
    confidence,
    citations: [{ source_id: "message", quote: text, exact_values: [] }],
    rationale: "Explicit model outcome",
  });
  bindDecision(
    db,
    "outcome_suggestion",
    suggestionId,
    id,
    "message_outcome",
    id,
  );
}

export function recordRepeatDecision(
  db: Database.Database,
  targetId: string,
  priorId: string,
  verdict: "equivalent" | "different" | "uncertain",
): void {
  const rows = [targetId, priorId].map(
    (id) =>
      db
        .prepare(
          `SELECT j.job_id,j.title,
    COALESCE(j.company,'') AS company,
    j.location,j.salary,j.description,
    COALESCE((SELECT je.application_url FROM job_enrichments je WHERE je.tenant_id=j.tenant_id AND je.job_id=j.job_id ORDER BY je.updated_at DESC LIMIT 1),j.url) AS application_url,
    COALESCE((SELECT je.full_description FROM job_enrichments je WHERE je.tenant_id=j.tenant_id AND je.job_id=j.job_id AND je.current_status='enriched' AND length(trim(je.full_description))>0 ORDER BY je.updated_at DESC LIMIT 1),j.full_description) AS full_description
    FROM jobs j WHERE j.tenant_id='local' AND j.job_id=?`,
        )
        .get(id) as Record<string, string>,
  );
  const values = rows.flatMap((row) => [
    row.job_id,
    row.title ?? "",
    row.company ?? "",
    row.application_url ?? "",
    row.location ?? "",
    row.salary ?? "",
    row.full_description || row.description || "",
    "",
  ]);
  const version = createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex");
  const entity = targetId + ":" + priorId;
  const id = recordModelDecision(db, "repeat_equivalence", entity, {
    verdict,
    citations: [
      { source_id: "target", quote: rows[0]!.title, exact_values: [] },
      { source_id: "prior", quote: rows[1]!.title, exact_values: [] },
    ],
    rationale: "Explicit model equivalence",
  });
  bindDecision(db, "repeat_pair", entity, version, "repeat_equivalence", id);
}

export function recordCoachingDecision(
  db: Database.Database,
  params: Record<string, unknown>,
  judgments: Array<{
    reference: string;
    kind: string;
    guidance: string;
    proposedText: string | null;
  }> = [],
) {
  const sources = params.sources as Array<{
    reference: string;
    originalText: string;
  }>;
  const citations = sources
    .slice(0, 1)
    .map((source) => ({
      source_id: source.reference,
      quote: source.originalText,
      exact_values: [],
    }));
  const result = {
    suggestions: judgments.map((finding) => ({
      ...finding,
      citations: citations.map((cite) => ({
        ...cite,
        source_id: finding.reference,
      })),
    })),
    citations,
    rationale: "Explicit synthetic coaching decision",
  };
  const id = recordModelDecision(
    db,
    "required_bullet_coaching",
    "profile:required_bullets",
    result,
  );
  bindDecision(
    db,
    "profile_coaching",
    "profile:required_bullets",
    String(params.expectedProfileVersion),
    "required_bullet_coaching",
    id,
  );
  const envelope = JSON.parse(
    (
      db
        .prepare(
          "SELECT envelope_json FROM semantic_determinations WHERE tenant_id='local' AND determination_id=?",
        )
        .get(id) as { envelope_json: string }
    ).envelope_json,
  );
  return {
    profileVersion: params.expectedProfileVersion,
    ...result,
    determination: envelope,
  };
}

const cite = (sourceId: string, quote: string) => ({
  source_id: sourceId,
  quote,
  exact_values: [],
});
const field = (value: string, citation: ReturnType<typeof cite>) => ({
  value,
  citations: [citation],
  rationale: "Explicit synthetic model decision",
});
export function recordCompensationAuthority(
  db: Database.Database,
  jobId: string,
  tenantId = "local",
): void {
  const posted = db
    .prepare(
      "SELECT * FROM job_posted_compensation_facts WHERE tenant_id=? AND job_id=?",
    )
    .get(tenantId, jobId) as Record<string, unknown> | undefined;
  if (posted) {
    const result = Object.fromEntries(
      [
        "parse_state",
        "currency",
        "period",
        "component",
        "minimum_amount",
        "maximum_amount",
        "confidence",
      ].map((key) => [key, posted[key]]),
    );
    const id = recordModelDecision(
      db,
      "posted_compensation",
      jobId,
      {
        ...result,
        warnings: JSON.parse(String(posted.warnings_json)),
        citations: posted.source_text
          ? [cite("posted_compensation_source", String(posted.source_text))]
          : [],
        rationale: "Explicit synthetic pay decision",
      },
      tenantId,
    );
    bindDecision(
      db,
      "posted_compensation",
      jobId,
      String(posted.source_hash),
      "posted_compensation",
      id,
      tenantId,
    );
  }
  const row = db
    .prepare(
      "SELECT * FROM job_market_compensation_estimates WHERE tenant_id=? AND job_id=?",
    )
    .get(tenantId, jobId) as Record<string, unknown> | undefined;
  if (!row) return;
  const family = "software_engineering",
    level = "senior",
    country = "DE";
  db.prepare(
    "UPDATE job_market_compensation_estimates SET occupation_code=?,seniority_label=? WHERE tenant_id=? AND job_id=?",
  ).run(family, level, tenantId, jobId);
  const source = cite("posting", "Explicit synthetic posting");
  const place = {
    country_code: country,
    region: "europe",
    locality: null,
    citations: [source],
    rationale: "Explicit synthetic place",
  };
  const jobResult = {
    track: field("ic", source),
    seniority: field(level, source),
    occupation_family: field(family, source),
    work_model: field("unknown", source),
    places: [place],
    constraints: [],
    compensation: [],
    requirements: [],
  };
  const id = recordModelDecision(
    db,
    "job_interpretation",
    jobId,
    jobResult,
    tenantId,
  );
  bindDecision(
    db,
    "market_compensation",
    jobId,
    String(row.estimator_version),
    "job_interpretation",
    id,
    tenantId,
  );
  const evidence = JSON.parse(String(row.selected_evidence_json)) as Record<
    string,
    unknown
  >[];
  const population = evidence.length
    ? evidence
    : row.estimate_state !== "estimated_range"
      ? []
      : [
          {
            source_id: "levels_fyi",
            company_name: "Synthetic employer",
            role_title: "Synthetic role",
            location: country,
            level_label: level,
            currency: row.currency,
            period: row.period,
            component: row.component,
            minimum_amount: row.minimum_amount,
            maximum_amount: row.maximum_amount,
            sample_count: row.sample_count,
            company_score: 1,
            role_score: 1,
            level_score: 1,
            location_score: 1,
          },
        ];
  const classified = population.map((item, index) => {
    const entity = `${jobId}:benchmark:${index}`;
    const citation = cite(
      "provider_row",
      String(item.role_title ?? "Synthetic provider role"),
    );
    const result = {
      occupation_family: field(family, citation),
      seniority: field(level, citation),
      places: [{ ...place, citations: [citation] }],
      market_scope: field("company", citation),
      company_tier: field("unknown", citation),
    };
    const receipt = recordModelDecision(
      db,
      "benchmark_classification",
      entity,
      result,
      tenantId,
    );
    return {
      ...item,
      determination_id: receipt,
      classification_entity_id: entity,
      occupation_family_code: family,
      seniority_code: level,
      country_codes: [country],
    };
  });
  db.prepare(
    "UPDATE job_market_compensation_estimates SET selected_evidence_json=? WHERE tenant_id=? AND job_id=?",
  ).run(JSON.stringify(classified), tenantId, jobId);
}

/** Explicit model choices over the saved revision; source lines/IDs are mechanical. */
export function recordEditedReview(
  db: Database.Database,
  params: Record<string, unknown>,
  verdict: "pass" | "fail" = "pass",
) {
  const revisionId = String(params.revisionId);
  const revision = db
    .prepare(
      "SELECT edited_text,job_id FROM resume_review_draft_revisions WHERE tenant_id='local' AND revision_id=?",
    )
    .get(revisionId) as { edited_text: string; job_id: string };
  const textFingerprint = createHash("sha256")
    .update(revision.edited_text.replace(/\r\n/g, "\n"))
    .digest("hex");
  const deltas = db
    .prepare(
      "SELECT delta_id,before_text,after_text FROM resume_review_edit_deltas WHERE tenant_id='local' AND revision_id=? ORDER BY delta_id",
    )
    .all(revisionId) as Array<{
    delta_id: string;
    before_text: string;
    after_text: string;
  }>;
  const editIntentId = deltas.length
    ? recordModelDecision(db, "edit_intent", revisionId, {
        edits: deltas.map((delta) => ({
          edit_id: delta.delta_id,
          kind: "factual_correction",
          citations: [
            cite(
              delta.delta_id,
              JSON.stringify({
                before: delta.before_text,
                after: delta.after_text,
              }).slice(0, 4000),
            ),
          ],
          rationale: "Explicit model intent",
        })),
      })
    : null;
  if (params.operation === "intent")
    return { revisionId, textFingerprint, editIntentId };
  const lines = revision.edited_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, index) => ({
      line_id: `edited:line:${index + 1}`,
      verdict,
      source_evidence: [],
      served_requirements: [],
      claims: [],
      findings:
        verdict === "pass"
          ? []
          : [
              {
                kind: "unsupported_claim",
                rationale: "Explicit rejection",
                citation: cite(`line:edited:line:${index + 1}`, text),
              },
            ],
    }));
  const claimVerificationId = recordModelDecision(
    db,
    "claim_verification",
    revisionId,
    { verdict, lines, rationale: "Explicit model verdict" },
  );
  const qualityDeterminationId = recordModelDecision(
    db,
    "artifact_quality",
    revisionId,
    {
      verdict: "pass",
      score: 0.9,
      findings: [],
      evidence_corrections: [],
      rationale: "Explicit quality verdict",
    },
  );
  const profile = db
    .prepare(
      "SELECT version FROM candidate_profiles WHERE tenant_id='local' ORDER BY profile_id LIMIT 1",
    )
    .get() as { version: number };
  const analysis = db
    .prepare(
      "SELECT max(generation) as generation FROM job_employer_analysis WHERE tenant_id='local' AND job_id=?",
    )
    .get(revision.job_id) as { generation: number };
  return {
    passed: verdict === "pass",
    claimVerificationId,
    qualityDeterminationId,
    editIntentId,
    revisionId,
    textFingerprint,
    profileVersion: profile.version,
    analysisGeneration: analysis.generation,
    anchors: lines.map((line) => ({
      lineId: line.line_id,
      evidenceIds: [],
      requirementIds: [],
      transformType: "user_edit",
      reason: "Explicit model anchor",
      determinationId: claimVerificationId,
    })),
    errors: verdict === "pass" ? [] : ["Explicit rejection"],
  };
}

export function recordCandidateProposal(
  db: Database.Database,
  params: Record<string, unknown>,
  roles: Array<{
    title: string;
    classification: "direct" | "adjacent";
    track: string;
    seniority: string;
  }> = [
    {
      title: "Senior Platform Engineer",
      classification: "direct",
      track: "ic",
      seniority: "senior",
    },
  ],
) {
  const row = db
    .prepare(
      "SELECT entry_id,title FROM candidate_profile_experience_entries WHERE tenant_id='local' ORDER BY position_index LIMIT 1",
    )
    .get() as { entry_id: string; title: string };
  const citation = cite(`experience:${row.entry_id}:title`, row.title);
  const target_roles = roles.map((role) => ({
    ...role,
    citations: [citation],
    rationale: "Explicit model proposal",
  }));
  const id = recordModelDecision(db, "candidate_interpretation", "default", {
    track: field("ic", citation),
    seniority: field("senior", citation),
    functions: [],
    target_roles,
    target_preferences: [],
    experience_places: [],
  });
  bindDecision(
    db,
    "profile",
    "default",
    String(params.expectedProfileVersion),
    "candidate_interpretation",
    id,
  );
  db.prepare(
    "INSERT OR IGNORE INTO candidate_interpretation_suggestions (tenant_id,profile_id,profile_version,determination_id,status) VALUES ('local','default',?,?,'pending_confirmation')",
  ).run(params.expectedProfileVersion, id);
  return {
    profileVersion: params.expectedProfileVersion,
    determinationId: id,
    status: "pending_confirmation",
    suggestions: target_roles
      .slice(0, Number(params.maximumSuggestions ?? 3))
      .map((role) => ({ ...role, evidenceIds: [citation.source_id] })),
    preferenceSuggestions: [],
    strategy: "model",
    warnings: [],
  };
}

/** Chosen model links for projection/ID-join contracts; no similarity inference. */
export function recordArtifactAuthority(
  db: Database.Database,
  quotes: Record<string, string> = {},
): void {
  const artifacts = db
    .prepare(
      "SELECT * FROM job_materials_artifacts WHERE artifact_type IN ('tailored_resume','tailored_resume_txt','resume_pdf','tailored_resume_pdf')",
    )
    .all() as Array<Record<string, unknown>>;
  for (const artifact of artifacts) {
    const rows = db
      .prepare(
        "SELECT * FROM job_bullet_provenance WHERE tenant_id=? AND job_id=? AND generation=? ORDER BY position",
      )
      .all(artifact.tenant_id, artifact.job_id, artifact.generation) as Array<
      Record<string, unknown>
    >;
    if (!rows.length) continue;
    const lines = rows.map((row) => ({
      line_id: row.bullet_id,
      verdict: "pass",
      claims: [],
      findings: [],
      source_evidence: (
        JSON.parse(String(row.evidence_ids_json)) as string[]
      ).map((ident) =>
        cite(ident, quotes[ident] ?? String(row.generated_text)),
      ),
      served_requirements: (
        JSON.parse(String(row.requirement_ids_json)) as string[]
      ).map((ident) => ({
        requirement_id: ident,
        citation: cite(ident, ident),
        rationale: "Explicit model requirement choice",
      })),
    }));
    const id = recordModelDecision(
      db,
      "claim_verification",
      String(artifact.job_id),
      { verdict: "pass", lines, rationale: "Explicit model anchors" },
      String(artifact.tenant_id),
    );
    const metadata = {
      ...JSON.parse(String(artifact.metadata_json ?? "{}")),
      claim_verification_id: id,
      line_anchors: rows.map((row) => ({
        line_id: row.bullet_id,
        evidence_ids: JSON.parse(String(row.evidence_ids_json)),
        requirement_ids: JSON.parse(String(row.requirement_ids_json)),
        transform_type: row.transform_type,
        reason: row.rationale,
      })),
    };
    db.prepare(
      "UPDATE job_materials_artifacts SET metadata_json=? WHERE tenant_id=? AND artifact_id=? AND generation=?",
    ).run(
      JSON.stringify(metadata),
      artifact.tenant_id,
      artifact.artifact_id,
      artifact.generation,
    );
    for (const row of rows)
      db.prepare(
        "INSERT OR REPLACE INTO artifact_line_anchors (tenant_id,artifact_kind,artifact_id,generation,line_id,evidence_ids_json,requirement_ids_json,transform_type,reason,determination_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        artifact.tenant_id,
        artifact.artifact_type,
        artifact.artifact_id,
        artifact.generation,
        row.bullet_id,
        row.evidence_ids_json,
        row.requirement_ids_json,
        row.transform_type,
        row.rationale,
        id,
      );
  }
}

export function recordRoleFeedback(
  db: Database.Database,
  jobId: string,
  version: number,
  verdict:
    | "none"
    | "propose_exact_title_exclusion" = "propose_exact_title_exclusion",
): void {
  const citation = cite("posting", "Explicit synthetic posting");
  const id = recordModelDecision(db, "scoring", jobId, {
    score: 2,
    technical_fit: 2,
    experience_fit: 2,
    role_fit: 2,
    fit_band: "poor",
    confidence: "high",
    eligibility: { status: "eligible", blockers: [], warnings: [] },
    matched_signals: [],
    missing_signals: [],
    transferable_signals: [],
    requirement_assessments: [],
    keywords: ["Synthetic"],
    discovery_feedback: {
      verdict,
      reason: "Explicit model feedback",
      citations: [citation],
    },
    reasoning: "Explicit model score",
    citations: [citation],
  });
  db.prepare(
    "UPDATE job_scores SET trace_json=? WHERE tenant_id='local' AND job_id=? AND version=?",
  ).run(JSON.stringify({ determination_id: id }), jobId, version);
}

/** Chosen provider rows for compensation persistence and read-path QA. */
export function seedSyntheticCompensation(
  db: Database.Database,
  jobId: string,
  tenantId = "local",
  postedMinimum = 90_000,
  marketMinimum = 100_000,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary, parse_state,
      currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    jobId,
    "jobs.salary",
    `EUR ${postedMinimum}-${postedMinimum + 30_000}/year`,
    `EUR ${postedMinimum}-${postedMinimum + 30_000}/year`,
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    postedMinimum,
    postedMinimum + 30_000,
    postedMinimum,
    postedMinimum + 30_000,
    null,
    "high",
    "[]",
    "posted-compensation-v1",
    "hash-posted",
    new Date().toISOString(),
  );
  db.prepare(
    `INSERT OR REPLACE INTO job_market_compensation_estimates (
      tenant_id, job_id, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_interval_minimum_amount,
      confidence_interval_maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, selected_evidence_json, insufficient_reasons_json,
      unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
      estimator_version, estimated_at, company_name, normalized_company,
      role_title, normalized_role, company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    jobId,
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    marketMinimum,
    marketMinimum + 30_000,
    marketMinimum - 10_000,
    marketMinimum + 40_000,
    "medium",
    0.75,
    1,
    1,
    "reported company-role compensation",
    "Europe",
    null,
    null,
    null,
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "company-role-reported-compensation-v1",
    new Date().toISOString(),
    null,
    null,
    null,
    null,
    "unknown",
    "none",
  );
  recordCompensationAuthority(db, jobId, tenantId);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json) VALUES (?,?,1,'enrich','CompensationFactsUpdated','info','Synthetic compensation updated',?,'{}')")
    .run(tenantId, jobId, new Date().toISOString());
}
