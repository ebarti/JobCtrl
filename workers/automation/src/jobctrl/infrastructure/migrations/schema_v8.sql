CREATE TABLE compensation_role_families (
    taxonomy_version TEXT NOT NULL CHECK (length(trim(taxonomy_version)) > 0),
    role_family_code TEXT NOT NULL CHECK (length(trim(role_family_code)) > 0),
    display_name     TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    isco_codes_json  TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(isco_codes_json) AND json_type(isco_codes_json) = 'array'
    ),
    created_at       TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    PRIMARY KEY (taxonomy_version, role_family_code)
);

CREATE TABLE compensation_direct_benchmark_facts (
    tenant_id                          TEXT NOT NULL DEFAULT 'local',
    fact_id                            TEXT NOT NULL CHECK (
        length(fact_id) = 36
        AND substr(fact_id, 9, 1) = '-'
        AND substr(fact_id, 14, 1) = '-'
        AND substr(fact_id, 19, 1) = '-'
        AND substr(fact_id, 24, 1) = '-'
        AND replace(fact_id, '-', '') NOT GLOB '*[^a-f0-9]*'
    ),
    taxonomy_version                   TEXT NOT NULL,
    role_family_code                   TEXT NOT NULL,
    seniority_label                    TEXT NOT NULL CHECK (
        seniority_label IN (
            'entry', 'mid', 'senior', 'staff', 'principal',
            'manager', 'director', 'executive', 'unknown'
        )
    ),
    country_code                       TEXT NOT NULL CHECK (
        length(country_code) = 2
        AND country_code = upper(country_code)
        AND country_code NOT GLOB '*[^A-Z]*'
    ),
    subdivision_code                   TEXT NOT NULL DEFAULT '',
    locality                           TEXT NOT NULL DEFAULT '',
    geography_scope                    TEXT NOT NULL CHECK (
        geography_scope IN ('country', 'country_subdivision', 'locality')
    ),
    market_scope                       TEXT NOT NULL CHECK (
        market_scope IN ('market', 'company')
    ),
    normalized_company                 TEXT,
    component                          TEXT NOT NULL CHECK (
        component IN ('base_salary', 'total_compensation')
    ),
    original_currency                  TEXT NOT NULL CHECK (
        length(original_currency) = 3
        AND original_currency = upper(original_currency)
        AND original_currency NOT GLOB '*[^A-Z]*'
    ),
    original_period                    TEXT NOT NULL CHECK (
        original_period IN ('year', 'month', 'week', 'day', 'hour')
    ),
    original_minimum_amount            INTEGER NOT NULL CHECK (original_minimum_amount > 0),
    original_maximum_amount            INTEGER NOT NULL CHECK (
        original_maximum_amount >= original_minimum_amount
    ),
    eur_annual_minimum_amount          INTEGER NOT NULL CHECK (eur_annual_minimum_amount > 0),
    eur_annual_maximum_amount          INTEGER NOT NULL CHECK (
        eur_annual_maximum_amount >= eur_annual_minimum_amount
    ),
    confidence_interval_minimum_amount INTEGER NOT NULL CHECK (
        confidence_interval_minimum_amount > 0
        AND confidence_interval_minimum_amount <= eur_annual_minimum_amount
    ),
    confidence_interval_maximum_amount INTEGER NOT NULL CHECK (
        confidence_interval_maximum_amount >= eur_annual_maximum_amount
    ),
    confidence_score                   REAL NOT NULL CHECK (
        confidence_score >= 0 AND confidence_score <= 1
    ),
    sample_count                       INTEGER NOT NULL CHECK (sample_count > 0),
    source_id                          TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
    source_provenance                  TEXT NOT NULL CHECK (
        source_provenance IN ('public', 'licensed', 'manual', 'employer_posted', 'official')
    ),
    source_snapshot_id                 TEXT NOT NULL CHECK (length(trim(source_snapshot_id)) > 0),
    source_url                         TEXT,
    attribution                       TEXT NOT NULL CHECK (length(trim(attribution)) > 0),
    fx_reference_json                  TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(fx_reference_json) AND json_type(fx_reference_json) = 'object'
    ),
    as_of_date                         TEXT NOT NULL CHECK (length(trim(as_of_date)) > 0),
    fetched_at                         TEXT NOT NULL CHECK (length(trim(fetched_at)) > 0),
    fresh_until                        TEXT NOT NULL CHECK (length(trim(fresh_until)) > 0),
    evidence_hash                      TEXT NOT NULL CHECK (
        length(evidence_hash) = 64
        AND evidence_hash NOT GLOB '*[^a-f0-9]*'
    ),
    created_at                         TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    PRIMARY KEY (tenant_id, fact_id),
    UNIQUE (tenant_id, evidence_hash),
    FOREIGN KEY (taxonomy_version, role_family_code)
        REFERENCES compensation_role_families(taxonomy_version, role_family_code)
        ON DELETE RESTRICT,
    CHECK (subdivision_code = '' OR length(trim(subdivision_code)) > 0),
    CHECK (locality = '' OR length(trim(locality)) > 0),
    CHECK (
        (geography_scope = 'country' AND subdivision_code = '' AND locality = '')
        OR (
            geography_scope = 'country_subdivision'
            AND subdivision_code != ''
            AND locality = ''
        )
        OR (geography_scope = 'locality' AND locality != '')
    ),
    CHECK (
        (market_scope = 'market' AND normalized_company IS NULL)
        OR (
            market_scope = 'company'
            AND normalized_company IS NOT NULL
            AND length(trim(normalized_company)) > 0
        )
    )
);

CREATE TABLE compensation_price_level_facts (
    tenant_id            TEXT NOT NULL DEFAULT 'local',
    fact_id              TEXT NOT NULL CHECK (
        length(fact_id) = 36
        AND substr(fact_id, 9, 1) = '-'
        AND substr(fact_id, 14, 1) = '-'
        AND substr(fact_id, 19, 1) = '-'
        AND substr(fact_id, 24, 1) = '-'
        AND replace(fact_id, '-', '') NOT GLOB '*[^a-f0-9]*'
    ),
    country_code         TEXT NOT NULL CHECK (
        length(country_code) = 2
        AND country_code = upper(country_code)
        AND country_code NOT GLOB '*[^A-Z]*'
    ),
    category             TEXT NOT NULL CHECK (
        category IN (
            'actual_individual_consumption',
            'household_final_consumption',
            'general_price_level'
        )
    ),
    reference_year       INTEGER NOT NULL CHECK (reference_year >= 2000),
    base_geography_code  TEXT NOT NULL CHECK (length(trim(base_geography_code)) > 0),
    index_value          REAL NOT NULL CHECK (index_value > 0),
    source_id            TEXT NOT NULL CHECK (
        source_id IN ('eurostat', 'world_bank', 'oecd', 'manual_official')
    ),
    source_snapshot_id   TEXT NOT NULL CHECK (length(trim(source_snapshot_id)) > 0),
    source_url           TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
    attribution          TEXT NOT NULL CHECK (length(trim(attribution)) > 0),
    as_of_date           TEXT NOT NULL CHECK (length(trim(as_of_date)) > 0),
    fetched_at           TEXT NOT NULL CHECK (length(trim(fetched_at)) > 0),
    fresh_until          TEXT NOT NULL CHECK (length(trim(fresh_until)) > 0),
    evidence_hash        TEXT NOT NULL CHECK (
        length(evidence_hash) = 64
        AND evidence_hash NOT GLOB '*[^a-f0-9]*'
    ),
    created_at           TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    PRIMARY KEY (tenant_id, fact_id),
    UNIQUE (tenant_id, evidence_hash)
);

CREATE TABLE compensation_extrapolated_benchmark_facts (
    tenant_id                          TEXT NOT NULL DEFAULT 'local',
    fact_id                            TEXT NOT NULL CHECK (
        length(fact_id) = 36
        AND substr(fact_id, 9, 1) = '-'
        AND substr(fact_id, 14, 1) = '-'
        AND substr(fact_id, 19, 1) = '-'
        AND substr(fact_id, 24, 1) = '-'
        AND replace(fact_id, '-', '') NOT GLOB '*[^a-f0-9]*'
    ),
    anchor_direct_fact_id              TEXT NOT NULL,
    taxonomy_version                   TEXT NOT NULL,
    role_family_code                   TEXT NOT NULL,
    seniority_label                    TEXT NOT NULL CHECK (
        seniority_label IN (
            'entry', 'mid', 'senior', 'staff', 'principal',
            'manager', 'director', 'executive', 'unknown'
        )
    ),
    target_country_code                TEXT NOT NULL CHECK (
        length(target_country_code) = 2
        AND target_country_code = upper(target_country_code)
        AND target_country_code NOT GLOB '*[^A-Z]*'
    ),
    target_subdivision_code            TEXT NOT NULL DEFAULT '',
    target_locality                    TEXT NOT NULL DEFAULT '',
    target_geography_scope             TEXT NOT NULL CHECK (
        target_geography_scope IN ('country', 'country_subdivision', 'locality')
    ),
    component                          TEXT NOT NULL CHECK (
        component IN ('base_salary', 'total_compensation')
    ),
    currency                           TEXT NOT NULL CHECK (currency = 'EUR'),
    period                             TEXT NOT NULL CHECK (period = 'year'),
    minimum_amount                     INTEGER NOT NULL CHECK (minimum_amount > 0),
    maximum_amount                     INTEGER NOT NULL CHECK (maximum_amount >= minimum_amount),
    confidence_interval_minimum_amount INTEGER NOT NULL CHECK (
        confidence_interval_minimum_amount > 0
        AND confidence_interval_minimum_amount <= minimum_amount
    ),
    confidence_interval_maximum_amount INTEGER NOT NULL CHECK (
        confidence_interval_maximum_amount >= maximum_amount
    ),
    confidence_band                    TEXT NOT NULL CHECK (
        confidence_band IN ('low', 'medium')
    ),
    confidence_score                   REAL NOT NULL CHECK (
        confidence_score >= 0 AND confidence_score <= 1
    ),
    extrapolation_method               TEXT NOT NULL CHECK (
        extrapolation_method = 'evidence_weighted_shrinkage'
    ),
    raw_factor                         REAL NOT NULL CHECK (raw_factor > 0),
    shrinkage_weight                   REAL NOT NULL CHECK (
        shrinkage_weight >= 0 AND shrinkage_weight <= 1
    ),
    lower_factor_bound                 REAL NOT NULL CHECK (lower_factor_bound = 0.1),
    upper_factor_bound                 REAL NOT NULL CHECK (upper_factor_bound = 10.0),
    factor_bound_state                 TEXT NOT NULL CHECK (
        factor_bound_state IN ('within_bounds', 'below_lower_bound', 'above_upper_bound')
    ),
    matched_company_count              INTEGER NOT NULL DEFAULT 0 CHECK (matched_company_count >= 0),
    formula_version                    TEXT NOT NULL CHECK (length(trim(formula_version)) > 0),
    inputs_hash                        TEXT NOT NULL CHECK (
        length(inputs_hash) = 64
        AND inputs_hash NOT GLOB '*[^a-f0-9]*'
    ),
    warnings_json                      TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(warnings_json) AND json_type(warnings_json) = 'array'
    ),
    as_of_date                         TEXT NOT NULL CHECK (length(trim(as_of_date)) > 0),
    derived_at                         TEXT NOT NULL CHECK (length(trim(derived_at)) > 0),
    fresh_until                        TEXT NOT NULL CHECK (length(trim(fresh_until)) > 0),
    PRIMARY KEY (tenant_id, fact_id),
    UNIQUE (tenant_id, inputs_hash),
    FOREIGN KEY (tenant_id, anchor_direct_fact_id)
        REFERENCES compensation_direct_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (taxonomy_version, role_family_code)
        REFERENCES compensation_role_families(taxonomy_version, role_family_code)
        ON DELETE RESTRICT,
    CHECK (
        target_subdivision_code = '' OR length(trim(target_subdivision_code)) > 0
    ),
    CHECK (target_locality = '' OR length(trim(target_locality)) > 0),
    CHECK (
        (
            target_geography_scope = 'country'
            AND target_subdivision_code = ''
            AND target_locality = ''
        )
        OR (
            target_geography_scope = 'country_subdivision'
            AND target_subdivision_code != ''
            AND target_locality = ''
        )
        OR (target_geography_scope = 'locality' AND target_locality != '')
    ),
    CHECK (
        (raw_factor < lower_factor_bound AND factor_bound_state = 'below_lower_bound')
        OR (raw_factor > upper_factor_bound AND factor_bound_state = 'above_upper_bound')
        OR (
            raw_factor >= lower_factor_bound
            AND raw_factor <= upper_factor_bound
            AND factor_bound_state = 'within_bounds'
        )
    )
);

CREATE TABLE compensation_extrapolation_direct_inputs (
    tenant_id            TEXT NOT NULL DEFAULT 'local',
    extrapolated_fact_id TEXT NOT NULL,
    direct_fact_id       TEXT NOT NULL,
    input_role           TEXT NOT NULL CHECK (
        input_role IN (
            'anchor',
            'matched_company_source',
            'matched_company_target',
            'occupation_anchor'
        )
    ),
    weight               REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    PRIMARY KEY (tenant_id, extrapolated_fact_id, direct_fact_id, input_role),
    FOREIGN KEY (tenant_id, extrapolated_fact_id)
        REFERENCES compensation_extrapolated_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, direct_fact_id)
        REFERENCES compensation_direct_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT
);

CREATE TABLE compensation_extrapolation_price_inputs (
    tenant_id            TEXT NOT NULL DEFAULT 'local',
    extrapolated_fact_id TEXT NOT NULL,
    price_level_fact_id  TEXT NOT NULL,
    input_role           TEXT NOT NULL CHECK (
        input_role IN ('source_price_level', 'target_price_level', 'shrinkage_prior')
    ),
    weight               REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    PRIMARY KEY (tenant_id, extrapolated_fact_id, price_level_fact_id, input_role),
    FOREIGN KEY (tenant_id, extrapolated_fact_id)
        REFERENCES compensation_extrapolated_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, price_level_fact_id)
        REFERENCES compensation_price_level_facts(tenant_id, fact_id)
        ON DELETE RESTRICT
);

CREATE TABLE compensation_market_refresh_state (
    tenant_id                       TEXT NOT NULL DEFAULT 'local',
    taxonomy_version                TEXT NOT NULL,
    role_family_code                TEXT NOT NULL,
    seniority_label                 TEXT NOT NULL CHECK (
        seniority_label IN (
            'entry', 'mid', 'senior', 'staff', 'principal',
            'manager', 'director', 'executive', 'unknown'
        )
    ),
    country_code                    TEXT NOT NULL CHECK (
        length(country_code) = 2
        AND country_code = upper(country_code)
        AND country_code NOT GLOB '*[^A-Z]*'
    ),
    subdivision_code                TEXT NOT NULL DEFAULT '',
    locality                        TEXT NOT NULL DEFAULT '',
    geography_scope                 TEXT NOT NULL CHECK (
        geography_scope IN ('country', 'country_subdivision', 'locality')
    ),
    component                       TEXT NOT NULL CHECK (
        component IN ('base_salary', 'total_compensation')
    ),
    refresh_status                  TEXT NOT NULL CHECK (
        refresh_status IN (
            'missing', 'queued', 'refreshing', 'succeeded',
            'insufficient_evidence', 'failed'
        )
    ),
    last_result_kind                TEXT NOT NULL DEFAULT 'none' CHECK (
        last_result_kind IN ('none', 'direct', 'extrapolated')
    ),
    last_direct_fact_id             TEXT,
    last_extrapolated_fact_id       TEXT,
    last_requested_at               TEXT,
    last_checked_at                 TEXT,
    next_refresh_at                 TEXT,
    lease_owner                     TEXT,
    lease_expires_at                TEXT,
    attempt_count                   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code                 TEXT,
    updated_at                      TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    PRIMARY KEY (
        tenant_id,
        taxonomy_version,
        role_family_code,
        seniority_label,
        country_code,
        subdivision_code,
        locality,
        component
    ),
    FOREIGN KEY (taxonomy_version, role_family_code)
        REFERENCES compensation_role_families(taxonomy_version, role_family_code)
        ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, last_direct_fact_id)
        REFERENCES compensation_direct_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, last_extrapolated_fact_id)
        REFERENCES compensation_extrapolated_benchmark_facts(tenant_id, fact_id)
        ON DELETE RESTRICT,
    CHECK (subdivision_code = '' OR length(trim(subdivision_code)) > 0),
    CHECK (locality = '' OR length(trim(locality)) > 0),
    CHECK (
        (geography_scope = 'country' AND subdivision_code = '' AND locality = '')
        OR (
            geography_scope = 'country_subdivision'
            AND subdivision_code != ''
            AND locality = ''
        )
        OR (geography_scope = 'locality' AND locality != '')
    ),
    CHECK (
        (last_result_kind = 'none' AND last_direct_fact_id IS NULL AND last_extrapolated_fact_id IS NULL)
        OR (last_result_kind = 'direct' AND last_direct_fact_id IS NOT NULL)
        OR (last_result_kind = 'extrapolated' AND last_extrapolated_fact_id IS NOT NULL)
    ),
    CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX idx_compensation_direct_benchmark_lookup
    ON compensation_direct_benchmark_facts (
        tenant_id,
        taxonomy_version,
        role_family_code,
        seniority_label,
        country_code,
        subdivision_code,
        locality,
        component,
        fetched_at DESC
    );

CREATE INDEX idx_compensation_direct_benchmark_company
    ON compensation_direct_benchmark_facts (
        tenant_id,
        normalized_company,
        role_family_code,
        seniority_label,
        country_code
    );

CREATE INDEX idx_compensation_price_level_lookup
    ON compensation_price_level_facts (
        tenant_id,
        country_code,
        category,
        reference_year DESC,
        fetched_at DESC
    );

CREATE INDEX idx_compensation_extrapolated_benchmark_lookup
    ON compensation_extrapolated_benchmark_facts (
        tenant_id,
        taxonomy_version,
        role_family_code,
        seniority_label,
        target_country_code,
        target_subdivision_code,
        target_locality,
        component,
        derived_at DESC
    );

CREATE INDEX idx_compensation_market_refresh_due
    ON compensation_market_refresh_state (
        tenant_id,
        refresh_status,
        next_refresh_at,
        taxonomy_version,
        role_family_code,
        seniority_label,
        country_code
    );

CREATE TRIGGER prevent_compensation_role_family_collision
BEFORE INSERT ON compensation_role_families
WHEN EXISTS (
    SELECT 1
    FROM compensation_role_families
    WHERE taxonomy_version = NEW.taxonomy_version
      AND role_family_code = NEW.role_family_code
)
BEGIN
    SELECT RAISE(ABORT, 'compensation role families are append-only');
END;

CREATE TRIGGER prevent_compensation_role_family_update
BEFORE UPDATE ON compensation_role_families
BEGIN
    SELECT RAISE(ABORT, 'compensation role families are append-only');
END;

CREATE TRIGGER prevent_compensation_role_family_delete
BEFORE DELETE ON compensation_role_families
BEGIN
    SELECT RAISE(ABORT, 'compensation role families are append-only');
END;

CREATE TRIGGER prevent_compensation_direct_benchmark_collision
BEFORE INSERT ON compensation_direct_benchmark_facts
WHEN EXISTS (
    SELECT 1
    FROM compensation_direct_benchmark_facts
    WHERE tenant_id = NEW.tenant_id
      AND (fact_id = NEW.fact_id OR evidence_hash = NEW.evidence_hash)
)
BEGIN
    SELECT RAISE(ABORT, 'direct compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_direct_benchmark_update
BEFORE UPDATE ON compensation_direct_benchmark_facts
BEGIN
    SELECT RAISE(ABORT, 'direct compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_direct_benchmark_delete
BEFORE DELETE ON compensation_direct_benchmark_facts
BEGIN
    SELECT RAISE(ABORT, 'direct compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_price_level_collision
BEFORE INSERT ON compensation_price_level_facts
WHEN EXISTS (
    SELECT 1
    FROM compensation_price_level_facts
    WHERE tenant_id = NEW.tenant_id
      AND (fact_id = NEW.fact_id OR evidence_hash = NEW.evidence_hash)
)
BEGIN
    SELECT RAISE(ABORT, 'compensation price-level facts are append-only');
END;

CREATE TRIGGER prevent_compensation_price_level_update
BEFORE UPDATE ON compensation_price_level_facts
BEGIN
    SELECT RAISE(ABORT, 'compensation price-level facts are append-only');
END;

CREATE TRIGGER prevent_compensation_price_level_delete
BEFORE DELETE ON compensation_price_level_facts
BEGIN
    SELECT RAISE(ABORT, 'compensation price-level facts are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolated_benchmark_collision
BEFORE INSERT ON compensation_extrapolated_benchmark_facts
WHEN EXISTS (
    SELECT 1
    FROM compensation_extrapolated_benchmark_facts
    WHERE tenant_id = NEW.tenant_id
      AND (fact_id = NEW.fact_id OR inputs_hash = NEW.inputs_hash)
)
BEGIN
    SELECT RAISE(ABORT, 'extrapolated compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolated_benchmark_update
BEFORE UPDATE ON compensation_extrapolated_benchmark_facts
BEGIN
    SELECT RAISE(ABORT, 'extrapolated compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolated_benchmark_delete
BEFORE DELETE ON compensation_extrapolated_benchmark_facts
BEGIN
    SELECT RAISE(ABORT, 'extrapolated compensation benchmark facts are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_direct_input_collision
BEFORE INSERT ON compensation_extrapolation_direct_inputs
WHEN EXISTS (
    SELECT 1
    FROM compensation_extrapolation_direct_inputs
    WHERE tenant_id = NEW.tenant_id
      AND extrapolated_fact_id = NEW.extrapolated_fact_id
      AND direct_fact_id = NEW.direct_fact_id
      AND input_role = NEW.input_role
)
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation direct inputs are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_direct_input_update
BEFORE UPDATE ON compensation_extrapolation_direct_inputs
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation direct inputs are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_direct_input_delete
BEFORE DELETE ON compensation_extrapolation_direct_inputs
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation direct inputs are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_price_input_collision
BEFORE INSERT ON compensation_extrapolation_price_inputs
WHEN EXISTS (
    SELECT 1
    FROM compensation_extrapolation_price_inputs
    WHERE tenant_id = NEW.tenant_id
      AND extrapolated_fact_id = NEW.extrapolated_fact_id
      AND price_level_fact_id = NEW.price_level_fact_id
      AND input_role = NEW.input_role
)
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation price inputs are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_price_input_update
BEFORE UPDATE ON compensation_extrapolation_price_inputs
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation price inputs are append-only');
END;

CREATE TRIGGER prevent_compensation_extrapolation_price_input_delete
BEFORE DELETE ON compensation_extrapolation_price_inputs
BEGIN
    SELECT RAISE(ABORT, 'compensation extrapolation price inputs are append-only');
END;
