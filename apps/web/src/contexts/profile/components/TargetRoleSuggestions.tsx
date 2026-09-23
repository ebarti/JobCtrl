import { useRef, useState } from "react";

import type { TargetPreferenceSuggestion, TargetRoleSuggestion } from "../../operations/types.js";
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
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "../../../shared/ui/select.js";
import { useTargetRoleSuggestionsMutation } from "../hooks/useTargetRoleSuggestionsMutation.js";

interface EditableSuggestion extends TargetRoleSuggestion {
  selected: boolean;
  originalTitle: string;
}

interface EditablePreferenceSuggestion extends TargetPreferenceSuggestion {
  selected: boolean;
  originalLocation: string;
  originalWorkModel: string;
}

export interface TargetRoleSuggestionsProps {
  formBaseVersion: number | null;
  profileVersion: number | null;
  onAccept: (
    titles: readonly string[],
    preferences: readonly TargetPreferenceSuggestion[],
    expectedProfileVersion: number,
  ) => void;
  onRebase: () => void;
  onResolveWithoutAcceptance: (expectedProfileVersion: number) => void;
}

export function TargetRoleSuggestions({
  formBaseVersion,
  profileVersion,
  onAccept,
  onRebase,
  onResolveWithoutAcceptance,
}: TargetRoleSuggestionsProps) {
  const generation = useTargetRoleSuggestionsMutation();
  const [generatedVersion, setGeneratedVersion] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
  const [preferenceSuggestions, setPreferenceSuggestions] = useState<EditablePreferenceSuggestion[]>([]);
  const [emptyMessage, setEmptyMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const currentProfileVersion = useRef(profileVersion);
  const currentFormBaseVersion = useRef(formBaseVersion);
  currentProfileVersion.current = profileVersion;
  currentFormBaseVersion.current = formBaseVersion;
  const isFormBaseStale = formBaseVersion !== profileVersion;
  const isStale = generatedVersion !== null && generatedVersion !== profileVersion;

  const generate = async () => {
    if (profileVersion === null || isFormBaseStale) return;
    setSuggestions([]);
    setPreferenceSuggestions([]);
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
      setSuggestions(result.suggestions.map((suggestion) => ({
        ...suggestion, originalTitle: suggestion.title, selected: false,
      })));
      const preferences = result.preferenceSuggestions ?? [];
      setPreferenceSuggestions(preferences.map((suggestion) => ({
        ...suggestion,
        originalLocation: suggestion.location,
        originalWorkModel: suggestion.workModel,
        selected: false,
      })));
      if (
        result.suggestions.length === 0
        && preferences.length === 0
        && result.profileVersion === currentProfileVersion.current
        && result.profileVersion === currentFormBaseVersion.current
      ) {
        onResolveWithoutAcceptance(result.profileVersion);
      }
      if (result.warnings.includes("stubbed_model_evidence")) {
        setNoticeMessage("This demo result uses deterministic fixture evidence; no model ran.");
      } else if (result.warnings.includes("model_unavailable_or_invalid")) {
        setNoticeMessage("The model was unavailable. Conservative suggestions use saved evidence only.");
      } else if (result.warnings.includes("spend_budget_exhausted")) {
        setNoticeMessage("The model spend budget is exhausted. Conservative suggestions use saved evidence only.");
      } else if (result.warnings.includes("provider_token_or_cost_bound_unsupported")) {
        setNoticeMessage(
          "No model ran: the configured provider cannot enforce this feature's token and spend ceiling. Suggestions use saved evidence only.",
        );
      }
      if (result.suggestions.length === 0 && preferences.length === 0) {
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
    if (generatedVersion !== null && !isStale && !isFormBaseStale) {
      onResolveWithoutAcceptance(generatedVersion);
    }
    setSuggestions([]);
    setPreferenceSuggestions([]);
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
    const preferences = preferenceSuggestions.filter((item) => item.selected).map((item) => ({
      location: item.location.trim(),
      workModel: item.workModel,
      evidenceIds: item.evidenceIds,
    })).filter((item) => item.location || item.workModel);
    if (!titles.length && !preferences.length) return;
    onAccept(titles, preferences, generatedVersion);
    setSuggestions([]);
    setPreferenceSuggestions([]);
    setGeneratedVersion(null);
    setEmptyMessage("");
    setNoticeMessage("");
    generation.reset();
  };

  const selectedRoleCount = suggestions.filter((suggestion) => suggestion.selected).length;
  const selectedPreferenceCount = preferenceSuggestions.filter((suggestion) => suggestion.selected).length;
  const selectedCount = selectedRoleCount + selectedPreferenceCount;
  const hasSuggestions = suggestions.length > 0 || preferenceSuggestions.length > 0;
  return (
    <Card size="sm" className="mb-5">
      <CardHeader>
        <CardTitle>Evidence-backed target search suggestions</CardTitle>
        <CardDescription>
          Uses the saved profile version. Historical locations and work models are not consent to search there;
          select and save each preference you want.
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
                    <Badge variant="category">Original: {suggestion.classification}</Badge>
                    <Badge variant="outline">{suggestion.track}</Badge>
                    <Badge variant="outline">{suggestion.seniority}</Badge>
                  </FieldTitle>
                  <FieldDescription>
                    Original suggestion: {suggestion.originalTitle}.
                    {suggestion.title !== suggestion.originalTitle
                      ? " This title was edited; the original evidence does not validate your edit."
                      : " Evidence below supports this original title."}
                  </FieldDescription>
                  <FieldDescription>{suggestion.rationale}</FieldDescription>
                  <FieldDescription>
                    Original evidence IDs: {suggestion.evidenceIds.join(", ")}
                  </FieldDescription>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isStale || isFormBaseStale}
                    onClick={() => {
                      const next = suggestions.filter((_, itemIndex) => itemIndex !== index);
                      if (next.length === 0 && preferenceSuggestions.length === 0 && generatedVersion !== null) {
                        onResolveWithoutAcceptance(generatedVersion);
                      }
                      setSuggestions(next);
                    }}
                  >
                    Reject {suggestion.title}
                  </Button>
                </FieldContent>
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      ) : null}
      {preferenceSuggestions.length ? (
        <CardContent>
          <FieldGroup>
            {preferenceSuggestions.map((suggestion, index) => (
              <Field key={`${suggestion.evidenceIds.join(":")}:${index}`} orientation="horizontal">
                <Checkbox
                  aria-label={`Select historical preference ${index + 1}`}
                  checked={suggestion.selected}
                  disabled={isStale || isFormBaseStale}
                  onCheckedChange={(checked) => setPreferenceSuggestions((current) => current.map(
                    (item, itemIndex) => itemIndex === index ? { ...item, selected: checked === true } : item,
                  ))}
                />
                <FieldContent>
                  <FieldTitle>Historical preference proposal {index + 1}</FieldTitle>
                  <FieldDescription>
                    Original experience: {suggestion.originalLocation || "no location"}
                    {suggestion.originalWorkModel ? `, ${suggestion.originalWorkModel}` : ""}.
                    Evidence ID: {suggestion.evidenceIds.join(", ")}.
                    {suggestion.location !== suggestion.originalLocation || suggestion.workModel !== suggestion.originalWorkModel
                      ? " Values were edited; the original evidence does not validate your edit."
                      : " This describes past work, not current search willingness."}
                  </FieldDescription>
                  <FieldLabel htmlFor={`target-preference-location-${index}`}>Proposed location {index + 1}</FieldLabel>
                  <Input
                    id={`target-preference-location-${index}`}
                    aria-label={`Proposed location ${index + 1}`}
                    value={suggestion.location}
                    maxLength={100}
                    disabled={isStale || isFormBaseStale}
                    onChange={(event) => setPreferenceSuggestions((current) => current.map(
                      (item, itemIndex) => itemIndex === index ? { ...item, location: event.target.value } : item,
                    ))}
                  />
                  <Select
                    disabled={isStale || isFormBaseStale}
                    items={[
                      { value: "none", label: "No work model" },
                      { value: "Remote", label: "Remote" },
                      { value: "Hybrid", label: "Hybrid" },
                      { value: "On-site", label: "On-site" },
                    ]}
                    value={suggestion.workModel || "none"}
                    onValueChange={(value) => setPreferenceSuggestions((current) => current.map(
                      (item, itemIndex) => itemIndex === index
                        ? { ...item, workModel: value === "none" || value === null
                          ? "" : value as TargetPreferenceSuggestion["workModel"] }
                        : item,
                    ))}
                  >
                    <SelectTrigger aria-label={`Proposed work model ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">No work model</SelectItem>
                        <SelectItem value="Remote">Remote</SelectItem>
                        <SelectItem value="Hybrid">Hybrid</SelectItem>
                        <SelectItem value="On-site">On-site</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isStale || isFormBaseStale}
                    onClick={() => {
                      const next = preferenceSuggestions.filter((_, itemIndex) => itemIndex !== index);
                      if (next.length === 0 && suggestions.length === 0 && generatedVersion !== null) {
                        onResolveWithoutAcceptance(generatedVersion);
                      }
                      setPreferenceSuggestions(next);
                    }}
                  >
                    Reject historical preference {index + 1}
                  </Button>
                </FieldContent>
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      ) : null}
      {hasSuggestions ? (
        <CardFooter className="gap-2 border-t">
          <Button
            type="button"
            disabled={isStale || isFormBaseStale || selectedCount === 0}
            onClick={accept}
          >
            {selectedRoleCount && selectedPreferenceCount
              ? "Add selected roles and preferences"
              : selectedPreferenceCount ? "Add selected preferences" : "Add selected roles"}
          </Button>
          <Button type="button" variant="secondary" onClick={dismiss}>
            Dismiss suggestions
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
