// Read-side joins use persisted IDs only; missing source records remain visible.
import {
  type ArtifactTailoringExplanation,
  type BulletProvenanceEntry,
  type ApplyReviewProfileSourceField,
} from "../../operations/types.js";
import {
  type ResumeLineEntry,
  type ResumeAuditPin,
  type ProfileSourceMatch,
  type RiskSignals,
} from "./resume-editor-types.js";
import { formatToken, scorePercent } from "./audit-format.js";

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "not recorded";
  return value ? "yes" : "no";
}

type AnnotatedChange = ArtifactTailoringExplanation["annotatedChanges"][number];

function changeFor(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): AnnotatedChange | undefined {
  return annotatedChanges.find(
    (change) =>
      change.section === entry.section && change.sourceId === entry.sourceId,
  );
}

function displayRationale(rationale: string | null | undefined): string | null {
  if (!rationale) return null;
  return rationale
    .replace(/\bevidence_reframing\b/gi, "source-backed wording")
    .replace(/\bevidence controls?\b/gi, "source constraints")
    .replace(/\bverified_only\b/gi, "verified source evidence")
    .replace(/\bauto_approvable\b/gi, "auto approvable")
    .trim();
}

function sourceLineForBullet(
  entry: BulletProvenanceEntry,
): readonly string[] | null {
  return entry.sourceText.length ? entry.sourceText : null;
}

function bulletForLine(
  line: ResumeLineEntry,
  provenance: readonly BulletProvenanceEntry[],
): BulletProvenanceEntry | undefined {
  return line.semanticId
    ? provenance.find((entry) => entry.bulletId === line.semanticId)
    : undefined;
}

export function linePinId(line: ResumeLineEntry): string {
  return (
    line.semanticId ??
    (line.lineNumber
      ? `resume-line:${line.lineNumber}`
      : `rendered-line:${line.lineLabel ?? line.text}`)
  );
}

function lineTitle(line: ResumeLineEntry): string {
  return line.lineNumber
    ? `Line ${line.lineNumber}`
    : (line.lineLabel ?? "Rendered resume line");
}

export function pinsFromExplanation(
  explanation: ArtifactTailoringExplanation,
): ResumeAuditPin[] {
  if (explanation.bulletProvenance.length) {
    return explanation.bulletProvenance.map((entry, index) => {
      const change = changeFor(entry, explanation.annotatedChanges);
      return {
        id: entry.bulletId,
        title:
          change?.label || `${formatToken(entry.section)} pin ${index + 1}`,
        section: entry.section,
        provenanceState: "recorded",
        sourceGranularity: "bullet",
        sourcePrecision: "exact_line",
        sourceId: entry.sourceId,
        sourceLabel: change?.label ?? null,
        sourceText: sourceLineForBullet(entry),
        sourceSpanText: change?.sourceText.length ? change.sourceText : null,
        tailoredText: entry.generatedText ? [entry.generatedText] : [],
        transformType: entry.transformType,
        controls: entry.control ? [entry.control] : [],
        evidenceIds: entry.evidenceIds,
        evidenceNotes: [],
        requirementIds: entry.requirementIds,
        matchedSignals: change?.jobSignals ?? [],
        matchedKeywords: entry.matchedKeywords,
        rationale: displayRationale(entry.rationale || change?.rationale),
      };
    });
  }

  return [];
}

function pinFromProfileSourceLine(
  line: ResumeLineEntry,
  match: ProfileSourceMatch,
): ResumeAuditPin {
  const sourceLabel =
    match.fields.length === 1
      ? (match.fields[0]?.label ?? "Profile source field")
      : "Profile source fields";
  return {
    id: linePinId(line),
    title: lineTitle(line),
    section: match.fields[0]?.section ?? "profile",
    lineNumber: line.lineNumber,
    lineLabel: line.lineLabel,
    provenanceState: "recorded",
    sourceGranularity: "profile_field",
    sourcePrecision: "profile_field",
    sourceId: match.fields.map((field) => field.path).join(", "),
    sourceLabel,
    sourceText: match.sourceText,
    sourceSpanText: null,
    tailoredText: [line.text],
    transformType: "profile_field_rendered",
    controls: [],
    evidenceIds: [],
    evidenceNotes: [],
    requirementIds: [],
    matchedSignals: [],
    matchedKeywords: [],
    rationale:
      match.fields.length === 1
        ? "This selected resume line is rendered from the Profile field shown above."
        : "This selected resume line is rendered from the Profile fields shown above.",
  };
}

export function pinFromResumeLine(
  line: ResumeLineEntry,
  explanation: ArtifactTailoringExplanation | null,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
): ResumeAuditPin {
  const isResumeStructure =
    line.kind === "section" || /^\d+\/\d+$/.test(line.text);
  if (isResumeStructure) {
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section:
        line.kind === "section" ? "resume_section" : `resume_${line.kind}`,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "not_applicable",
      sourceGranularity: "structure",
      sourcePrecision: "structure",
      sourceId: null,
      sourceLabel: null,
      sourceText: null,
      sourceSpanText: null,
      tailoredText: [line.text],
      transformType: "rendered_structure",
      controls: [],
      evidenceIds: [],
      evidenceNotes: [],
      requirementIds: [],
      matchedSignals: [],
      matchedKeywords: [],
      rationale:
        "This selected resume line is document structure, not a generated claim requiring source attribution.",
    };
  }

  const field = line.profileField
    ? profileSourceFields.find((entry) => entry.path === line.profileField)
    : undefined;
  if (field)
    return pinFromProfileSourceLine(line, {
      fields: [field],
      sourceText: [`${field.label}: ${field.value}`],
    });

  const bullet = explanation
    ? bulletForLine(line, explanation.bulletProvenance)
    : undefined;
  if (bullet) {
    const change = explanation
      ? changeFor(bullet, explanation.annotatedChanges)
      : undefined;
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section: bullet.section,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "recorded",
      sourceGranularity: "bullet",
      sourcePrecision: "exact_line",
      sourceId: bullet.sourceId,
      sourceLabel: change?.label ?? null,
      sourceText: sourceLineForBullet(bullet),
      sourceSpanText: change?.sourceText.length ? change.sourceText : null,
      tailoredText: [line.text],
      transformType: bullet.transformType,
      controls: bullet.control ? [bullet.control] : [],
      evidenceIds: bullet.evidenceIds,
      evidenceNotes: [],
      requirementIds: bullet.requirementIds,
      matchedSignals: change?.jobSignals ?? [],
      matchedKeywords: bullet.matchedKeywords,
      rationale: displayRationale(bullet.rationale || change?.rationale),
    };
  }

  return {
    id: linePinId(line),
    title: lineTitle(line),
    section: "rendered_resume",
    lineNumber: line.lineNumber,
    lineLabel: line.lineLabel,
    provenanceState: "missing",
    sourceGranularity: "missing",
    sourcePrecision: "missing",
    sourceId: null,
    sourceLabel: null,
    sourceText: null,
    sourceSpanText: null,
    tailoredText: [line.text],
    transformType: explanation
      ? "unmapped_rendered_line"
      : "no_generation_provenance",
    controls: [],
    evidenceIds: [],
    evidenceNotes: [],
    requirementIds: [],
    matchedSignals: [],
    matchedKeywords: [],
    rationale: explanation
      ? "No recorded source: this line has no generation-time anchor."
      : "No recorded source: this line has no generation-time anchor.",
  };
}

export function pinsFromResumeLines(
  lines: readonly ResumeLineEntry[],
  explanation: ArtifactTailoringExplanation | null,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
): ResumeAuditPin[] {
  return lines.map((line) =>
    pinFromResumeLine(line, explanation, profileSourceFields),
  );
}

export function riskSignals(
  explanation: ArtifactTailoringExplanation,
): RiskSignals {
  const adversarial = explanation.adversarialReview;
  const auditGaps = explanation.quality.errors.filter((error) =>
    error.toLowerCase().startsWith("tailoring audit metadata incomplete"),
  );
  const blockers = uniqueRiskItems([
    ...explanation.quality.errors.filter((error) => !auditGaps.includes(error)),
    ...explanation.judge.issues,
    ...(adversarial?.blockers ?? []),
  ]);
  const rawWarnings = uniqueRiskItems([
    ...explanation.quality.warnings,
    ...(adversarial?.warnings ?? []),
  ]);
  const residualWarnings = uniqueRiskItems([
    ...explanation.reviewFeedback.acceptedWarnings,
    ...(explanation.reviewFeedback.acceptedWithResidualWarnings
      ? rawWarnings
      : []),
  ]);
  const residualWarningKeys = new Set(residualWarnings.map(riskItemKey));
  const warnings = rawWarnings.filter(
    (warning) => !residualWarningKeys.has(riskItemKey(warning)),
  );
  const hasAnyAudit =
    explanation.quality.passed !== null ||
    explanation.judge.verdict !== null ||
    explanation.judge.score !== null ||
    Boolean(adversarial?.ran || adversarial?.skippedReason) ||
    explanation.reviewFeedback.warningRepairAttempted !== null ||
    explanation.reviewFeedback.acceptedWithResidualWarnings !== null;

  return {
    hasAnyAudit,
    lineFindings: explanation.lineFindings ?? [],
    quality: yesNo(
      explanation.quality.passed ?? explanation.safety.qualityPassed,
    ),
    judge:
      explanation.judge.verdict || explanation.judge.score !== null
        ? `${explanation.judge.verdict ?? "recorded"} ${scorePercent(explanation.judge.score)}`
        : "not recorded",
    adversarial: adversarial?.ran
      ? `${yesNo(adversarial.passed)} ${scorePercent(adversarial.score)}`
      : (adversarial?.skippedReason ?? "not recorded"),
    auditGaps,
    blockers,
    warnings,
    unsupportedClaims: explanation.judge.unsupportedClaims,
    fabrications: explanation.judge.fabrications,
    missingRequiredEvidence: explanation.judge.missingRequiredEvidence,
    repairInstructions: [
      ...explanation.judge.repairInstructions,
      ...(adversarial?.repairInstructions ?? []),
    ],
    warningHandling: warningHandlingText(
      explanation.reviewFeedback.warningRepairAttempted,
      residualWarnings.length > 0,
    ),
    residualWarnings,
  };
}

function warningHandlingText(
  warningRepairAttempted: boolean | null,
  hasResidualWarnings: boolean,
): string {
  if (warningRepairAttempted === null) return "not recorded";
  if (warningRepairAttempted) {
    return hasResidualWarnings
      ? "retry attempted; selected artifact still has residual warnings"
      : "retry cleared warnings before selection";
  }
  return hasResidualWarnings
    ? "no retry; workflow selected artifact with residual warnings"
    : "no warning retry recorded";
}

function uniqueRiskItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = item.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = riskItemKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function riskItemKey(item: string): string {
  return item.replace(/\s+/g, " ").trim().toLowerCase();
}

export function emptyRiskSignals(): RiskSignals {
  return {
    hasAnyAudit: false,
    lineFindings: [],
    quality: "not recorded",
    judge: "not recorded",
    adversarial: "not recorded",
    auditGaps: [],
    blockers: [],
    warnings: [],
    unsupportedClaims: [],
    fabrications: [],
    missingRequiredEvidence: [],
    repairInstructions: [],
    warningHandling: "not recorded",
    residualWarnings: [],
  };
}

function pinHasClaimRisk(pin: ResumeAuditPin, risk: RiskSignals): boolean {
  return risk.lineFindings.some((finding) => finding.lineId === pin.id);
}

export function pinTone(
  pin: ResumeAuditPin,
  risk: RiskSignals,
): "ok" | "info" | "warn" {
  if (pin.provenanceState === "missing") {
    return "warn";
  }
  if (pinHasClaimRisk(pin, risk)) {
    return "warn";
  }
  if (pin.sourceGranularity === "bullet" && pin.evidenceIds.length) return "ok";
  if (
    pin.sourceGranularity === "bullet" ||
    pin.sourceGranularity === "change_span"
  )
    return "info";
  if (pin.provenanceState === "not_applicable") return "info";
  if (
    risk.warnings.length ||
    risk.residualWarnings.length ||
    !risk.hasAnyAudit
  ) {
    return "info";
  }
  return "ok";
}

export function pinStatus(pin: ResumeAuditPin, risk: RiskSignals): string {
  if (pin.provenanceState === "missing") {
    return "no recorded source";
  }
  if (pinHasClaimRisk(pin, risk)) {
    return "claim risk";
  }
  if (pin.provenanceState === "not_applicable") return "structure";
  if (pin.sourceGranularity === "profile_field") return "profile source";
  if (pin.sourceGranularity === "bullet") {
    return pin.evidenceIds.length ? "line evidence" : "source pointer";
  }
  if (pin.sourceGranularity === "change_span") {
    return pin.sourcePrecision === "exact_line"
      ? "profile field"
      : "profile section";
  }
  return "review";
}

export function primarySourceTextForPin(
  pin: ResumeAuditPin,
): readonly string[] | null {
  if (!pin.sourceText?.length) return null;
  if (pin.sourceGranularity === "profile_field") return pin.sourceText;
  if (pin.sourceText.length === 1) return pin.sourceText;
  return pin.sourceText;
}

export function sourceLabelForJustification(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "profile_field") {
    return pin.sourceText && pin.sourceText.length > 1
      ? "Profile source fields"
      : "Profile source field";
  }
  if (pin.sourcePrecision === "section_span")
    return "Closest recorded Profile source field";
  return "Profile source field";
}
