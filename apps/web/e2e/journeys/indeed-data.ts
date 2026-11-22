/** An authored listing page at the SDK's external Indeed GraphQL boundary. */
export function indeedPage<T extends { job_key: string; title: string; company?: string; description?: string; location?: string }>(
  page: { jobs: T[]; cursor: string | null; complete: boolean },
) {
  if (page.complete !== (page.cursor === null)) throw new Error("An unfinished page requires its continuation cursor.");
  return { data: { jobSearch: {
    results: page.jobs.map((row) => ({ job: {
      key: row.job_key, title: row.title, employer: { name: row.company },
      location: { city: row.location, countryCode: "ES" }, datePublished: Date.now(),
      description: { html: (row.description ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") },
    } })),
    pageInfo: { nextCursor: page.cursor },
  } } };
}
