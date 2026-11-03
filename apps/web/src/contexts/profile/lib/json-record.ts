import { isRecord } from "../../../shared/lib/type-guards.js";

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
}

/** Compare JSON data without treating object key order as meaningful. */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export function getPathValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    const key = /^\d+$/.test(segment) ? Number(segment) : segment;
    return (current as Record<string | number, unknown>)[key];
  }, source);
}

export function setPathValue(source: JsonRecord, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string | number, unknown> = source;
  segments.forEach((segment, index) => {
    const key = /^\d+$/.test(segment) ? Number(segment) : segment;
    if (index === segments.length - 1) {
      current[key] = value;
      return;
    }
    const nextSegment = segments[index + 1] ?? "";
    const nextIsArray = /^\d+$/.test(nextSegment);
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = nextIsArray ? [] : {};
    }
    current = current[key] as Record<string | number, unknown>;
  });
}

export function textAt(source: unknown, path: string): string {
  return textFrom(getPathValue(source, path));
}

export function textFrom(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

export function textArrayAt(source: unknown, path: string): string[] {
  return asTextArray(getPathValue(source, path));
}

export function editableTextArrayAt(source: unknown, path: string): string[] {
  const value = getPathValue(source, path);
  return Array.isArray(value) ? value.map(textFrom) : [];
}

export function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(textFrom).filter((item) => item.length > 0) : [];
}

export function recordAt(source: unknown, path: string): JsonRecord {
  const value = getPathValue(source, path);
  return isJsonRecord(value) ? value : {};
}

export function recordArrayAt(source: unknown, path: string): JsonRecord[] {
  const value = getPathValue(source, path);
  return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

export function numberOrEmpty(value: string): number | string {
  return value.trim() ? Number(value) : "";
}

export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function defaultRepeatItem(path: string, existingIds: Iterable<string> = []): JsonRecord {
  const prefix = path === "resume.experience_entries" ? "experience"
    : path === "resume.education_entries" ? "education"
      : path === "resume.skill_categories" ? "skill" : null;
  if (prefix === null) {
    return {};
  }
  const occupied = new Set(existingIds);
  let sequence = 1;
  while (occupied.has(`${prefix}-${sequence}`)) {
    sequence += 1;
  }
  const id = `${prefix}-${sequence}`;
  if (path === "resume.experience_entries") {
    return {
      id,
      date_range: "",
      title: "",
      company: "",
      location: "",
      summary: "",
      bullets: [""],
    };
  }
  if (path === "resume.education_entries") {
    return { id, date: "", degree: "", institution: "", location: "" };
  }
  if (path === "resume.skill_categories") {
    return { id, label: "", items: [""] };
  }
  return {};
}
