export type DemoPrivacyFinding =
  | "email"
  | "domain"
  | "phone"
  | "secret"
  | "full_url"
  | "local_path"
  | "raw_prompt"
  | "raw_profile";

const PRIVACY_NEEDLES: readonly [DemoPrivacyFinding, RegExp][] = [
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["domain", /(?<![/\w@.-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i],
  [
    "phone",
    /(?<!\w)(?:\+\d{1,3}(?:[\s().-]*\d){6,14}|(?!\d{4}-\d{2}-\d{2}(?:T|\b))(?:\(?\d{2,4}\)?[ .-]){2,4}\d{2,4})(?!\d)/,
  ],
  ["secret", /\b(?:sk-[a-z0-9_-]+|api[_ -]?key|authorization:\s*bearer|begin private key)\b/i],
  ["full_url", /\b(?:https?|file):\/\//i],
  ["local_path", /(?:^|[\s"'])?(?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\)/],
  ["raw_prompt", /\b(?:system prompt|prompt template|instruction hierarchy)\b/i],
  ["raw_profile", /\b(?:raw profile text|profile payload|resume source text)\b/i],
];

/** Returns every disallowed privacy needle so release checks can fail closed. */
export function scanDemoPrivacy(value: string): readonly DemoPrivacyFinding[] {
  return PRIVACY_NEEDLES.filter(([, needle]) => needle.test(value)).map(([finding]) => finding);
}
