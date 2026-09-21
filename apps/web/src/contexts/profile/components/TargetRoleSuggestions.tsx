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
  profileVersion: number | null;
  onAccept: (titles: readonly string[], expectedProfileVersion: number) => void;
}

export function TargetRoleSuggestions({
  profileVersion,
  onAccept,
}: TargetRoleSuggestionsProps) {
  const generation = useTargetRoleSuggestionsMutation();
  const [generatedVersion, setGeneratedVersion] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
  const [emptyMessage, setEmptyMessage] = useState("");
  const isStale = generatedVersion !== null && generatedVersion !== profileVersion;

  const generate = async () => {
    if (profileVersion === null) return;
    setSuggestions([]);
    setGeneratedVersion(null);
    setEmptyMessage("");
    generation.reset();
    try {
      const result = await generation.mutateAsync({
        expectedProfileVersion: profileVersion,
        maximumSuggestions: 3,
      });
      setGeneratedVersion(result.profileVersion);
      setSuggestions(result.suggestions.map((suggestion) => ({ ...suggestion, selected: true })));
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
            disabled={profileVersion === null || generation.isPending}
            onClick={() => void generate()}
          >
            {generation.isPending ? "Generating…" : "Suggest roles"}
          </Button>
        </CardAction>
      </CardHeader>
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
      {suggestions.length ? (
        <CardContent>
          <FieldGroup>
            {suggestions.map((suggestion, index) => (
              <Field key={`${suggestion.classification}:${index}`} orientation="horizontal">
                <Checkbox
                  aria-label={`Select ${suggestion.title}`}
                  checked={suggestion.selected}
                  disabled={isStale}
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
                    disabled={isStale}
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
                    disabled={isStale}
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
          <Button type="button" disabled={isStale || selectedCount === 0} onClick={accept}>
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
