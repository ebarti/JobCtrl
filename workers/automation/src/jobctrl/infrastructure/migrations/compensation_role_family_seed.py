"""Versioned JobCtrl compensation role-family taxonomy seed."""

from __future__ import annotations

import json
import sqlite3

from jobctrl.domain.compensation.benchmarks import ROLE_FAMILY_TAXONOMY_VERSION

_CREATED_AT = "2026-08-11T00:00:00Z"
_ROLE_FAMILIES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("software_engineering", "Software Engineering", ("2512", "2513", "2514", "2519")),
    ("infrastructure_platform", "Infrastructure & Platform", ("2522", "2523", "2529")),
    ("data_ai", "Data & AI", ("2120", "2511", "2521")),
    ("security_privacy", "Security & Privacy", ("2529",)),
    ("product_management", "Product Management", ("2421",)),
    ("design_research", "Design & Research", ("2166", "2431")),
    ("sales_business_development", "Sales & Business Development", ("1221", "2433", "2434")),
    ("marketing_communications", "Marketing & Communications", ("1222", "2431", "2432")),
    ("customer_success_support", "Customer Success & Support", ("3322", "4222")),
    ("finance_accounting", "Finance & Accounting", ("1211", "2411", "2412", "2413")),
    ("people_talent", "People & Talent", ("1212", "2423", "2424")),
    ("legal_compliance", "Legal & Compliance", ("1213", "2611", "2619")),
    ("business_operations", "Business Operations", ("1219", "2421", "2422")),
    ("general_management", "General Management", ("1120",)),
)


def seed_compensation_role_families(conn: sqlite3.Connection) -> None:
    """Insert the immutable first JobCtrl taxonomy into an empty v8 catalog."""

    conn.executemany(
        """
        INSERT INTO compensation_role_families (
            taxonomy_version, role_family_code, display_name, isco_codes_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        tuple(
            (
                ROLE_FAMILY_TAXONOMY_VERSION,
                code,
                display_name,
                json.dumps(isco_codes, separators=(",", ":")),
                _CREATED_AT,
            )
            for code, display_name, isco_codes in _ROLE_FAMILIES
        ),
    )


__all__ = ["ROLE_FAMILY_TAXONOMY_VERSION", "seed_compensation_role_families"]
