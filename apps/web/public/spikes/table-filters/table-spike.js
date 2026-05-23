const rowDataByTable = new Map();
const stateByTable = new Map();
const SOURCE_ENDPOINT = "/v1/discovery/sources";

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readCellValue(row, key) {
  return row.dataset[key] ?? row.querySelector(`[data-value-for="${key}"]`)?.textContent ?? "";
}

function collectRows(table) {
  const tbody = table.querySelector("tbody");
  const rows = Array.from(tbody.querySelectorAll("tr"));
  rowDataByTable.set(table.id, rows);
  if (!stateByTable.has(table.id)) {
    stateByTable.set(table.id, { sortKey: null, sortDir: "asc" });
  }
}

function getFilterControls(tableId) {
  return Array.from(document.querySelectorAll(`[data-table-id="${tableId}"][data-filter-key]`));
}

function getOperator(tableId, key) {
  const active = document.querySelector(
    `[data-table-id="${tableId}"][data-op-for="${key}"].is-active`,
  );
  return active?.dataset.operator ?? "contains";
}

function rowPassesFilters(row, tableId) {
  const controls = getFilterControls(tableId);
  const textControls = controls.filter((control) => control.dataset.filterType === "text");
  const checkboxControls = controls.filter((control) => control.type === "checkbox");
  const enumKeys = new Set(checkboxControls.map((control) => control.dataset.filterKey));

  for (const control of textControls) {
    const key = control.dataset.filterKey;
    const query = normalize(control.value);
    if (!query) continue;
    const value = normalize(readCellValue(row, key));
    const operator = getOperator(tableId, key);
    if (operator === "does_not_contain" && value.includes(query)) return false;
    if (operator !== "does_not_contain" && !value.includes(query)) return false;
  }

  for (const key of enumKeys) {
    const selected = checkboxControls
      .filter((control) => control.dataset.filterKey === key && control.checked)
      .map((control) => normalize(control.value));
    if (selected.length === 0) continue;
    const value = normalize(readCellValue(row, key));
    if (!selected.includes(value)) return false;
  }

  return true;
}

function compareValues(a, b) {
  const numberA = Number(a);
  const numberB = Number(b);
  if (!Number.isNaN(numberA) && !Number.isNaN(numberB) && a !== "" && b !== "") {
    return numberA - numberB;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function renderTable(table) {
  const tableId = table.id;
  const tbody = table.querySelector("tbody");
  const state = stateByTable.get(tableId);
  const originalRows = rowDataByTable.get(tableId) ?? [];
  let rows = originalRows.filter((row) => rowPassesFilters(row, tableId));

  if (state?.sortKey) {
    rows = [...rows].sort((rowA, rowB) => {
      const result = compareValues(
        readCellValue(rowA, state.sortKey),
        readCellValue(rowB, state.sortKey),
      );
      return state.sortDir === "desc" ? result * -1 : result;
    });
  }

  tbody.replaceChildren(...rows);
  originalRows.forEach((row) => {
    if (!rows.includes(row)) row.remove();
  });

  document.querySelectorAll(`[data-row-count-for="${tableId}"]`).forEach((node) => {
    node.textContent = `${rows.length} shown / ${originalRows.length} loaded`;
  });

  table.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.classList.toggle("is-asc", state?.sortKey === button.dataset.sortKey && state.sortDir === "asc");
    button.classList.toggle("is-desc", state?.sortKey === button.dataset.sortKey && state.sortDir === "desc");
  });
}

function titleCaseSourceName(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceCompanyName(source) {
  const rawName = String(source.displayName ?? "").trim();
  const rawSourceId = String(source.sourceId ?? "").split(":").at(1) ?? source.sourceId;
  if (rawName && !rawName.includes(".") && !rawName.includes("-")) return rawName;

  const candidate = rawName || rawSourceId;
  const withoutKnownHost = candidate
    .replace(/\.wd\d+\.myworkdayjobs\.com$/i, "")
    .replace(/\.myworkdayjobs\.com$/i, "")
    .replace(/\.greenhouse\.io$/i, "")
    .replace(/\.lever\.co$/i, "")
    .replace(/\.ashbyhq\.com$/i, "")
    .replace(/-wd\d+-myworkdayjobs-com$/i, "")
    .replace(/-myworkdayjobs-com$/i, "")
    .replace(/-greenhouse-io$/i, "")
    .replace(/-lever-co$/i, "")
    .replace(/-ashbyhq-com$/i, "");

  return titleCaseSourceName(withoutKnownHost || rawName || rawSourceId);
}

function sourceProviderLabel(source) {
  const sourceId = String(source.sourceId ?? "").toLowerCase();
  const policyId = String(source.policyId ?? "").toLowerCase();
  if (sourceId.startsWith("workday:") || policyId.includes("workday")) return "Workday ATS";
  if (sourceId.startsWith("greenhouse:") || policyId.includes("greenhouse")) return "Greenhouse ATS";
  if (sourceId.startsWith("lever:") || policyId.includes("lever")) return "Lever ATS";
  if (sourceId.startsWith("ashby:") || policyId.includes("ashby")) return "Ashby ATS";
  if (sourceId.startsWith("jobspy:")) return "JobSpy board";
  if (sourceId.startsWith("smart_extract:")) return "Smart extract";
  if (source.kind === "ats_api") return "ATS API";
  if (source.kind === "employer_careers_page") return "Employer careers page";
  if (source.kind === "official_api") return "Official API";
  if (source.kind === "licensed_feed") return "Licensed feed";
  if (source.kind === "niche_board") return "Niche board";
  if (source.kind === "broad_board") return "Broad board";
  return "Manual capture";
}

function displayKind(kind) {
  return String(kind ?? "").replaceAll("_", " ") || "unknown";
}

function sourceHostHint(source) {
  const name = String(source.displayName ?? "").trim();
  if (name && (name.includes(".") || name.includes("-"))) return name;
  return String(source.policyId ?? source.sourceId ?? "");
}

function compactDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" });
}

function chipTone(value) {
  if (value === "canonical" || value === "ats api" || value === "active") return "green";
  if (value === "fallback" || value === "smart extract") return "amber";
  if (value === "jobspy board" || value === "job board") return "blue";
  if (value === "blocked" || value === "failed") return "red";
  return "";
}

function createCell(content) {
  const cell = document.createElement("td");
  if (content instanceof Node) {
    cell.append(content);
  } else {
    cell.textContent = String(content ?? "");
  }
  return cell;
}

function createChip(value) {
  const chip = document.createElement("span");
  const tone = chipTone(String(value).toLowerCase());
  chip.className = `mini-chip${tone ? ` ${tone}` : ""}`;
  chip.textContent = value;
  return chip;
}

function buildSourceRow(source) {
  const row = document.createElement("tr");
  const company = sourceCompanyName(source);
  const provider = sourceProviderLabel(source);
  const kind = displayKind(source.kind);
  const lastRun = compactDate(source.lastRunCompletedAt);

  row.dataset.company = company;
  row.dataset.sourceId = source.sourceId;
  row.dataset.provider = provider;
  row.dataset.kind = kind;
  row.dataset.state = source.state;
  row.dataset.priority = source.priority;
  row.dataset.observed = String(source.observedJobs ?? 0);
  row.dataset.failures = String(source.consecutiveFailures ?? 0);
  row.dataset.lastRun = source.lastRunCompletedAt ?? "";

  const companyCell = document.createElement("span");
  companyCell.className = "company-cell";
  const companyName = document.createElement("strong");
  companyName.textContent = company;
  const hostHint = document.createElement("span");
  hostHint.className = "subtle";
  hostHint.textContent = sourceHostHint(source);
  companyCell.append(companyName, hostHint);

  const state = document.createElement("span");
  state.className = "state-dot";
  state.textContent = source.state;

  row.append(
    createCell(companyCell),
    createCell(source.sourceId),
    createCell(provider),
    createCell(createChip(kind)),
    createCell(state),
  );

  if (document.querySelector(`#${CSS.escape(row.closest?.("table")?.id ?? "")}`)) {
    return row;
  }

  row.append(
    createCell(createChip(source.priority)),
    createCell(source.observedJobs ?? 0),
    createCell(source.consecutiveFailures ?? 0),
    createCell(lastRun),
  );

  return row;
}

function buildRowForTable(source, table) {
  const row = document.createElement("tr");

  const company = sourceCompanyName(source);
  const provider = sourceProviderLabel(source);
  const kind = displayKind(source.kind);
  const lastRun = compactDate(source.lastRunCompletedAt);

  row.dataset.company = company;
  row.dataset.sourceId = source.sourceId;
  row.dataset.provider = provider;
  row.dataset.kind = kind;
  row.dataset.state = source.state;
  row.dataset.priority = source.priority;
  row.dataset.observed = String(source.observedJobs ?? 0);
  row.dataset.failures = String(source.consecutiveFailures ?? 0);
  row.dataset.lastRun = source.lastRunCompletedAt ?? "";

  const companyCell = document.createElement("span");
  companyCell.className = "company-cell";
  const companyName = document.createElement("strong");
  companyName.textContent = company;
  const hostHint = document.createElement("span");
  hostHint.className = "subtle";
  hostHint.textContent = sourceHostHint(source);
  companyCell.append(companyName, hostHint);

  const state = document.createElement("span");
  state.className = "state-dot";
  state.textContent = source.state;

  const cells = {
    company: companyCell,
    sourceId: source.sourceId,
    provider,
    kind: createChip(kind),
    state,
    priority: createChip(source.priority),
    observed: source.observedJobs ?? 0,
    failures: source.consecutiveFailures ?? 0,
    lastRun,
  };

  const columns = Array.from(table.querySelectorAll("thead [data-sort-key]")).map(
    (button) => button.dataset.sortKey,
  );
  columns.forEach((column) => row.append(createCell(cells[column] ?? "")));
  return row;
}

async function loadLiveSources(tables) {
  const statusNodes = document.querySelectorAll("[data-source-status]");
  statusNodes.forEach((node) => {
    node.textContent = "Loading live sources...";
  });

  try {
    const response = await fetch(SOURCE_ENDPOINT, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    if (!sources.length) throw new Error("No sources returned");

    tables.forEach((table) => {
      const tbody = table.querySelector("tbody");
      tbody.replaceChildren(...sources.map((source) => buildRowForTable(source, table)));
      collectRows(table);
      populateOptionLists(table);
      wireFilters(table);
      renderTable(table);
    });

    statusNodes.forEach((node) => {
      node.textContent = `${sources.length} live sources from ${SOURCE_ENDPOINT}`;
    });
  } catch (error) {
    statusNodes.forEach((node) => {
      node.textContent = `Using fallback rows: ${error.message}`;
    });
  }
}

function wireSortButtons(table) {
  const state = stateByTable.get(table.id);
  table.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      renderTable(table);
    });
  });
}

function wireFilters(table) {
  getFilterControls(table.id).forEach((control) => {
    if (control.dataset.wired === "true") return;
    control.dataset.wired = "true";
    control.addEventListener("input", () => renderTable(table));
    control.addEventListener("change", () => renderTable(table));
  });

  document.querySelectorAll(`[data-table-id="${table.id}"][data-op-for]`).forEach((button) => {
    if (button.dataset.wired === "true") return;
    button.dataset.wired = "true";
    button.addEventListener("click", () => {
      const group = button.dataset.opFor;
      document
        .querySelectorAll(`[data-table-id="${table.id}"][data-op-for="${group}"]`)
        .forEach((peer) => peer.classList.remove("is-active"));
      button.classList.add("is-active");
      renderTable(table);
    });
  });
}

function humanizeFilterKey(key) {
  return (
    {
      company: "Company",
      sourceId: "Source id",
      provider: "Provider",
      kind: "Kind",
      state: "State",
      priority: "Priority",
    }[key] ?? titleCaseSourceName(key)
  );
}

function hydrateDualFilters() {
  document.querySelectorAll("[data-dual-filter-for][data-table-id]").forEach((container) => {
    if (container.dataset.hydrated === "true") return;
    container.dataset.hydrated = "true";
    container.classList.add("dual-filter");

    const key = container.dataset.dualFilterFor;
    const tableId = container.dataset.tableId;
    const label = container.dataset.label ?? humanizeFilterKey(key);

    const textLabel = document.createElement("span");
    textLabel.className = "table-filter-label";
    textLabel.textContent = `${label} text`;

    const operatorGroup = document.createElement("div");
    operatorGroup.className = "mini-segmented";

    const contains = document.createElement("button");
    contains.className = "segment is-active";
    contains.dataset.tableId = tableId;
    contains.dataset.opFor = key;
    contains.dataset.operator = "contains";
    contains.type = "button";
    contains.textContent = "contains";

    const doesNotContain = document.createElement("button");
    doesNotContain.className = "segment";
    doesNotContain.dataset.tableId = tableId;
    doesNotContain.dataset.opFor = key;
    doesNotContain.dataset.operator = "does_not_contain";
    doesNotContain.type = "button";
    doesNotContain.textContent = "does not contain";

    operatorGroup.append(contains, doesNotContain);

    const input = document.createElement("input");
    input.className = "text-input";
    input.dataset.filterKey = key;
    input.dataset.filterType = "text";
    input.dataset.tableId = tableId;
    input.placeholder = `${label} text`;
    input.type = "text";
    if (container.dataset.defaultText) input.value = container.dataset.defaultText;

    const valuesWrap = document.createElement("div");
    valuesWrap.className = "dual-filter-values";

    const valuesLabel = document.createElement("span");
    valuesLabel.className = "table-filter-label";
    valuesLabel.textContent = `${label} values`;

    const values = document.createElement("div");
    values.className = "check-list";
    values.dataset.tableId = tableId;
    values.dataset.optionListFor = key;
    if (container.dataset.optionLimit) values.dataset.optionLimit = container.dataset.optionLimit;

    valuesWrap.append(valuesLabel, values);
    container.append(textLabel, operatorGroup, input, valuesWrap);
  });
}

function populateOptionLists(table) {
  const rows = rowDataByTable.get(table.id) ?? [];
  document
    .querySelectorAll(`[data-table-id="${table.id}"][data-option-list-for]`)
    .forEach((container) => {
      const key = container.dataset.optionListFor;
      const limit = Number(container.dataset.optionLimit ?? 80);
      const values = Array.from(
        new Set(rows.map((row) => readCellValue(row, key)).filter((value) => value !== "")),
      ).sort((a, b) => compareValues(a, b));

      container.replaceChildren();
      values.slice(0, limit).forEach((value) => {
        const label = document.createElement("label");
        label.className = "check-row";

        const checkbox = document.createElement("input");
        checkbox.dataset.filterKey = key;
        checkbox.dataset.tableId = table.id;
        checkbox.type = "checkbox";
        checkbox.value = value;

        label.append(checkbox, document.createTextNode(` ${value}`));
        container.append(label);
      });

      if (values.length > limit) {
        const overflow = document.createElement("span");
        overflow.className = "subtle";
        overflow.textContent = `${values.length - limit} more values. Use text contains to narrow.`;
        container.append(overflow);
      }
    });
}

const tables = Array.from(document.querySelectorAll("[data-spike-table]"));

hydrateDualFilters();
tables.forEach((table) => {
  collectRows(table);
  populateOptionLists(table);
  wireSortButtons(table);
  wireFilters(table);
  renderTable(table);
});

if (tables.length) {
  loadLiveSources(tables);
}
