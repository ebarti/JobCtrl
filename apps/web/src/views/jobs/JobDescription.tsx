import { descriptionBlocks } from "../../contexts/operations/selectors/jobDescriptionSelectors.js";

export interface JobDescriptionProps {
  text: string;
}

export function JobDescription({ text }: JobDescriptionProps) {
  const blocks = descriptionBlocks(text);
  if (!blocks.length) {
    return <p className="muted">No description captured.</p>;
  }
  return (
    <div className="description-text">
      {blocks.map((block, index) => (
        <p key={`${block.slice(0, 40)}-${index}`}>{block}</p>
      ))}
    </div>
  );
}
