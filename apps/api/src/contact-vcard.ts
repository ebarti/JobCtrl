import type {
  ContactImportIssue,
  ContactImportPreviewAttribute,
  ContactRole,
} from "./contracts.js";

export interface ParsedContactImportItem {
  displayName: string;
  employer: string | null;
  role: ContactRole;
  attributes: ContactImportPreviewAttribute[];
  issues: ContactImportIssue[];
}

const SUPPORTED_PROPERTIES = new Set([
  "BEGIN",
  "END",
  "VERSION",
  "FN",
  "N",
  "ORG",
  "EMAIL",
  "TEL",
  "URL",
  "NOTE",
  "TITLE",
]);
const IGNORED_PARAMETERS = new Set(["TYPE", "PREF", "ALTID", "PID", "LANGUAGE"]);
const ATTRIBUTE_LIMIT = 50;
const CARD_LIMIT = 1_000;
const LINE_LIMIT = 16_384;

interface VCardProperty {
  name: string;
  value: string;
  parameters: Map<string, string>;
}

interface CardLines {
  lines: string[];
  structuralIssues: ContactImportIssue[];
}

export function parseVCardContacts(content: string): ParsedContactImportItem[] {
  const physicalLines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of physicalLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  const cards: CardLines[] = [];
  let current: CardLines | null = null;
  let outsideContent = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^BEGIN:VCARD$/i.test(line)) {
      if (current) {
        current.structuralIssues.push(errorIssue("nested_vcard", "A vCard began before the previous card ended."));
        cards.push(current);
      }
      current = { lines: [], structuralIssues: [] };
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (!current) {
        outsideContent = true;
        continue;
      }
      cards.push(current);
      current = null;
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      outsideContent = true;
    }
  }
  if (current) {
    current.structuralIssues.push(errorIssue("unterminated_vcard", "The vCard is missing END:VCARD."));
    cards.push(current);
  }
  if (outsideContent) {
    cards.unshift({
      lines: [],
      structuralIssues: [errorIssue("content_outside_vcard", "Content was found outside a BEGIN:VCARD and END:VCARD block.")],
    });
  }
  if (cards.length === 0) {
    cards.push({
      lines: [],
      structuralIssues: [errorIssue("missing_vcard", "No vCard block was found.")],
    });
  }
  if (cards.length > CARD_LIMIT) {
    return [
      {
        displayName: "",
        employer: null,
        role: "other",
        attributes: [],
        issues: [errorIssue("too_many_vcards", `At most ${CARD_LIMIT} vCards can be imported at once.`)],
      },
    ];
  }
  return cards.map(parseCard);
}

function parseCard(card: CardLines): ParsedContactImportItem {
  const issues = [...card.structuralIssues];
  const properties: VCardProperty[] = [];
  for (const line of card.lines) {
    if (line.length > LINE_LIMIT) {
      issues.push(errorIssue("line_too_long", `A vCard line exceeds ${LINE_LIMIT} characters.`));
      continue;
    }
    const colon = firstUnquotedColon(line);
    if (colon <= 0) {
      issues.push(errorIssue("malformed_property", "A vCard property is missing its name or ':' separator."));
      continue;
    }
    const headerParts = line.slice(0, colon).split(";");
    const groupedName = (headerParts.shift() ?? "").trim();
    const name = (groupedName.split(".").at(-1) ?? "").toUpperCase();
    if (!name) {
      issues.push(errorIssue("malformed_property", "A vCard property has an empty name."));
      continue;
    }
    if (!SUPPORTED_PROPERTIES.has(name)) {
      issues.push(warningIssue("unsupported_property", `${name} is not imported.`, name));
      continue;
    }
    const parameters = new Map<string, string>();
    for (const part of headerParts) {
      const separator = part.indexOf("=");
      const parameterName = (separator >= 0 ? part.slice(0, separator) : "TYPE").trim().toUpperCase();
      const parameterValue = (separator >= 0 ? part.slice(separator + 1) : part).trim();
      parameters.set(parameterName, parameterValue);
      if (parameterName === "ENCODING") {
        issues.push(errorIssue("unsupported_encoding", `${name} uses unsupported ${parameterValue || "encoded"} content.`, name));
      } else if (parameterName === "CHARSET" && parameterValue.toUpperCase().replace(/[-_]/g, "") !== "UTF8") {
        issues.push(errorIssue("unsupported_charset", `${name} uses unsupported charset ${parameterValue}.`, name));
      } else if (IGNORED_PARAMETERS.has(parameterName)) {
        issues.push(warningIssue("ignored_parameter", `${name} parameter ${parameterName} does not change the imported fact.`, name));
      } else if (parameterName !== "CHARSET" && parameterName !== "VALUE") {
        issues.push(warningIssue("unsupported_parameter", `${name} parameter ${parameterName} was ignored.`, name));
      }
    }
    const property = { name, value: line.slice(colon + 1), parameters };
    const declaredValue = parameters.get("VALUE")?.replace(/^"|"$/g, "").toLowerCase();
    if (declaredValue && !supportsDeclaredValue(name, declaredValue)) {
      issues.push(errorIssue("unsupported_value_type", `${name} cannot be imported with VALUE=${declaredValue}.`, name));
    }
    properties.push(property);
  }

  const versions = properties.filter((property) => property.name === "VERSION").map((property) => property.value.trim());
  if (versions.length !== 1 || (versions[0] !== "3.0" && versions[0] !== "4.0")) {
    issues.push(errorIssue("unsupported_version", "Each card must declare exactly one VERSION:3.0 or VERSION:4.0.", "VERSION"));
  }

  const attributes: ContactImportPreviewAttribute[] = [];
  const seenFacts = new Set<string>();
  const addDecodedAttribute = (kind: ContactImportPreviewAttribute["kind"], decodedValue: string) => {
    const value = decodedValue.trim();
    if (!value) return;
    if (value.length > 2_000) {
      issues.push(errorIssue("value_too_long", `${kind} exceeds 2000 characters.`, kind.toUpperCase()));
      return;
    }
    const key = `${kind}\u0000${value}`;
    if (!seenFacts.has(key)) {
      seenFacts.add(key);
      attributes.push({ kind, value });
    }
  };
  const addTextAttribute = (kind: ContactImportPreviewAttribute["kind"], rawValue: string) =>
    addDecodedAttribute(kind, unescapeText(rawValue));

  const fn = firstValue(properties, "FN");
  const structuredName = firstValue(properties, "N");
  const displayName = fn ? unescapeText(fn).trim() : composeStructuredName(structuredName ?? "");
  if (displayName) addDecodedAttribute("name", displayName);

  const org = firstValue(properties, "ORG");
  const employer = org ? unescapeText(splitEscaped(org, ";")[0] ?? "").trim() || null : null;
  if (!employer) {
    issues.push(errorIssue("missing_employer", "ORG is required to link an imported contact to an employer.", "ORG"));
  } else if (employer.length > 200) {
    issues.push(errorIssue("employer_too_long", "ORG's employer component exceeds 200 characters.", "ORG"));
  }
  for (const property of properties) {
    switch (property.name) {
      case "EMAIL":
        if (!isSafeEmail(unescapeText(property.value))) {
          issues.push(errorIssue("invalid_email", "EMAIL must contain a valid email address.", "EMAIL"));
        } else {
          addTextAttribute("email", property.value);
        }
        break;
      case "TEL":
        if (property.parameters.get("VALUE")?.toLowerCase() === "uri" && !/^tel:/i.test(property.value)) {
          issues.push(errorIssue(
            "unsupported_tel_uri",
            "TEL URI values must use an unqualified tel: URI.",
            "TEL",
          ));
        } else if (/^tel:/i.test(property.value) && /[;?]/.test(property.value)) {
          issues.push(errorIssue(
            "unsupported_qualified_tel_uri",
            "Qualified TEL URIs with phone-context or extension are not imported because their identity cannot be reduced safely.",
            "TEL",
          ));
        } else {
          const phone = /^tel:/i.test(property.value) ? property.value.slice(4) : property.value;
          if (!isSafePlainPhone(phone)) {
            issues.push(errorIssue(
              "unsupported_phone_value",
              "TEL must contain only an optional leading plus, digits, spaces, parentheses, dots, or hyphens.",
              "TEL",
            ));
          } else {
            addDecodedAttribute("phone", phone);
          }
        }
        break;
      case "URL":
        addDecodedAttribute("profile_url", property.value);
        break;
      case "NOTE":
        addTextAttribute("note", property.value);
        break;
      case "TITLE":
        addTextAttribute("title", property.value);
        break;
      default:
        break;
    }
  }
  if (attributes.length > ATTRIBUTE_LIMIT) {
    issues.push(errorIssue("too_many_facts", `A contact can contain at most ${ATTRIBUTE_LIMIT} imported facts.`));
  }
  return {
    displayName,
    employer,
    role: "other",
    attributes: attributes.slice(0, ATTRIBUTE_LIMIT),
    issues,
  };
}

function supportsDeclaredValue(name: string, value: string): boolean {
  if (name === "TEL") return value === "text" || value === "uri";
  if (name === "URL") return value === "uri";
  return value === "text";
}

function isSafePlainPhone(value: string): boolean {
  return /^\+?[0-9(). -]+$/.test(value.trim()) && value.replace(/[^0-9]/g, "").length >= 7;
}

function isSafeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function firstValue(properties: VCardProperty[], name: string): string | undefined {
  return properties.find((property) => property.name === name)?.value;
}

function composeStructuredName(raw: string): string {
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitEscaped(raw, ";").map(unescapeText);
  return [prefix, given, additional, family, suffix].map((part) => part.trim()).filter(Boolean).join(" ");
}

function splitEscaped(value: string, separator: string): string[] {
  const result: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === separator) {
      result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  result.push(current);
  return result;
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, escaped: string) => {
    if (escaped === "n" || escaped === "N") return "\n";
    return escaped;
  });
}

function firstUnquotedColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ":" && !quoted) return index;
  }
  return -1;
}

function errorIssue(code: string, message: string, property: string | null = null): ContactImportIssue {
  return { code, message, severity: "error", property };
}

function warningIssue(code: string, message: string, property: string | null = null): ContactImportIssue {
  return { code, message, severity: "warning", property };
}
