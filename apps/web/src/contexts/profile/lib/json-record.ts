import { isRecord } from "../../../shared/lib/type-guards.js";

export type JsonRecord = Record<string, unknown>;

export function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
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

export function defaultRepeatItem(path: string): JsonRecord {
  if (path === "resume.experience_entries") {
    return {
      id: "",
      date_range: "",
      title: "",
      company: "",
      location: "",
      summary: "",
      bullets: [""],
    };
  }
  if (path === "resume.education_entries") {
    return { id: "", date: "", degree: "", institution: "", location: "" };
  }
  if (path === "resume.skill_categories") {
    return { id: "", label: "", items: [""] };
  }
  return {};
}
