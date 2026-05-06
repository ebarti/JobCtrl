export function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatCompanySource(company: string, source: string): string {
  if (!source || source === "unknown" || source === company) {
    return company;
  }
  return `${company} · ${source}`;
}
