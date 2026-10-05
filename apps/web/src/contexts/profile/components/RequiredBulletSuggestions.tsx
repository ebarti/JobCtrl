import { useEffect, useRef, useState } from "react";

import type { RequiredBulletSuggestion } from "../../operations/types.js";
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
import { useRequiredBulletSuggestionsMutation } from "../hooks/useRequiredBulletSuggestionsMutation.js";

export interface RequiredBulletSuggestionsProps {
  isDraftClean: boolean;
  profileVersion: number | null;
  resetToken: number;
  onAccept: (suggestion: RequiredBulletSuggestion, expectedProfileVersion: number) => Promise<boolean>;
}

export function RequiredBulletSuggestions({
  isDraftClean,
  profileVersion,
  resetToken,
  onAccept,
}: RequiredBulletSuggestionsProps) {
  const generation = useRequiredBulletSuggestionsMutation();
  const requestSequence = useRef(0);
  const currentAuthority = useRef({ isDraftClean, profileVersion, resetToken });
  const acceptInFlight = useRef(false);
  const preserveReviewedAfterFailure = useRef(false);
  const [generatedVersion, setGeneratedVersion] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<RequiredBulletSuggestion[]>([]);
  const [emptyMessage, setEmptyMessage] = useState("");
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const isStale = generatedVersion !== null && generatedVersion !== profileVersion;

  useEffect(() => {
    currentAuthority.current = { isDraftClean, profileVersion, resetToken };
    requestSequence.current += 1;
    if (generatedVersion === profileVersion
      && (acceptInFlight.current || preserveReviewedAfterFailure.current)) {
      return;
    }
    preserveReviewedAfterFailure.current = false;
    setGeneratedVersion(null);
    setSuggestions([]);
    setEmptyMessage("");
    setAcceptingId(null);
    generation.reset();
  }, [isDraftClean, profileVersion, resetToken]);

  useEffect(() => () => {
    requestSequence.current += 1;
  }, []);

  const generate = async () => {
    if (profileVersion === null || !isDraftClean) return;
    preserveReviewedAfterFailure.current = false;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    generation.reset();
    try {
      const result = await generation.mutateAsync({
        expectedProfileVersion: profileVersion,
        maximumSuggestions: 12,
      });
      const authority = currentAuthority.current;
      if (
        sequence !== requestSequence.current
        || !authority.isDraftClean
        || authority.profileVersion !== result.profileVersion
      ) return;
      setGeneratedVersion(result.profileVersion);
      setSuggestions(result.suggestions);
      if (result.truncated && result.suggestions.length === 0) {
        setEmptyMessage("Inspection is incomplete: saved Required sources exceed a safe inspection or response limit. Edit them manually; repeating this request on the same saved version may omit the same sources.");
      } else if (result.suggestions.length === 0) {
        setEmptyMessage(result.modelUsed ? "No coaching findings were returned." : "There are no inspectable saved Required bullets. Review your Required selections in the editor.");
      } else if (result.truncated) {
        setEmptyMessage("Inspection is incomplete. These suggestions cover only part of the saved Required bullets; other sources may exceed a safe limit or the response cap. Review these items and edit omitted bullets manually.");
      }
    } catch {
      // The mutation exposes its sanitized API error below. Saved data stays untouched.
    }
  };

  const reject = (id: string) => {
    setSuggestions((current) => current.filter((suggestion) => suggestion.id !== id));
  };

  const accept = async (suggestion: RequiredBulletSuggestion) => {
    if (!suggestion.canApply || generatedVersion === null || isStale || !isDraftClean) return;
    acceptInFlight.current = true;
    setAcceptingId(suggestion.id);
    let accepted = false;
    try {
      accepted = await onAccept(suggestion, generatedVersion);
    } catch {
      // The form reports its save error. Keep the reviewed item available.
    } finally {
      acceptInFlight.current = false;
      preserveReviewedAfterFailure.current = !accepted;
      setAcceptingId(null);
    }
    if (accepted) {
      preserveReviewedAfterFailure.current = false;
      requestSequence.current += 1;
      setSuggestions([]);
      setGeneratedVersion(null);
      setEmptyMessage("Suggestion accepted and saved. Inspect again to review the updated profile version.");
      generation.reset();
    }
  };

  return (
    <Card size="sm" className="mb-5">
      <CardHeader>
        <CardTitle>Required bullet coaching</CardTitle>
        <CardDescription>
          Opt in to LLM coaching of saved Required experience bullets. Your configured provider receives these bullets and their linked evidence.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="secondary"
            disabled={profileVersion === null || !isDraftClean || generation.isPending || acceptingId !== null}
            onClick={() => void generate()}
          >
            {generation.isPending ? "Inspecting…" : "Inspect Required bullets"}
          </Button>
        </CardAction>
      </CardHeader>
      {!isDraftClean ? (
        <CardContent>
          <p data-typography="metadata">
            Save or discard local edits before inspecting or accepting coaching suggestions.
          </p>
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
            <AlertDescription>The saved profile changed. Inspect its Required bullets again.</AlertDescription>
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
      {suggestions.map((suggestion) => (
        <CardContent key={suggestion.id} className="border-t">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="category">{suggestion.kind.replace("_", " ")}</Badge>
              <Badge variant="outline">LLM coaching</Badge>
              <Badge variant="outline">
                {suggestion.source.identityKind === "canonical_achievement"
                  ? `Achievement ${suggestion.source.sourceId}`
                  : "Snapshot bullet reference"}
              </Badge>
            </div>
            <p data-typography="strong-body">
              {suggestion.source.experienceTitle} · {suggestion.source.experienceCompany}
            </p>
            <p data-typography="body">Saved text: “{suggestion.originalText}”</p>
            {suggestion.proposedText ? (
              <p data-typography="body">Proposed text: “{suggestion.proposedText}”</p>
            ) : null}
            <p data-typography="body">{suggestion.guidance}</p>
            <p data-typography="metadata">
              Source: {suggestion.source.fieldPath} · {suggestion.source.sourceId} · excerpt “{suggestion.source.excerpt}”
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestion.canApply ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isStale || !isDraftClean || acceptingId !== null}
                  onClick={() => void accept(suggestion)}
                >
                  {acceptingId === suggestion.id ? "Saving…" : "Accept"}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={acceptingId !== null}
                onClick={() => reject(suggestion.id)}
              >
                Reject
              </Button>
            </div>
          </div>
        </CardContent>
      ))}
      {suggestions.length > 0 ? (
        <CardFooter className="border-t">
          <Button
            type="button"
            variant="ghost"
            disabled={acceptingId !== null}
            onClick={() => setSuggestions([])}
          >
            Reject all
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
