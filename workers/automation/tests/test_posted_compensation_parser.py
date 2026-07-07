from __future__ import annotations

from jobctrl.domain.compensation import SOURCE_TEXT_LIMIT, parse_posted_compensation


def test_missing_salary_returns_missing_state() -> None:
    fact = parse_posted_compensation(None, job_url="job-1", parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "missing"
    assert fact.source_text is None
    assert fact.legacy_raw_salary is None
    assert fact.confidence == "none"
    assert fact.minimum_amount is None
    assert fact.annualized_minimum_amount is None


def test_unparseable_salary_preserves_raw_fallback_and_warning() -> None:
    fact = parse_posted_compensation("Competitive package", job_url="job-1", parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "unparseable"
    assert fact.source_text == "Competitive package"
    assert fact.legacy_raw_salary == "Competitive package"
    assert "no_amount_found" in fact.warnings
    assert fact.minimum_amount is None


def test_company_metric_amounts_are_not_posted_compensation() -> None:
    fact = parse_posted_compensation(
        (
            "Through our subsidiaries, Moniepoint Inc. processes over $250 billion "
            "in digital payment transaction value annually. More than 6 million "
            "businesses run their financial lives through Moniepoint."
        ),
        job_url="job-1",
        source_field="jobs.full_description",
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "unparseable"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert fact.annualized_maximum_amount is None
    assert "no_amount_found" in fact.warnings


def test_small_benefit_counts_are_not_salary_amounts() -> None:
    fact = parse_posted_compensation(
        "Strong base salary and competitive pay. Spend up to 30 days per year working remotely.",
        job_url="job-1",
        source_field="jobs.full_description",
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "unparseable"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert fact.annualized_maximum_amount is None
    assert "no_amount_found" in fact.warnings


def test_ambiguous_salary_when_multiple_components_compete() -> None:
    fact = parse_posted_compensation(
        "€70k base, €30k bonus, €100k OTE",
        job_url="job-1",
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings
    assert "bonus_component" in fact.warnings
    assert "ote_component" in fact.warnings


def test_two_amount_mixed_component_salary_is_ambiguous_not_range() -> None:
    fact = parse_posted_compensation(
        "Base €90k/year plus bonus €10k/year",
        job_url="job-1",
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings
    assert "bonus_component" in fact.warnings


def test_two_amount_additive_bonus_without_base_label_is_ambiguous() -> None:
    fact = parse_posted_compensation("€70k/year + €10k bonus", job_url="job-1")

    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings


def test_parses_annual_range_with_currency_and_assumption() -> None:
    fact = parse_posted_compensation("€80k-€95k/year", job_url="job-1", parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "parsed_range"
    assert fact.currency == "EUR"
    assert fact.period == "year"
    assert fact.component == "unknown"
    assert fact.minimum_amount == 80_000
    assert fact.maximum_amount == 95_000
    assert fact.annualized_minimum_amount == 80_000
    assert fact.annualized_maximum_amount == 95_000
    assert fact.annualization_assumption == "Source text states annual compensation."
    assert fact.confidence == "high"
    assert fact.warnings == ()


def test_parses_monthly_and_hourly_values_with_explicit_assumptions() -> None:
    monthly = parse_posted_compensation("EUR 6,000/month", job_url="job-1", parsed_at="2026-06-19T10:00:00Z")
    hourly = parse_posted_compensation("€40/hour", job_url="job-2", parsed_at="2026-06-19T10:00:00Z")

    assert monthly.period == "month"
    assert monthly.annualized_minimum_amount == 72_000
    assert monthly.annualization_assumption == "Monthly amounts annualized by multiplying by 12."
    assert "monthly_period" in monthly.warnings

    assert hourly.period == "hour"
    assert hourly.annualized_minimum_amount == 83_200
    assert hourly.annualization_assumption == "Hourly amounts annualized by multiplying by 2,080 work hours."
    assert "hourly_period" in hourly.warnings
    assert hourly.confidence == "low"


def test_truncated_mo_fragment_does_not_make_salary_monthly() -> None:
    fact = parse_posted_compensation(
        (
            "For this role, depending on your level and location, we offer a "
            "salary up to $190,900, plus a generous equity package. We offer "
            "26 weeks of parental leave for mo"
        ),
        job_url="job-1",
        source_field="jobs.full_description",
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "parsed_range"
    assert fact.period == "unknown"
    assert fact.maximum_amount == 190_900
    assert fact.annualized_minimum_amount is None
    assert fact.annualized_maximum_amount is None
    assert "missing_period" in fact.warnings


def test_one_sided_and_broad_ranges_are_warned() -> None:
    one_sided = parse_posted_compensation("Up to €110,000/year", job_url="job-1")
    broad = parse_posted_compensation("€40,000 - €140,000/year", job_url="job-2")

    assert one_sided.minimum_amount is None
    assert one_sided.maximum_amount == 110_000
    assert "one_sided_range" in one_sided.warnings

    assert broad.minimum_amount == 40_000
    assert broad.maximum_amount == 140_000
    assert "broad_range" in broad.warnings


def test_missing_currency_and_missing_period_do_not_annualize() -> None:
    fact = parse_posted_compensation("80k-95k", job_url="job-1")

    assert fact.parse_state == "parsed_range"
    assert fact.currency is None
    assert fact.period == "unknown"
    assert fact.minimum_amount == 80_000
    assert fact.maximum_amount == 95_000
    assert fact.annualized_minimum_amount is None
    assert fact.annualization_assumption is None
    assert {"missing_currency", "missing_period"}.issubset(set(fact.warnings))
    assert fact.confidence == "low"


def test_bonus_commission_equity_and_ote_warnings_are_visible() -> None:
    bonus = parse_posted_compensation("Base €90k/year plus bonus", job_url="bonus")
    commission = parse_posted_compensation("€70k/year plus commission", job_url="commission")
    equity = parse_posted_compensation("€100k/year plus equity", job_url="equity")
    ote = parse_posted_compensation("€120k OTE/year", job_url="ote")

    assert "bonus_component" in bonus.warnings
    assert "commission_component" in commission.warnings
    assert "equity_component" in equity.warnings
    assert ote.component == "ote"
    assert "ote_component" in ote.warnings


def test_single_base_amount_with_variable_component_keeps_base_component() -> None:
    bonus = parse_posted_compensation("Base €90k/year plus bonus", job_url="bonus")
    commission = parse_posted_compensation("€70k/year salary plus commission", job_url="commission")
    equity = parse_posted_compensation("Salary €100k/year plus equity", job_url="equity")

    for fact in (bonus, commission, equity):
        assert fact.parse_state == "parsed_range"
        assert fact.component == "base_salary"
        assert fact.minimum_amount is not None

    assert "bonus_component" in bonus.warnings
    assert "commission_component" in commission.warnings
    assert "equity_component" in equity.warnings


def test_source_text_is_bounded_and_hashed() -> None:
    raw = "€80,000/year " + ("with benefits " * 80)
    fact = parse_posted_compensation(raw, job_url="job-1")

    assert fact.source_text is not None
    assert len(fact.source_text) <= SOURCE_TEXT_LIMIT
    assert "source_text_truncated" in fact.warnings
    assert len(fact.source_hash) == 64
