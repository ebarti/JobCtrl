export function descriptionBlocks(text: string): string[] {
  const explicitBlocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (explicitBlocks.length > 1) {
    return explicitBlocks;
  }
  const collapsed = explicitBlocks[0] ?? "";
  if (!collapsed) {
    return [];
  }
  const sentences = collapsed.split(/(?<=[.!?])\s+(?=[A-Z0-9*])/);
  const blocks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 520 && current) {
      blocks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}
