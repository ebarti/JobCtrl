import type { DemoArtifacts } from "./contracts.js";

/** Static, same-origin public assets. These are synchronous URL literals, never filesystem paths. */
export const DEMO_ARTIFACTS = {
  sourcePreview: {
    assetId: "demo-source-preview",
    contentType: "text/html",
    url: "/demo/source-preview.html",
    label: "Bundled source preview",
  },
  applicationPreview: {
    assetId: "demo-application-preview",
    contentType: "text/html",
    url: "/demo/application-preview.html",
    label: "Bundled application preview",
  },
  profileResumeHtml: {
    assetId: "demo-profile-resume-html",
    contentType: "text/html",
    url: "/demo/profile-resume.html",
    label: "Bundled sample profile resume",
  },
  profileResumePdf: {
    assetId: "demo-profile-resume-pdf",
    contentType: "application/pdf",
    url: "/demo/profile-resume.pdf",
    label: "Bundled sample profile resume PDF",
  },
  tailoredResumeHtml: {
    assetId: "demo-tailored-resume-html",
    contentType: "text/html",
    url: "/demo/tailored-resume.html",
    label: "Bundled tailored resume preview",
  },
  tailoredResumePdf: {
    assetId: "demo-tailored-resume-pdf",
    contentType: "application/pdf",
    url: "/demo/tailored-resume.pdf",
    label: "Bundled tailored resume preview",
  },
  coverLetter: {
    assetId: "demo-cover-letter",
    contentType: "text/plain",
    url: "/demo/cover-letter.txt",
    label: "Bundled cover-letter preview",
  },
  interviewNotes: {
    assetId: "demo-interview-notes",
    contentType: "text/plain",
    url: "/demo/interview-notes.txt",
    label: "Bundled interview preparation notes",
  },
} as const satisfies DemoArtifacts;

export function isDemoArtifactUrl(value: string): value is `/demo/${string}` {
  return value.startsWith("/demo/") && !value.includes("://") && !value.includes("\\") && !value.includes("..");
}
