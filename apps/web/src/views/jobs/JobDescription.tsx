import type { ReactNode } from "react";

import { descriptionBlocks } from "../../contexts/operations/selectors/jobDescriptionSelectors.js";

export interface JobDescriptionProps {
  text: string;
}

type DescriptionBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] };

export function JobDescription({ text }: JobDescriptionProps) {
  const blocks = markdownDescriptionBlocks(text);
  if (!blocks.length) {
    return <p className="muted">No description captured.</p>;
  }
  return (
    <div className="description-text">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: DescriptionBlock, index: number): ReactNode {
  const key = `${block.kind}-${index}`;
  if (block.kind === "heading") {
    return <h4 key={key}>{renderInlineMarkdown(block.text)}</h4>;
  }
  if (block.kind === "unordered-list") {
    return (
      <ul key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === "ordered-list") {
    return (
      <ol key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ol>
    );
  }
  return <p key={key}>{renderInlineMarkdown(block.text)}</p>;
}

function markdownDescriptionBlocks(text: string): DescriptionBlock[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: DescriptionBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      continue;
    }

    const heading = markdownHeadingText(line);
    if (heading) {
      blocks.push({ kind: "heading", text: heading });
      index += 1;
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").trim().match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").trim().match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index]?.trim() ?? "";
      if (!current) break;
      const startsNewBlock =
        markdownHeadingText(current) || /^[-*+]\s+/.test(current) || /^\d+[.)]\s+/.test(current);
      if (paragraphLines.length && startsNewBlock) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    const paragraph = paragraphLines.join(" ").trim();
    if (paragraph) {
      blocks.push({ kind: "paragraph", text: paragraph });
    }
  }

  if (blocks.length === 1 && blocks[0]?.kind === "paragraph" && blocks[0].text.length > 700) {
    return descriptionBlocks(blocks[0].text).map((block) => ({ kind: "paragraph", text: block }));
  }

  return blocks;
}

function markdownHeadingText(line: string): string | null {
  const atx = line.match(/^#{1,4}\s+(.+)$/);
  if (atx?.[1]) {
    return trimMarkdownMarkers(atx[1]);
  }
  const boldOnly = line.match(/^\*\*(.+)\*\*$/);
  if (boldOnly?.[1] && boldOnly[1].length <= 140) {
    return trimMarkdownMarkers(boldOnly[1]);
  }
  return null;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(unescapeMarkdown(text.slice(cursor, match.index)));
    }
    if (match[2] && match[3]) {
      nodes.push(
        <a href={match[3]} key={`${match.index}-link`} rel="noreferrer" target="_blank">
          {unescapeMarkdown(match[2])}
        </a>,
      );
    } else if (match[4] || match[5]) {
      nodes.push(
        <strong key={`${match.index}-strong`}>
          {unescapeMarkdown(match[4] ?? match[5] ?? "")}
        </strong>,
      );
    } else if (match[6]) {
      nodes.push(<code key={`${match.index}-code`}>{unescapeMarkdown(match[6])}</code>);
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(unescapeMarkdown(text.slice(cursor)));
  }
  return nodes;
}

function trimMarkdownMarkers(text: string): string {
  return unescapeMarkdown(text.replace(/\*\*/g, "").replace(/__/g, "").trim());
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}
