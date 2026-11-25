"""Frozen SQLite feature manifests, physical schema digests and table inventories (Python generation 1)."""

SOURCE_CONTRACT = {
    "core": (
        "e25d2f94350301c288eceaedac314b266cc2d851ec7fa7bb935efbec636d98bc",
        "87341ed3c84054f9b7ddf4bdd2168c9dd9ea7b3248bbb4f99f043ac44abcdf2f",
        {
            "app_action_runs": 14,
            "app_events": 8,
            "app_feature_schemas": 2,
            "app_metadata": 2,
            "app_model_calls": 19,
            "app_settings": 3,
            "app_worker_heartbeats": 6,
        },
    ),
    "profile": (
        "943d6bf4abfe111253dcffd08436038a59bcf11b614cd5542e39ed906e43cc41",
        "f69055b3353584fa40735ed18c34b7691f7bcb81cefda2997b3f98581241032d",
        {
            "profile_achievements": 7,
            "profile_authoring_requests": 7,
            "profile_decisions": 9,
            "profile_determinations": 8,
            "profile_documents": 9,
            "profile_import_drafts": 7,
            "profile_source_versions": 4,
            "profile_sources": 6,
            "profile_transfer_provenance": 2,
            "profile_variants": 11,
            "profile_versions": 3,
        },
    ),
    "jobs": (
        "134c38931b04ca9e84cb5f3a9f308183140892eb07db2b5ce0a6705a28d16522",
        "2cae5399917eb653e879f9eedc69256b8f7c23de807378a5ecf1007067e74a4a",
        {
            "jobs_analysis": 6,
            "jobs_capture_attempts": 8,
            "jobs_delete_selections": 5,
            "jobs_identity_keys": 3,
            "jobs_jobs": 7,
            "jobs_observations": 11,
            "jobs_operations": 5,
            "jobs_postings": 6,
            "jobs_quarantine": 8,
        },
    ),
    "jobs_recover_discovery_details_v1": (
        "3254fbe5f5448c28cebe9384974203a765bde3bc70f71ae4981d1e3c7848fd42",
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        {},
    ),
    "jobs_url_imports_v1": (
        "17f8379d5010c341008a610843b5db9bcce7830f08b2eb13430eff924ebeaef8",
        "95a8a925256bca459849085c5da79ec101732795a8c8fc3aaddae3dca0c6dae6",
        {
            "jobs_url_import_calls": 4,
            "jobs_url_imports": 5,
        },
    ),
    "requirements": (
        "0fb47148aebd18cfc352e929962fd99bd44f7ffaace5a667bb2a630d5995c0d2",
        "da3ca1e521848d6c23386ead8d7c075702e6cd71d6fd4e23091b26867661e0e4",
        {
            "requirements_accepted": 2,
            "requirements_attempts": 9,
            "requirements_catalog": 3,
            "requirements_heads": 2,
            "requirements_meanings": 5,
            "requirements_model_cache": 9,
            "requirements_occurrences": 6,
            "requirements_retrieval": 3,
            "requirements_retrieval_config": 2,
            "requirements_retrieval_content": 4,
            "requirements_retrieval_data": 2,
            "requirements_retrieval_docsize": 2,
            "requirements_retrieval_idx": 3,
            "requirements_revision_actions": 4,
            "requirements_snapshots": 9,
        },
    ),
    "requirements_attempt_refusals_v1": (
        "5ca6d83aad47340d92c9217786b1774516edbf07fe8dcf9530022d6b3357e9e0",
        "905d3fc33353375cebb61d7e0699c8d86d79087ed60ac16034f57279d056b560",
        {
            "requirements_attempt_refusals": 3,
        },
    ),
    "requirements_normalization_v1": (
        "9bc7d7a60a5fcff14e28326370e3632badf75bee210fb60087645a8fc6c96f9b",
        "42dac685c73f424527277a5b42fdfde7e6dd6f66aeda90a3006621607340dc7f",
        {
            "requirements_aliases": 4,
            "requirements_normalization_cache": 6,
            "requirements_normalization_intents": 4,
            "requirements_reconciliation_certificate": 6,
            "requirements_reconciliations": 9,
        },
    ),
    "requirements_refresh_transport_v1": (
        "5884d7681071394fe62e7774cc355bed59ecb3cdb5916ca3f4f9e8825184546a",
        "427da7199eb33baf2901d7a264b70c71ba7712b7239cb907de7ab0d631a4e7d3",
        {
            "requirements_refresh_transport": 2,
        },
    ),
    "requirements_initial_cohort_v1": (
        "bfe8e556be17dedbf7e5294444b942228e5bd5273bec7877ec29fa6d5a8db9b6",
        "d65ea1c6ade2c0723c0435613ca9f790c066572367cdceb9cb8d03debc49053a",
        {
            "requirements_cohort_operations": 3,
        },
    ),
    "fit": (
        "bb1a7929c8396f46573a702d1a17c3f27f7ad0e509fbdac851fa351db15019fe",
        "d897049328c786bc962e2beb9ba1a09e688300492663e2649ea87a4d79304690",
        {
            "fit_assessments": 11,
            "fit_correction_anchors": 7,
            "fit_coverage_relations": 11,
            "fit_operation_receipts": 6,
            "fit_score_versions": 7,
            "fit_wording_requests": 7,
        },
    ),
    "fit_refresh": (
        "fe7b9dd3df2c41e76bcba46512e69a7bc7f8ce5275e676531197b97b126aa050",
        "7f05700136ed9be2961291e7b769a5a6fc4c38afe5720c11b583de82e63190d0",
        {
            "fit_refresh_operations": 7,
            "fit_wording_group_decisions": 2,
        },
    ),
    "fit_associations": (
        "498d0cd3f8f9dcef701e557fc45f6871add61aeac0e04011dce373d7008b68fb",
        "d378392b3f41c13644f036fcbc0afe90815350ea6832a966777dd87cc5573183",
        {
            "fit_user_association_versions": 4,
            "fit_user_associations": 9,
        },
    ),
    "fit_current_wordings": (
        "0d1f5dd45a1e05ae2c1f854bc2e44081f8b03dfc65ce0699bbc72399462438cc",
        "fdde88385a4eef451afaa60a530d8d30886b183e9192fb5661c471356a2b3593",
        {
            "fit_current_wording_versions": 3,
            "fit_current_wordings": 7,
        },
    ),
    "fit_initial_cohort_v1": (
        "5c9b45731d2d62d46be0654cd54f5bee280141e55fcac3f9fbed7cb980098d41",
        "1b1510f17b828af4b06c4be63e69698e68d8090e5b95e1775de71b3e8f228fe6",
        {
            "fit_initial_cohort_operations": 3,
        },
    ),
    "resumes": (
        "4ac3f909573488b33e1fe42f456a2aca4ca68adcdf3bf997cf90ba473c5bf29e",
        "e5ae2a5505d8518b8a486739135e7bb7ff30445d7596088668afb221443135e8",
        {
            "resumes_artifact_retirements": 10,
            "resumes_documents": 5,
            "resumes_operation_receipts": 3,
            "resumes_template_preferences": 3,
            "resumes_templates": 3,
        },
    ),
    "discovery": (
        "a1afa137c979977435b68905a864690839eb49728cdf4c1b092db1525c172ac7",
        "ac1ca3aa3a17e5c6e543d0990a8abdc92c28cf3187b949b65d917ea323fcc3b9",
        {
            "discovery_candidate_evidence": 4,
            "discovery_candidates": 7,
            "discovery_captures": 6,
            "discovery_feedback": 5,
            "discovery_feedback_proposals": 5,
            "discovery_intake_receipts": 7,
            "discovery_operations": 5,
            "discovery_runs": 14,
            "discovery_settings": 3,
            "discovery_source_runs": 7,
            "discovery_sources": 5,
            "discovery_target_plans": 5,
            "discovery_units": 6,
        },
    ),
    "companies": (
        "745fa2a3e6b6a1c497806ca67e95925019e700495e27dfcbc6faba431694ed7c",
        "81027ab3c4d0b3aef82562dd54f8780c77245da9c13a58d39aaf096c1f544a8e",
        {
            "companies_accepted": 3,
            "companies_attempts": 3,
            "companies_configurations": 3,
            "companies_determinations": 6,
            "companies_links": 4,
        },
    ),
    "contacts": (
        "1c45e762c63256730f752223e3e43272d79204b403915fabcf3b6bdf606144d6",
        "67bcfb1f1e0c7d5edd05b7fb17917639e73cc8f9f25d1e368186fcbd3da573cf",
        {
            "contacts_model_records": 4,
            "contacts_records": 7,
            "contacts_research": 4,
        },
    ),
    "applications": (
        "d32692b321f9bd62e1f1638eaca4a3b0ceeb0e165bb91f4579aa53c4ddffb7d0",
        "25aeb201edc91c553fe058f996e76c89aa1e1899a075a56dbbdafd219fb95b11",
        {
            "applications_action_receipts": 5,
            "applications_decisions": 7,
            "applications_determinations": 9,
            "applications_failures": 7,
            "applications_payloads": 6,
            "applications_rehearsals": 6,
            "applications_repeat_checks": 6,
            "applications_repeat_overrides": 9,
            "applications_runs": 8,
            "applications_screening": 6,
            "applications_screening_library": 3,
            "applications_state": 5,
            "applications_submit_intents": 9,
            "applications_submit_receipts": 6,
        },
    ),
    "application_feedback": (
        "a3f6b2768669861aac6f16276e14e20b2fdff6ac7b86137e486dc3381737208a",
        "4f98638f83da5cb2976c0e1f0b2c55fed3e21bec5f083e1002fa783f12571d2e",
        {
            "application_feedback_evidence": 19,
            "application_feedback_outcomes": 13,
            "application_feedback_receipts": 8,
            "application_feedback_suggestions": 21,
        },
    ),
    "interviews": (
        "b2ebf3f7e492d6f4fea77bcf5e9fea137568281ff0c14ee2ade8e6d18a664446",
        "840632db04874563208864ab6b6ad6b12c696bea971c72388424401976bc592b",
        {
            "interview_determinations": 3,
            "interview_notes": 4,
            "interview_preparations": 5,
        },
    ),
    "interviews_runs": (
        "9c5e0f2889b9ba4a80921c98e05d33fc861c04cecd8b0f05f1f4effd34cc60f9",
        "63ab854e9e8a4331d55f5b7bd16873e75983a03bac5711060a74203ec956694c",
        {
            "interview_generation_runs": 4,
        },
    ),
    "learning": (
        "8fc5f7cf20c87df232294d089d15db83f02a3935ca0df463e7d49a9d894f553b",
        "a46f06bf3517f4d0d4133a1d64b594a83285e96d3ee68d97eb6e8f91063bdaf6",
        {
            "learning_attempts": 4,
            "learning_cohorts": 3,
            "learning_milestones": 3,
        },
    ),
    "learning_requests": (
        "b6024608af4c06cc99032169c93fa1f55458e623253f75e661544702f2f0e3df",
        "f6a499af9caf35dc9b6cca9cf3a705bc7ebe60dace20c108f9fda8852a2e5af8",
        {
            "learning_requests": 13,
        },
    ),
    "compensation": (
        "0522add23e66ed88217df29c8597e8c0388d0fb1f42b70e888a1fda5a66ebbca",
        "b1975c9e37566c062d6550b2186b48ad27d2a088e05e0b202ceae9882ef16ecf",
        {
            "compensation_benchmark_inputs": 10,
            "compensation_market": 5,
            "compensation_policy_revision": 2,
            "compensation_posted": 6,
            "compensation_price_snapshots": 5,
            "compensation_rate_snapshots": 4,
            "compensation_refresh_completions": 4,
            "compensation_refresh_status": 6,
            "compensation_source_preferences": 2,
            "compensation_source_receipts": 6,
        },
    ),
    "offers": (
        "0d9fa991f7840d1b291507486304e8df60d3ad15e9b0933f787124bc6fac0d45",
        "740c2869b7598584a27d0b58db05c7f6a2dfde76f3c1258f92823e8c8b2e39d6",
        {
            "offer_decisions": 5,
            "offer_terms": 4,
        },
    ),
    "outreach": (
        "d66c18623c5e891e3b52a2ac174c6f11ddbea89b7f67f79c3cadf06c292ee629",
        "b42e23417ad61c63fb43ae49a38ef5ee6b324dc9538c72e04be457360bb8ee0c",
        {
            "outreach_action_receipts": 4,
            "outreach_model_records": 4,
            "outreach_proposal_receipts": 4,
            "outreach_records": 5,
        },
    ),
    "digest": (
        "dc6f14364c89515c98e96f7879953974628cd05f3cd974f8b7d0c585cced3aad",
        "e0cf2b5118ed91137b0f0945c6cfcfbacce07ab3ff73d53177c6a1956998cd1a",
        {
            "digest_review_state": 3,
        },
    ),
    "preparation": (
        "ff5a3687e37ac60a800ab5b1c8920f0530cb97aa8461d32d6cc98f3a637f1186",
        "006c982fa2bc1f04d03cb498040d8091155d5308826af43dfd492bea53d34465",
        {
            "preparation_job_claims": 3,
            "preparation_runs": 7,
            "preparation_steps": 8,
        },
    ),
    "worker_identity": (
        "b88659f4d8863706dcbd76a8259cc67a5477b6aa3cc027a7ef7eb2aba124c396",
        "a5ccc9729bb3ad99ef7c93803397226daffc21733e5a83d14f1321e1545a5cfc",
        {
            "app_worker_registrations": 3,
            "app_workflow_history": 4,
        },
    ),
    "runtime_schedules": (
        "3695e4048576a21988d1d9e606bf47c76db0b8edc2e9c1e9ed09bc33f6a1ddfb",
        "ff2f1b242e274b0523dc2f9c3efad974e68c1dec2f90a183c86388d0d0e243ae",
        {
            "app_schedule_cursors": 2,
        },
    ),
    "extension": (
        "69a25a308638f216a0425c3c1f7f0622e72af731aee3af51cd3670bfa484cabb",
        "2e5d5be60571f6606137c874f7c82d999aa2148cd19bcf2f6953ac1bb4d44bf1",
        {
            "extension_browser_tasks": 14,
            "extension_capture_receipts": 6,
            "extension_installation": 4,
        },
    ),
}
