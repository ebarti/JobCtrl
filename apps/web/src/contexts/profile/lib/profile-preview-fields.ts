import { ProfileSchema } from "@jobctrl/contracts";

// Bind the baseline preview only. Generated application artifacts keep their
// existing presentation and never acquire hidden canonical profile values.
const text = (value: string): string => value.replace(/\s+/gu, " ").trim();
const renderedText = (value: string): string => text(value
  .replace(/ — |—/gu, ", ").replace(/–/gu, "-")
  .replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'"));

export function bindProfilePreviewFields(html: string, source: unknown): string {
  const parsed = ProfileSchema.safeParse(source);
  if (!parsed.success) return html;
  const profile = parsed.data;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const targets = new Map<string, Element[]>();
  for (const node of doc.querySelectorAll("[data-resume-layout-target]")) {
    const key = node.getAttribute("data-resume-layout-target")!;
    targets.set(key, [...(targets.get(key) ?? []), node]);
  }
  const owner = (id: string): Element | undefined => {
    const matches = targets.get(id);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const bind = (node: Element | null | undefined, id: string, value: string) => {
    if (!node) return;
    const display = node.textContent ?? "";
    const expected = value;
    const same = renderedText(display) === renderedText(expected) ||
      (id.endsWith(":date_range") && text(display) === text(expected.replace(/\s*(?:--|–|—)\s*/gu, " - ")));
    node.setAttribute("data-resume-profile-field", same ? id : `unmapped:${id}`);
    if (same) node.setAttribute("data-resume-profile-source", value);
  };
  const field = (id: string, value: string): Element => {
    const node = doc.createElement("span");
    node.textContent = renderedText(value);
    bind(node, id, value);
    return node;
  };
  const separator = (value: string): Element => {
    const node = doc.createElement("span");
    node.setAttribute("data-resume-profile-separator", "true");
    node.textContent = value;
    return node;
  };
  const join = (items: Element[], between: string): Node[] =>
    items.flatMap((item, index) => index ? [separator(between), item] : [item]);
  const replaceComposite = (node: Element | null | undefined, expected: string, parts: Node[], id: string) => {
    if (!node) return;
    if (text(node.textContent ?? "") !== renderedText(expected)) {
      node.setAttribute("data-resume-profile-field", `unmapped:${id}`);
      return;
    }
    node.replaceChildren(...parts);
  };

  bind(owner("personal:full_name"), "personal:full_name", profile.personal.full_name ?? "");
  bind(owner("summary"), "summary", profile.resume.executive_profile.baseline_text ?? "");
  const addressGroups = [
    { fields: ["address", "city"] as const, separator: ", " },
    { fields: ["postal_code", "country"] as const, separator: " " },
  ].map((group) => {
    const entries = group.fields.map((key) => ({ key, value: profile.personal[key] ?? "" })).filter(({ value }) => value.trim());
    return { text: entries.map(({ value }) => value).join(group.separator),
      nodes: join(entries.map(({ key, value }) => field(`personal:${key}`, value)), group.separator) };
  }).filter((group) => group.nodes.length);
  replaceComposite(owner("personal:address"), addressGroups.map((group) => group.text).join(" - "),
    addressGroups.flatMap((group, index) => index ? [separator(" - "), ...group.nodes] : group.nodes), "personal:address");
  const contact = owner("personal:contact");
  for (const key of ["email", "phone"] as const) {
    bind(contact?.querySelector(`.resume-contact-${key}`), `personal:${key}`, profile.personal[key] ?? "");
  }

  for (const entry of profile.resume.experience_entries) {
    const prefix = `experience:${entry.id}`;
    const heading = owner(`${prefix}:heading`);
    for (const [key, className] of [["company", "company"], ["location", "location"], ["title", "title"], ["date_range", "date"]] as const) {
      bind(heading?.querySelector(`.resume-entry-${className}`), `${prefix}:${key}`, entry[key]);
    }
    bind(owner(`${prefix}:summary`), `${prefix}:summary`, entry.summary);
    entry.bullets.forEach((bullet, index) => bind(owner(`${prefix}:bullet:${index + 1}`), `${prefix}:bullet:${index + 1}`, bullet));
  }
  for (const entry of profile.resume.education_entries) {
    const prefix = `education:${entry.id}`;
    const heading = owner(`${prefix}:subtitle`);
    const institution = [["institution", entry.institution], ["location", entry.location]] as const;
    const present = institution.filter(([, value]) => value.trim());
    replaceComposite(heading?.querySelector(".resume-entry-institution"), present.map(([, value]) => value).join(" | "),
      join(present.map(([key, value]) => field(`${prefix}:${key}`, value)), " | "), `${prefix}:institution`);
    bind(heading?.querySelector(".resume-entry-date"), `${prefix}:date`, entry.date);
    bind(owner(`${prefix}:degree`), `${prefix}:degree`, entry.degree);
    owner(`${prefix}:details`)?.setAttribute("data-resume-profile-field", `unmapped:${prefix}:details`);
  }
  for (const category of profile.resume.skill_categories) {
    const prefix = `skills:${category.id}`;
    const label = doc.createElement("b");
    label.append(field(`${prefix}:label`, category.label), separator(": "));
    replaceComposite(owner(prefix), `${category.label}: ${category.items.join(", ")}`,
      [label, ...join(category.items.map((item, index) => field(`${prefix}:item:${index + 1}`, item)), ", ")], prefix);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
