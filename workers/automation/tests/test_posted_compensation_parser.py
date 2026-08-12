from __future__ import annotations

from jobctrl.domain.compensation import SOURCE_TEXT_LIMIT, parse_posted_compensation


def test_missing_salary_returns_missing_state() -> None:
    fact = parse_posted_compensation(None, parsed_at="2026-06-19T10:00:00Z")

    assert fact.parse_state == "missing"
    assert fact.source_text is None
    assert fact.legacy_raw_salary is None
    assert fact.confidence == "none"
    assert fact.minimum_amount is None
    assert fact.annualized_minimum_amount is None


def test_unparseable_salary_preserves_raw_fallback_and_warning() -> None:
    fact = parse_posted_compensation("Competitive package", parsed_at="2026-06-19T10:00:00Z")

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
        parsed_at="2026-06-19T10:00:00Z",
    )

    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings
    assert "bonus_component" in fact.warnings


def test_two_amount_additive_bonus_without_base_label_is_ambiguous() -> None:
    fact = parse_posted_compensation("€70k/year + €10k bonus")

    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings


def test_parses_annual_range_with_currency_and_assumption() -> None:
    fact = parse_posted_compensation("€80k-€95k/year", parsed_at="2026-06-19T10:00:00Z")

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


def test_hr_prose_does_not_override_the_amount_local_annual_period() -> None:
    fact = parse_posted_compensation(
        (
            "anybody (even HR managers) is able to create new integrations. "
            "Base pay range: €94,300.00/yr - €106,950.00/yr"
        ),
        source_field="job_enrichments.full_description",
        parsed_at="2026-08-12T12:00:00Z",
    )

    assert fact.parse_state == "parsed_range"
    assert fact.period == "year"
    assert fact.minimum_amount == 94_300
    assert fact.maximum_amount == 106_950
    assert fact.annualized_minimum_amount == 94_300
    assert fact.annualized_maximum_amount == 106_950
    assert fact.annualization_assumption == "Source text states annual compensation."
    assert "hourly_period" not in fact.warnings


def test_amount_adjacent_bare_period_abbreviations_remain_supported() -> None:
    hourly = parse_posted_compensation("Base pay: $40 hrs")
    annual = parse_posted_compensation("Base salary: $100,000 yrs")
    hr_prose = parse_posted_compensation("HR managers benchmark base salary at $100,000 yr")

    assert hourly.period == "hour"
    assert hourly.annualized_minimum_amount == 83_200
    assert "hourly_period" in hourly.warnings

    assert annual.period == "year"
    assert annual.annualized_minimum_amount == 100_000

    assert hr_prose.period == "year"
    assert hr_prose.annualized_minimum_amount == 100_000
    assert "hourly_period" not in hr_prose.warnings


def test_hr_prose_after_an_amount_is_not_treated_as_a_bare_hour_suffix() -> None:
    for source in (
        "Compensation budget approved: $100,000\n\nHR managers will administer this program.",
        "Compensation budget approved: $100,000\n\nHR, benefits, and finance teams will administer this program.",
        "Compensation budget approved: $100,000\n\nHR: Managers will administer this program.",
    ):
        fact = parse_posted_compensation(source)

        assert fact.parse_state == "parsed_range"
        assert fact.period == "unknown"
        assert fact.annualized_minimum_amount is None
        assert fact.annualized_maximum_amount is None
        assert "missing_period" in fact.warnings
        assert "hourly_period" not in fact.warnings


def test_parenthesized_bare_period_abbreviations_remain_supported() -> None:
    hourly = parse_posted_compensation("Base pay: $40 hr (depending on experience)")
    annual = parse_posted_compensation("Base salary: $100,000 yr (base compensation)")

    assert hourly.period == "hour"
    assert hourly.annualized_minimum_amount == 83_200
    assert annual.period == "year"
    assert annual.annualized_minimum_amount == 100_000


def test_parses_monthly_and_hourly_values_with_explicit_assumptions() -> None:
    monthly = parse_posted_compensation("EUR 6,000/month", parsed_at="2026-06-19T10:00:00Z")
    hourly = parse_posted_compensation("€40/hour", parsed_at="2026-06-19T10:00:00Z")

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
    one_sided = parse_posted_compensation("Up to €110,000/year")
    broad = parse_posted_compensation("€40,000 - €140,000/year")

    assert one_sided.minimum_amount is None
    assert one_sided.maximum_amount == 110_000
    assert "one_sided_range" in one_sided.warnings

    assert broad.minimum_amount == 40_000
    assert broad.maximum_amount == 140_000
    assert "broad_range" in broad.warnings


def test_missing_currency_and_missing_period_do_not_annualize() -> None:
    fact = parse_posted_compensation("80k-95k")

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
    bonus = parse_posted_compensation("Base €90k/year plus bonus")
    commission = parse_posted_compensation("€70k/year plus commission")
    equity = parse_posted_compensation("€100k/year plus equity")
    ote = parse_posted_compensation("€120k OTE/year")

    assert "bonus_component" in bonus.warnings
    assert "commission_component" in commission.warnings
    assert "equity_component" in equity.warnings
    assert ote.component == "ote"
    assert "ote_component" in ote.warnings


def test_single_base_amount_with_variable_component_keeps_base_component() -> None:
    bonus = parse_posted_compensation("Base €90k/year plus bonus")
    commission = parse_posted_compensation("€70k/year salary plus commission")
    equity = parse_posted_compensation("Salary €100k/year plus equity")

    for fact in (bonus, commission, equity):
        assert fact.parse_state == "parsed_range"
        assert fact.component == "base_salary"
        assert fact.minimum_amount is not None

    assert "bonus_component" in bonus.warnings
    assert "commission_component" in commission.warnings
    assert "equity_component" in equity.warnings


def test_stated_cash_compensation_is_not_relabelled_as_separate_stock_options() -> None:
    fact = parse_posted_compensation(
        (
            "Compensation is transparent across the organization. "
            "Compensation: USD 243,800 annually and stock options. "
            + ("Privacy leadership across the global region. " * 8)
        ),
        source_field="jobs.full_description",
        parsed_at="2026-08-12T10:00:00Z",
    )

    assert fact.parse_state == "parsed_range"
    assert fact.currency == "USD"
    assert fact.period == "year"
    assert fact.minimum_amount == 243_800
    assert fact.maximum_amount == 243_800
    assert fact.component == "unknown"
    assert fact.confidence == "high"
    assert "equity_component" in fact.warnings
    assert "source_text_truncated" in fact.warnings


def test_explicit_equity_compensation_remains_equity() -> None:
    fact = parse_posted_compensation("Equity compensation: USD 100,000/year in stock options.")

    assert fact.component == "equity"
    assert fact.confidence == "high"


def test_nearest_amount_cue_keeps_explicit_equity_distinct_from_earlier_salary() -> None:
    fact = parse_posted_compensation(
        "The position offers a competitive base salary. Equity compensation: USD 100,000/year in stock options."
    )

    assert fact.parse_state == "parsed_range"
    assert fact.minimum_amount == 100_000
    assert fact.component == "equity"
    assert fact.confidence == "high"


def test_amount_denomination_in_stock_options_is_equity() -> None:
    fact = parse_posted_compensation("USD 100,000/year in stock options.")

    assert fact.parse_state == "parsed_range"
    assert fact.component == "equity"


def test_nearer_generic_compensation_cue_keeps_additive_stock_separate() -> None:
    fact = parse_posted_compensation("Compensation: USD 243,800 annually and stock options.")

    assert fact.parse_state == "parsed_range"
    assert fact.component == "unknown"


def test_equity_denomination_overrides_generic_compensation_cue() -> None:
    stock = parse_posted_compensation("Compensation: USD 100,000/year in stock options.")
    equity = parse_posted_compensation("Compensation: USD 100,000/year as equity.")

    assert stock.component == "equity"
    assert equity.component == "equity"


def test_additive_equity_remains_separate_despite_later_stock_denomination() -> None:
    fact = parse_posted_compensation("Compensation: USD 243,800/year and equity in stock options.")

    assert fact.parse_state == "parsed_range"
    assert fact.component == "unknown"


def test_source_text_is_bounded_and_hashed() -> None:
    raw = "€80,000/year " + ("with benefits " * 80)
    fact = parse_posted_compensation(raw)

    assert fact.source_text is not None
    assert len(fact.source_text) <= SOURCE_TEXT_LIMIT
    assert "source_text_truncated" in fact.warnings
    assert len(fact.source_hash) == 64
