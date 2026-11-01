"""Generated code types. Edit the Contracts taxonomy and run its sync script."""

from typing import Literal

TrackCode = Literal["ic", "management", "executive", "unknown"]
SeniorityCode = Literal[
    "junior",
    "mid",
    "senior",
    "staff",
    "principal",
    "manager",
    "senior_manager",
    "director",
    "vp",
    "svp",
    "c_level",
    "unknown",
]
OccupationFamilyCode = Literal[
    "software_engineering",
    "engineering_management",
    "executive_leadership",
    "data_science",
    "data_engineering",
    "machine_learning",
    "information_technology",
    "product_management",
    "product_design",
    "sales",
    "marketing",
    "finance",
    "human_resources",
    "operations",
    "other",
    "unknown",
]
WorkModelCode = Literal["remote", "hybrid", "onsite", "unknown"]
RegionCode = Literal["africa", "asia", "europe", "north_america", "south_america", "oceania", "global", "unknown"]
