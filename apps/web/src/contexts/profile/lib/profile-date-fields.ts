export interface ProfileMonthValue {
  month: string;
  year: string;
}

export interface ProfileDateRangeValue {
  start: ProfileMonthValue;
  end: ProfileMonthValue;
  present: boolean;
}

export const PROFILE_MONTHS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Jan", value: "01" },
  { label: "Feb", value: "02" },
  { label: "Mar", value: "03" },
  { label: "Apr", value: "04" },
  { label: "May", value: "05" },
  { label: "Jun", value: "06" },
  { label: "Jul", value: "07" },
  { label: "Aug", value: "08" },
  { label: "Sep", value: "09" },
  { label: "Oct", value: "10" },
  { label: "Nov", value: "11" },
  { label: "Dec", value: "12" },
];

const MONTH_NAME_ENTRIES: Array<[string, string]> = [
  ["january", "01"],
  ["jan", "01"],
  ["february", "02"],
  ["feb", "02"],
  ["march", "03"],
  ["mar", "03"],
  ["april", "04"],
  ["apr", "04"],
  ["may", "05"],
  ["june", "06"],
  ["jun", "06"],
  ["july", "07"],
  ["jul", "07"],
  ["august", "08"],
  ["aug", "08"],
  ["september", "09"],
  ["sept", "09"],
  ["sep", "09"],
  ["october", "10"],
  ["oct", "10"],
  ["november", "11"],
  ["nov", "11"],
  ["december", "12"],
  ["dec", "12"],
];

const MONTH_BY_NAME = new Map<string, string>(MONTH_NAME_ENTRIES);

const MONTH_LABEL_BY_VALUE = new Map(PROFILE_MONTHS.map(({ label, value }) => [value, label]));

export function profileYearOptions(
  startYear = 1980,
  endYear = new Date().getFullYear() + 1,
): string[] {
  const options: string[] = [];
  for (let year = endYear; year >= startYear; year -= 1) {
    options.push(String(year));
  }
  return options;
}

export function emptyProfileMonth(): ProfileMonthValue {
  return { month: "", year: "" };
}

export function parseProfileMonth(value: string): ProfileMonthValue {
  const trimmed = value.trim();
  if (!trimmed || /^(present|current)$/i.test(trimmed)) {
    return emptyProfileMonth();
  }

  const iso = /^(\d{4})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    return { year: iso[1] ?? "", month: normalizeMonthNumber(iso[2] ?? "") };
  }

  const nameYear = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(trimmed);
  if (nameYear) {
    return {
      month: MONTH_BY_NAME.get((nameYear[1] ?? "").toLowerCase()) ?? "",
      year: nameYear[2] ?? "",
    };
  }

  const yearName = /^(\d{4})\s+([A-Za-z]+)\.?$/.exec(trimmed);
  if (yearName) {
    return {
      month: MONTH_BY_NAME.get((yearName[2] ?? "").toLowerCase()) ?? "",
      year: yearName[1] ?? "",
    };
  }

  const yearOnly = /^(\d{4})$/.exec(trimmed);
  if (yearOnly) {
    return { month: "", year: yearOnly[1] ?? "" };
  }

  return emptyProfileMonth();
}

export function formatProfileMonth(value: ProfileMonthValue): string {
  if (!value.year) {
    return "";
  }
  if (!value.month) {
    return value.year;
  }
  return `${MONTH_LABEL_BY_VALUE.get(value.month) ?? value.month} ${value.year}`;
}

export function parseProfileDateRange(value: string): ProfileDateRangeValue {
  const trimmed = value.trim();
  if (!trimmed) {
    return { start: emptyProfileMonth(), end: emptyProfileMonth(), present: false };
  }

  const spacedSingleDashRange = /^(.+?)\s+-\s+(.+)$/.exec(trimmed);
  const spacedRange = spacedSingleDashRange ?? /^(.+?)\s*(?:--|–|—)\s*(.+)$/.exec(trimmed);
  const compactYearRange = /^(\d{4})-(\d{4}|present|current)$/i.exec(trimmed);
  const startText = spacedRange?.[1] ?? compactYearRange?.[1] ?? trimmed;
  const endText = spacedRange?.[2] ?? compactYearRange?.[2] ?? "";
  const present = /^(present|current)$/i.test(endText.trim());

  return {
    start: parseProfileMonth(startText),
    end: present ? emptyProfileMonth() : parseProfileMonth(endText),
    present,
  };
}

export function formatProfileDateRange(value: ProfileDateRangeValue): string {
  const start = formatProfileMonth(value.start);
  const end = value.present ? "Present" : formatProfileMonth(value.end);

  if (start && end) {
    return `${start} - ${end}`;
  }
  return start || end;
}

export function isProfileDateRangeChronological(value: ProfileDateRangeValue): boolean {
  if (value.present || !value.start.year || !value.end.year) {
    return true;
  }
  const startYear = Number(value.start.year);
  const endYear = Number(value.end.year);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    return true;
  }
  if (endYear !== startYear) {
    return endYear > startYear;
  }
  if (!value.start.month || !value.end.month) {
    return true;
  }
  const startMonth = Number(value.start.month);
  const endMonth = Number(value.end.month);
  if (!Number.isInteger(startMonth) || !Number.isInteger(endMonth)) {
    return true;
  }
  return endMonth >= startMonth;
}

function normalizeMonthNumber(value: string): string {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 12) {
    return "";
  }
  return String(numeric).padStart(2, "0");
}
