// Pure comment placement and bounded, deterministic seed transformations.
import {
  type ResumePlateLine,
  type ResumeAuditPin,
  type ResumeCommentThreadPlacement,
  type RiskSignals,
  type ResumePlateComment,
} from "./resume-editor-types.js";
import {
  linePinId,
  primarySourceTextForPin,
  sourceLabelForJustification,
  pinStatus,
  pinTone,
} from "./resume-provenance.js";
import {
  type ResumeCommentThread,
  type ResumeReviewCommentThreadSeedInput,
} from "@jobctrl/contracts";

export function pinForPlateLine(
  line: ResumePlateLine,
  _index: number,
  pins: readonly ResumeAuditPin[],
): ResumeAuditPin | null {
  return pins.find((pin) => pin.id === linePinId(line)) ?? null;
}

export function placeResumeCommentThreads(
  lines: readonly ResumePlateLine[],
  pins: readonly ResumeAuditPin[],
  threads: readonly ResumeCommentThread[],
): ResumeCommentThreadPlacement {
  const lineIndexByNumber = new Map<number, number>();
  const lineIndexBySourcePinId = new Map<string, number>();
  const lineIndexBySemanticId = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    if (
      line.lineNumber !== undefined &&
      !lineIndexByNumber.has(line.lineNumber)
    ) {
      lineIndexByNumber.set(line.lineNumber, index);
    }
    if (line.semanticId && !lineIndexBySemanticId.has(line.semanticId)) {
      lineIndexBySemanticId.set(line.semanticId, index);
    }
    const pin = pinForPlateLine(line, index, pins);
    if (pin?.id && !lineIndexBySourcePinId.has(pin.id)) {
      lineIndexBySourcePinId.set(pin.id, index);
    }
    if (pin?.sourceId && !lineIndexBySemanticId.has(pin.sourceId)) {
      lineIndexBySemanticId.set(pin.sourceId, index);
    }
  }

  const mutableThreadsByLineIndex = new Map<number, ResumeCommentThread[]>();
  const unmatchedThreads: ResumeCommentThread[] = [];
  for (const thread of threads) {
    if (!thread.anchorResolved) {
      unmatchedThreads.push(thread);
      continue;
    }

    let lineIndex: number | undefined;
    const lineNumber = thread.lineAnchor?.lineNumber;
    if (lineNumber !== null && lineNumber !== undefined) {
      lineIndex = lineIndexByNumber.get(lineNumber);
    }
    if (lineIndex === undefined && thread.sourcePinId) {
      lineIndex = lineIndexBySourcePinId.get(thread.sourcePinId);
    }
    if (lineIndex === undefined) {
      const semanticIds = [
        thread.semanticId,
        thread.lineAnchor?.semanticId,
      ].filter((semanticId): semanticId is string => Boolean(semanticId));
      for (const semanticId of semanticIds) {
        lineIndex = lineIndexBySemanticId.get(semanticId);
        if (lineIndex !== undefined) break;
      }
    }

    if (lineIndex === undefined) {
      unmatchedThreads.push(thread);
      continue;
    }
    const lineThreads = mutableThreadsByLineIndex.get(lineIndex) ?? [];
    lineThreads.push(thread);
    mutableThreadsByLineIndex.set(lineIndex, lineThreads);
  }

  return {
    commentThreadsByLineIndex: mutableThreadsByLineIndex,
    unmatchedThreads,
  };
}

export function inlineCommentForPin(
  pin: ResumeAuditPin,
  risk: RiskSignals,
): ResumePlateComment {
  const signals = pin.matchedSignals.length
    ? `Signals reflected: ${pin.matchedSignals.join(", ")}.`
    : "";
  const sourceText = primarySourceTextForPin(pin)?.[0] ?? null;
  const why = [pin.rationale, signals].filter(Boolean).join(" ").trim() || null;
  return {
    sourceLabel:
      pin.sourceGranularity === "structure" ||
      pin.sourceGranularity === "missing"
        ? null
        : sourceLabelForJustification(pin),
    sourceText,
    status: pinStatus(pin, risk),
    tone: pinTone(pin, risk),
    why,
  };
}

export function seedThreadsFromPins(
  artifactId: string,
  pins: readonly ResumeAuditPin[],
  risk: RiskSignals,
): ResumeReviewCommentThreadSeedInput[] {
  return pins
    .map((pin): ResumeReviewCommentThreadSeedInput | null => {
      const comment = inlineCommentForPin(pin, risk);
      if (!comment.why && !comment.sourceText && comment.tone !== "warn")
        return null;
      const body = [
        comment.why,
        comment.sourceText
          ? `${comment.sourceLabel ?? "Source"}: ${comment.sourceText}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        baseArtifactId: boundedSeedIdentifier(artifactId, "artifact"),
        commentBody: boundedSeedText(body || comment.status, 4000),
        lineAnchor: {
          lineNumber: pin.lineNumber ?? null,
          pageNumber: 1,
          semanticId: boundedSeedIdentifier(pin.sourceId, "semantic"),
          textHash: null,
        },
        riskLabel: comment.status,
        semanticId: boundedSeedIdentifier(pin.sourceId, "semantic"),
        sourcePinId: boundedSeedIdentifier(pin.id, "pin"),
      };
    })
    .filter((thread): thread is ResumeReviewCommentThreadSeedInput =>
      Boolean(thread),
    );
}

function boundedSeedIdentifier(
  value: string | null | undefined,
  salt: string,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 240) return trimmed;
  const suffix = `${salt}:${stableTextHash(trimmed)}`;
  return `${trimmed.slice(0, 240 - suffix.length - 1).trimEnd()}:${suffix}`;
}

function boundedSeedText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const suffix = "\n[truncated]";
  return `${trimmed.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function seedThreadKey(
  thread: ResumeReviewCommentThreadSeedInput,
): string {
  return [
    thread.sourcePinId ?? "",
    thread.semanticId ?? "",
    thread.lineAnchor?.lineNumber ?? "",
    thread.riskLabel ?? "",
    thread.commentBody,
  ].join(":");
}
