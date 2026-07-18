import { IconCheck } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useCorrectScoreMutation } from "../hooks/useCorrectScoreMutation.js";

export interface ScoreCorrectionControlProps {
  readonly jobId: string;
  readonly currentScore: number | null;
}

export function ScoreCorrectionControl({ jobId, currentScore }: ScoreCorrectionControlProps) {
  const [correctedScore, setCorrectedScore] = useState(String(currentScore ?? 7));
  const [reason, setReason] = useState("");
  const mutation = useCorrectScoreMutation();
  const parsedScore = Number(correctedScore);
  const scoreIsValid = Number.isInteger(parsedScore) && parsedScore >= 1 && parsedScore <= 10;
  const disabled = mutation.isPending || !reason.trim() || !scoreIsValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) {
      return;
    }
    mutation.mutate({
      jobId,
      correctedScore: parsedScore,
      reason: reason.trim(),
    });
  };

  return (
    <form className="score-correction" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="score-correction-score">Correct score</FieldLabel>
        <Input
          id="score-correction-score"
          min={1}
          max={10}
          step={1}
          type="number"
          value={correctedScore}
          aria-invalid={!scoreIsValid}
          onChange={(event) => setCorrectedScore(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="score-correction-reason">Reason</FieldLabel>
        <Input
          id="score-correction-reason"
          maxLength={1000}
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Button aria-label="Save score correction" disabled={disabled} size="icon" type="submit">
        <IconCheck aria-hidden="true" size={16} />
      </Button>
      {mutation.isSuccess ? (
        <small role="status">Scoring policy updated; comparable scores may be stale.</small>
      ) : null}
      {mutation.isError ? <small role="alert">{mutation.error.message}</small> : null}
    </form>
  );
}
