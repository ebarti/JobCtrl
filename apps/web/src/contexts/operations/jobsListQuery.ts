import type {
  JobListQuery,
  JobSortField,
  JobSummary,
  PaginatedResponse,
  Stage,
  StageState,
} from "@jobhunter/contracts";

import type { ApiClientPort } from "../../shared/ports/ApiClientPort.js";
import type { JobsListInput } from "./types.js";

const MAX_JOB_LIST_PAGE_SIZE = 200;
const DEFAULT_JOB_LIST_PAGE_SIZE = 50;
const DEFAULT_JOB_LIST_SORT: JobSortField = "discovered_at";
const DEFAULT_JOB_LIST_DIR = "desc" as const;

const STATE_RANK: Record<StageState, number> = {
  failed: 0,
  exhausted: 1,
  blocked: 2,
  running: 3,
  queued: 4,
  pending: 5,
  stale: 6,
  canceled: 7,
  skipped: 8,
  succeeded: 9,
};

type ConcreteJobsListInput = Partial<JobListQuery>;

export async function fetchJobsList(
  api: Pick<ApiClientPort, "jobs">,
  input: JobsListInput,
): Promise<PaginatedResponse<JobSummary>> {
  const stages = uniqueStages(input.stages ?? []);
  if (!stages.length) {
    return api.jobs(concreteJobsListInput(input));
  }
  if (stages.length === 1) {
    return api.jobs({ ...concreteJobsListInput(input), stage: stages[0] });
  }
  return fetchMultiStageJobsList(api, input, stages);
}

function uniqueStages(stages: readonly Stage[]): Stage[] {
  return Array.from(new Set(stages));
}

function concreteJobsListInput(input: JobsListInput): ConcreteJobsListInput {
  const { stages: _stages, ...query } = input;
  return query;
}

async function fetchMultiStageJobsList(
  api: Pick<ApiClientPort, "jobs">,
  input: JobsListInput,
  stages: readonly Stage[],
): Promise<PaginatedResponse<JobSummary>> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_JOB_LIST_PAGE_SIZE;
  const sort = input.sort ?? DEFAULT_JOB_LIST_SORT;
  const dir = input.dir ?? DEFAULT_JOB_LIST_DIR;
  const requestedItemCount = page * pageSize;
  const baseInput = concreteJobsListInput(input);
  const queryPage = (stage: Stage, nextPage: number) =>
    api.jobs({
      ...baseInput,
      stage,
      page: nextPage,
      pageSize: MAX_JOB_LIST_PAGE_SIZE,
    });

  const firstPages = await Promise.all(
    stages.map((stage) => queryPage(stage, 1)),
  );
  const remainingPages = await Promise.all(
    firstPages.flatMap((response, index) => {
      const pagesNeeded = Math.ceil(
        Math.min(response.pagination.total, requestedItemCount) /
          MAX_JOB_LIST_PAGE_SIZE,
      );
      return Array.from(
        { length: Math.max(0, pagesNeeded - 1) },
        (_item, offset) => queryPage(stages[index]!, offset + 2),
      );
    }),
  );
  const responses = [...firstPages, ...remainingPages];
  const total = firstPages.reduce(
    (sum, response) => sum + response.pagination.total,
    0,
  );
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * pageSize;
  const items = uniqueJobs(
    responses.flatMap((response) => response.items),
  ).sort((left, right) => compareJobs(left, right, sort, dir));

  return {
    ok: true,
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      pages,
    },
    sort: { field: sort, dir },
    filter: { ...(firstPages[0]?.filter ?? {}), stages },
  };
}

function uniqueJobs(items: readonly JobSummary[]): JobSummary[] {
  const seen = new Set<string>();
  const unique: JobSummary[] = [];
  for (const item of items) {
    if (seen.has(item.jobKey)) {
      continue;
    }
    seen.add(item.jobKey);
    unique.push(item);
  }
  return unique;
}

function compareJobs(
  left: JobSummary,
  right: JobSummary,
  field: JobSortField,
  direction: "asc" | "desc",
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const compared = compareValues(
    sortValue(left, field),
    sortValue(right, field),
  );
  return compared
    ? compared * multiplier
    : left.jobKey.localeCompare(right.jobKey);
}

function sortValue(job: JobSummary, field: JobSortField): unknown {
  switch (field) {
    case "title":
      return job.title.toLowerCase();
    case "company":
      return job.company.toLowerCase();
    case "source":
      return (job.postingSource || job.discoverySource || job.source || "").toLowerCase();
    case "compensation_posted":
      return postedCompensationSortValue(job);
    case "compensation_market":
      return marketCompensationSortValue(job);
    case "compensation_warnings":
      return job.compensationSummary?.warningCount ?? 0;
    case "location":
      return job.location.toLowerCase();
    case "fit_score":
      return job.fitScore ?? -1;
    case "current_stage":
      return job.currentStage;
    case "current_state":
      return `${STATE_RANK[job.currentState] ?? 999}:${job.currentSubstage}`;
    case "apply_status":
      return job.applyStatus ?? "";
    case "discovered_at":
    default:
      return job.discoveredAt;
  }
}

function postedCompensationSortValue(job: JobSummary): number {
  const summary = job.compensationSummary;
  const amount = summary?.posted.range?.annualizedMinimumAmount ?? summary?.posted.range?.minimumAmount;
  if (Number.isFinite(amount)) return Number(amount);
  if (summary?.posted.displayRange || summary?.legacyRawSalary || job.salary) return -1;
  if (summary?.posted.parseState === "ambiguous") return -2;
  if (summary?.posted.parseState === "unparseable") return -3;
  if (summary?.posted.parseState === "missing") return -4;
  return Number.NEGATIVE_INFINITY;
}

function marketCompensationSortValue(job: JobSummary): number {
  const market = job.compensationSummary?.market;
  const amount = market?.range?.annualizedMinimumAmount ?? market?.range?.minimumAmount;
  if (Number.isFinite(amount)) return Number(amount);
  switch (market?.estimateState) {
    case "estimated_range":
      return -1;
    case "insufficient_evidence":
      return -2;
    case "source_unavailable":
      return -3;
    case "unsupported":
      return -4;
    case "not_requested":
    default:
      return Number.NEGATIVE_INFINITY;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined || left === "") return -1;
  if (right === null || right === undefined || right === "") return 1;
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  return String(left).localeCompare(String(right));
}
