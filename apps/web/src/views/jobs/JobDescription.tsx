import { MarkdownDocument } from "../../shared/ui/MarkdownDocument.js";

export interface JobDescriptionProps {
  text: string;
}

export function JobDescription({ text }: JobDescriptionProps) {
  return <MarkdownDocument text={text} />;
}
