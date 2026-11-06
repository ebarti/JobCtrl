"""Provider transport values; no JobCtrl aggregate or canonical storage types."""

from dataclasses import dataclass
from enum import Enum


class AtsKind(str, Enum):
    WORKDAY = "workday"
    GREENHOUSE = "greenhouse"
    LEVER = "lever"
    ASHBY = "ashby"


class SearchStrategy(str, Enum):
    WORKDAY_API = "workday_api"


@dataclass(frozen=True)
class Employer:
    name: str | None

    @classmethod
    def unknown(cls):
        return cls(None)


@dataclass(frozen=True)
class JobMetadata:
    title: str
    salary: str
    description: str
    location: str


@dataclass(frozen=True)
class PostingUrl:
    value: str


@dataclass(frozen=True)
class Source:
    board: str


@dataclass(frozen=True)
class ScrapedJobPosting:
    posting_url: PostingUrl
    source: Source
    employer: Employer
    metadata: JobMetadata
    strategy: SearchStrategy
    source_id: str
    source_native_id: str
    canonical_url: str
    ats_kind: AtsKind
