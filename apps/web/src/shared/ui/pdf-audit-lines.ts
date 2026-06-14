export interface PdfAuditLineTarget {
  lineNumber: number;
  text: string;
}

export interface RenderedPdfLine {
  heightPct: number;
  leftPct: number;
  resumeLineNumber: number | null;
  resumeLineText: string | null;
  text: string;
  topPct: number;
  widthPct: number;
}

interface PdfGeometryAdapter {
  readonly Util: {
    transform: (viewportTransform: readonly number[], itemTransform: readonly number[]) => readonly number[];
  };
}

interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width?: number;
}

interface PdfViewport {
  readonly height: number;
  readonly transform: readonly number[];
  readonly width: number;
}

interface PdfLineRow {
  baseline: number;
  bottom: number;
  left: number;
  parts: string[];
  right: number;
  top: number;
}

interface MatchedLineWindow {
  rows: readonly PdfLineRow[];
  target: PdfAuditLineTarget | null;
  text: string;
}

const MAX_PDF_ROWS_PER_RESUME_LINE = 5;
const PDF_RENDER_SCALE = 1.45;
const MATCH_STOP_WORDS = new Set(["and", "the", "for", "with", "from", "that", "into", "while", "over"]);

export function pdfTextLines(
  pdfjs: PdfGeometryAdapter,
  items: readonly unknown[],
  viewport: PdfViewport,
  targets: readonly PdfAuditLineTarget[],
): RenderedPdfLine[] {
  const rows: PdfLineRow[] = [];
  for (const item of items) {
    if (!isPdfTextItem(item) || !item.str.trim()) {
      continue;
    }
    const transform = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(4, Math.abs(transform[3] ?? 0));
    const left = transform[4] ?? 0;
    const baseline = transform[5] ?? 0;
    const width = Math.max(2, Math.abs((item.width ?? 0) * PDF_RENDER_SCALE));
    const top = baseline - fontHeight;
    const bottom = baseline + fontHeight * 0.22;
    const row = rows.find((candidate) => Math.abs(candidate.baseline - baseline) <= 4);
    if (row) {
      row.baseline = (row.baseline + baseline) / 2;
      row.left = Math.min(row.left, left);
      row.right = Math.max(row.right, left + width);
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
      row.parts.push(item.str.trim());
    } else {
      rows.push({
        baseline,
        bottom,
        left,
        parts: [item.str.trim()],
        right: left + width,
        top,
      });
    }
  }

  return lineWindowsFromRows(rows.sort((a, b) => a.top - b.top || a.left - b.left), targets)
    .map((lineWindow) => renderedLineFromWindow(lineWindow, viewport))
    .filter((line) => line.text.length > 0);
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object") return false;
  const item = value as { str?: unknown; transform?: unknown };
  return typeof item.str === "string" && Array.isArray(item.transform) && item.transform.length >= 6;
}

function lineWindowsFromRows(
  rows: readonly PdfLineRow[],
  targets: readonly PdfAuditLineTarget[],
): MatchedLineWindow[] {
  const windows: MatchedLineWindow[] = [];
  let rowIndex = 0;
  while (rowIndex < rows.length) {
    const lineWindow = bestLineWindowAt(rows, rowIndex, targets);
    windows.push(lineWindow);
    rowIndex += lineWindow.rows.length;
  }
  return windows;
}

function bestLineWindowAt(
  rows: readonly PdfLineRow[],
  startIndex: number,
  targets: readonly PdfAuditLineTarget[],
): MatchedLineWindow {
  const firstRow = rows[startIndex];
  if (!firstRow) {
    return { rows: [], target: null, text: "" };
  }
  const firstRowMatch = bestLineTargetWithScore(rowText(firstRow), targets, "partial");
  if (firstRowMatch) {
    const groupedRows = [firstRow];
    let nextIndex = startIndex + 1;
    while (nextIndex < rows.length && groupedRows.length < MAX_PDF_ROWS_PER_RESUME_LINE) {
      const nextRow = rows[nextIndex];
      if (!nextRow) break;
      const nextMatch = bestLineTargetWithScore(rowText(nextRow), targets, "partial");
      if (nextMatch?.target.lineNumber === firstRowMatch.target.lineNumber) {
        groupedRows.push(nextRow);
        nextIndex += 1;
        continue;
      }
      if (nextMatch) {
        break;
      }
      if (!canAttachContinuationRow(groupedRows, nextRow, firstRowMatch.target)) {
        break;
      }
      groupedRows.push(nextRow);
      nextIndex += 1;
    }
    return {
      rows: groupedRows,
      target: firstRowMatch.target,
      text: rowGroupText(groupedRows),
    };
  }

  let best: { score: number; span: number; target: PdfAuditLineTarget; text: string } | null = null;
  const maxSpan = Math.min(MAX_PDF_ROWS_PER_RESUME_LINE, rows.length - startIndex);
  for (let span = 1; span <= maxSpan; span += 1) {
    const candidateRows = rows.slice(startIndex, startIndex + span);
    const text = rowGroupText(candidateRows);
    const match = bestLineTargetWithScore(text, targets, "strict");
    if (!match) continue;
    if (span > 1 && (!canUseMultiRowFallbackTarget(match.target) || !canStartMultiRowFallback(firstRow, match.target))) continue;
    if (
      !best ||
      match.score > best.score ||
      (match.score === best.score && match.target.lineNumber === best.target.lineNumber && span > best.span)
    ) {
      best = { score: match.score, span, target: match.target, text };
    }
  }
  if (!best) {
    return { rows: [firstRow], target: null, text: rowText(firstRow) };
  }
  return {
    rows: rows.slice(startIndex, startIndex + best.span),
    target: best.target,
    text: best.text,
  };
}

function canUseMultiRowFallbackTarget(target: PdfAuditLineTarget): boolean {
  return target.text.length >= 100 && !looksLikeSingleLineStructureTarget(target.text);
}

function canStartMultiRowFallback(firstRow: PdfLineRow, target: PdfAuditLineTarget): boolean {
  const text = rowText(firstRow);
  if (looksLikeStandalonePdfStructureRow(text)) return false;
  return rowLooksLikeTargetContinuation(text, target.text);
}

function canAttachContinuationRow(
  groupedRows: readonly PdfLineRow[],
  nextRow: PdfLineRow,
  target: PdfAuditLineTarget,
): boolean {
  if (target.text.length < 100) return false;
  if (looksLikeSingleLineStructureTarget(target.text)) return false;
  const firstRow = groupedRows[0];
  const lastRow = groupedRows[groupedRows.length - 1];
  if (!firstRow || !lastRow) return false;
  const verticalGap = nextRow.top - lastRow.bottom;
  const leftDelta = Math.abs(nextRow.left - firstRow.left);
  return (
    verticalGap >= -2 &&
    verticalGap <= 18 &&
    leftDelta <= 80 &&
    rowLooksLikeTargetContinuation(rowText(nextRow), target.text)
  );
}

function looksLikeSingleLineStructureTarget(value: string): boolean {
  return /(@|https?:\/\/|\+\d|\s\|\s)/i.test(value);
}

function looksLikeStandalonePdfStructureRow(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^(education|experience|skills|executive profile)$/.test(normalized) ||
    /^\d+\/\d+$/.test(normalized) ||
    hasDateRange(value)
  );
}

function looksLikeCompactMatchTarget(value: string): boolean {
  return value.length <= 90 || looksLikeSingleLineStructureTarget(value) || hasDateRange(value);
}

function hasDateRange(value: string): boolean {
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b.*\b(?:19|20)\d{2}\b/i.test(value);
}

function rowLooksLikeTargetContinuation(rowValue: string, targetValue: string): boolean {
  const row = normalizeLineForMatch(rowValue);
  const target = normalizeLineForMatch(targetValue);
  if (!row || !target) return false;
  if (row.length >= 12 && target.includes(row)) return true;
  const rowTokens = meaningfulTokens(row);
  const targetTokens = meaningfulTokens(target);
  if (!rowTokens.length || !targetTokens.length) return false;
  const targetSet = new Set(targetTokens);
  const intersection = rowTokens.filter((token) => targetSet.has(token)).length;
  return intersection >= Math.min(3, rowTokens.length) && intersection / rowTokens.length >= 0.3;
}

function renderedLineFromWindow(lineWindow: MatchedLineWindow, viewport: PdfViewport): RenderedPdfLine {
  const horizontalPadding = Math.max(8, viewport.width * 0.015);
  const verticalPadding = Math.max(2, viewport.height * 0.0015);
  const left = Math.max(0, Math.min(...lineWindow.rows.map((row) => row.left)) - horizontalPadding);
  const top = Math.max(0, Math.min(...lineWindow.rows.map((row) => row.top)) - verticalPadding);
  const right = Math.min(viewport.width, Math.max(...lineWindow.rows.map((row) => row.right)) + horizontalPadding);
  const bottom = Math.min(viewport.height, Math.max(...lineWindow.rows.map((row) => row.bottom)) + verticalPadding);
  return {
    heightPct: Math.max(0.8, ((bottom - top) / viewport.height) * 100),
    leftPct: (left / viewport.width) * 100,
    resumeLineNumber: lineWindow.target?.lineNumber ?? null,
    resumeLineText: lineWindow.target?.text ?? null,
    text: lineWindow.text,
    topPct: (top / viewport.height) * 100,
    widthPct: Math.max(8, ((right - left) / viewport.width) * 100),
  };
}

function rowGroupText(rows: readonly PdfLineRow[]): string {
  return rows.map(rowText).join(" ").replace(/\s+/g, " ").trim();
}

function rowText(row: PdfLineRow): string {
  return row.parts.join(" ").replace(/\s+/g, " ").trim();
}

function bestLineTargetWithScore(
  text: string,
  targets: readonly PdfAuditLineTarget[],
  mode: "partial" | "strict",
): { score: number; target: PdfAuditLineTarget } | null {
  let best: { score: number; target: PdfAuditLineTarget } | null = null;
  for (const target of targets) {
    const score = lineMatchScore(text, target.text, mode);
    if (!best || score > best.score) {
      best = { score, target };
    }
  }
  return best && best.score >= 38 ? best : null;
}

function lineMatchScore(pdfText: string, resumeText: string, mode: "partial" | "strict"): number {
  const pdf = normalizeLineForMatch(pdfText);
  const resume = normalizeLineForMatch(resumeText);
  if (!pdf || !resume) return 0;
  if (pdf === resume) return 100;
  const shorter = pdf.length < resume.length ? pdf : resume;
  const longer = pdf.length < resume.length ? resume : pdf;
  if (shorter.length >= 12 && longer.includes(shorter)) {
    const coverage = shorter.length / longer.length;
    const targetIsContainedInLargerPdfRow = resume.length <= pdf.length && coverage < 0.45;
    if ((mode === "strict" && coverage < 0.45) || targetIsContainedInLargerPdfRow) {
      return Math.round(coverage * 70);
    }
    return 85 + Math.min(10, Math.round(coverage * 10));
  }
  if (resume.length <= 24 && pdf.length > resume.length * 2) {
    return 0;
  }
  const pdfTokens = new Set(meaningfulTokens(pdf));
  const resumeTokens = new Set(meaningfulTokens(resume));
  if (!pdfTokens.size || !resumeTokens.size) return 0;
  const intersection = [...pdfTokens].filter((token) => resumeTokens.has(token)).length;
  const smallerSize = Math.min(pdfTokens.size, resumeTokens.size);
  const resumeCoverage = intersection / resumeTokens.size;
  const compactTarget = looksLikeCompactMatchTarget(resumeText);
  if ((compactTarget || pdfTokens.size <= 3) && resumeCoverage < 0.55) {
    return 0;
  }
  if (!compactTarget && resumeCoverage < 0.22 && intersection < 4) {
    return 0;
  }
  return Math.round((intersection / smallerSize) * 70);
}

function meaningfulTokens(value: string): string[] {
  return value
    .split(" ")
    .filter((token) => token.length > 2 && !MATCH_STOP_WORDS.has(token));
}

function normalizeLineForMatch(value: string): string {
  return value
    .replace(/^[-•○]\s+/, "")
    .replace(/[^\p{L}\p{N}%+]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
