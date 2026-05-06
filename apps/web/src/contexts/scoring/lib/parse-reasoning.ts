export interface ParsedScoreReasoning {
  keywords: string[];
  reason: string;
  score: number | null;
}

export function parseScoreReasoning(text: string): ParsedScoreReasoning {
  const scoreMatch = text.match(/\bscore\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const keywordMatch = text.match(/\bkeywords\s*:\s*(.*)$/i);
  const score = scoreMatch ? Number.parseFloat(scoreMatch[1] ?? "") : null;
  const keywords = keywordMatch?.[1]
    ? keywordMatch[1]
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    : [];
  const cleanedText = text
    .replace(/\bscore\s*:\s*[0-9]+(?:\.[0-9]+)?/gi, "")
    .replace(/\bkeywords\s*:.*$/i, "")
    .trim();
  const reason = cleanedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    keywords,
    reason,
    score: Number.isFinite(score) ? score : null,
  };
}
