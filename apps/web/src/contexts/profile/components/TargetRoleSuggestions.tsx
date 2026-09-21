import { useState } from "react";

import type { TargetRoleSuggestion } from "../../operations/types.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useTargetRoleSuggestionsMutation } from "../hooks/useTargetRoleSuggestionsMutation.js";

interface EditableSuggestion extends TargetRoleSuggestion {
  selected: boolean;
}

export interface TargetRoleSuggestionsProps {
  formBaseVersion: number | null;
  profileVersion: number | null;
  onAccept: (titles: readonly string[], expectedProfileVersion: number) => void;
  onRebase: () => void;
}

export function TargetRoleSuggestions({
  formBaseVersion,
  profileVersion,
  onAccept,
  onRebase,
}: TargetRoleSuggestionsProps) {
  const generation = useTargetRoleSuggestionsMutation();
  const [generatedVersion, setGeneratedVersion] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
  const [emptyMessage, setEmptyMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const isFormBaseStale = formBaseVersion !== profileVersion;
  const isStale = generatedVersion !== null && generatedVersion !== profileVersion;

  const generate = async () => {
    if (profileVersion === null || isFormBaseStale) return;
    setSuggestions([]);
    setGeneratedVersion(null);
    setEmptyMessage("");
    setNoticeMessage("");
    generation.reset();
    try {
      const result = await generation.mutateAsync({
        expectedProfileVersion: profileVersion,
        maximumSuggestions: 3,
      });
      setGeneratedVersion(result.profileVersion);
      setSuggestions(result.suggestions.map((suggestion) => ({ ...suggestion, selected: true })));
      if (result.warnings.includes("stubbed_model_evidence")) {
        setNoticeMessage("This demo result uses deterministic fixture evidence; no model ran.");
      } else if (result.warnings.includes("model_unavailable_or_invalid")) {
        setNoticeMessage("Model suggestions were unavailable, so only an exact saved title may appear.");
      } else if (result.warnings.includes("spend_budget_exhausted")) {
        setNoticeMessage("The model spend budget is exhausted, so only an exact saved title may appear.");
      } else if (result.warnings.includes("provider_token_or_cost_bound_unsupported")) {
        setNoticeMessage(
          "The configured provider cannot enforce this feature's token and spend ceiling, so only an exact saved title may appear.",
        );
      }
      if (result.suggestions.length === 0) {
        setEmptyMessage(
          result.warnings.includes("authoritative_track_or_seniority_missing")
            ? "Add an explicit target track and seniority before requesting suggestions."
            : "The saved evidence did not support a conservative role suggestion.",
        );
      }
    } catch {
      // The mutation exposes its sanitized API error below.
    }
  };

  const dismiss = () => {
    setSuggestions([]);
    setGeneratedVersion(null);
    setEmptyMessage("");
    setNoticeMessage("");
    generation.reset();
  };

  const accept = () => {
    if (generatedVersion === null || isStale) return;
    const titles = suggestions
      .filter((suggestion) => suggestion.selected)
      .map((suggestion) => suggestion.title.trim())
      .filter(Boolean);
    if (!titles.length) return;
    onAccept(titles, generatedVersion);
    dismiss();
  };

  const selectedCount = suggestions.filter((suggestion) => suggestion.selected).length;
  return (
    <Card size="sm" className="mb-5">
      <CardHeader>
        <CardTitle>Evidence-backed role suggestions</CardTitle>
        <CardDescription>
          Uses the saved profile version. Review every title before adding it to target roles.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="secondary"
            disabled={profileVersion === null || isFormBaseStale || generation.isPending}
            onClick={() => void generate()}
          >
            {generation.isPending ? "Generating…" : "Suggest roles"}
          </Button>
        </CardAction>
      </CardHeader>
      {isFormBaseStale ? (
        <CardContent>
          <Alert variant="warning">
            <AlertDescription>
              The saved profile changed while this form has unsaved edits. Rebase the draft onto
              the saved profile before generating or accepting suggestions.
            </AlertDescription>
          </Alert>
          <Button type="button" variant="secondary" className="mt-3" onClick={onRebase}>
            Rebase edits onto saved profile
          </Button>
        </CardContent>
      ) : null}
      {generation.error ? (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{generation.error.message}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      {isStale ? (
        <CardContent>
          <Alert variant="warning">
            <AlertDescription>
              The saved profile changed after these suggestions were generated. Generate them again.
            </AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      {emptyMessage ? (
        <CardContent>
          <Alert variant="info">
            <AlertDescription>{emptyMessage}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      {noticeMessage ? (
        <CardContent>
          <Alert variant="info">
            <AlertDescription>{noticeMessage}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      {suggestions.length ? (
        <CardContent>
          <FieldGroup>
            {suggestions.map((suggestion, index) => (
              <Field key={`${suggestion.classification}:${index}`} orientation="horizontal">
                <Checkbox
                  aria-label={`Select ${suggestion.title}`}
                  checked={suggestion.selected}
                  disabled={isStale || isFormBaseStale}
                  onCheckedChange={(checked) => {
                    setSuggestions((current) => current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, selected: checked === true } : item));
                  }}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`target-role-suggestion-${index}`}>
                    Suggested role {index + 1}
                  </FieldLabel>
                  <Input
                    id={`target-role-suggestion-${index}`}
                    aria-label={`Suggested role ${index + 1}`}
                    value={suggestion.title}
                    disabled={isStale || isFormBaseStale}
                    maxLength={100}
                    onChange={(event) => {
                      setSuggestions((current) => current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, title: event.target.value } : item));
                    }}
                  />
                  <FieldTitle className="flex-wrap">
                    <Badge variant="category">{suggestion.classification}</Badge>
                    <Badge variant="outline">{suggestion.track}</Badge>
                    <Badge variant="outline">{suggestion.seniority}</Badge>
                  </FieldTitle>
                  <FieldDescription>{suggestion.rationale}</FieldDescription>
                  <FieldDescription>
                    Evidence: {suggestion.evidenceIds.join(", ")}
                  </FieldDescription>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isStale || isFormBaseStale}
                    onClick={() => setSuggestions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    Reject {suggestion.title}
                  </Button>
                </FieldContent>
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      ) : null}
      {suggestions.length ? (
        <CardFooter className="gap-2 border-t">
          <Button
            type="button"
            disabled={isStale || isFormBaseStale || selectedCount === 0}
            onClick={accept}
          >
            Add selected roles
          </Button>
          <Button type="button" variant="secondary" onClick={dismiss}>
            Dismiss suggestions
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
