// Curated mermaid palettes for both color modes. The renderer component
// (MermaidRenderer.vue) picks one per render based on the html `.dark` class;
// both build on mermaid's "base" theme so every variable here is authoritative
// rather than blended with a stock theme.
//
// fontFamily stays a SYSTEM stack on purpose: the lightbox serializes diagrams
// into data-URL <img> documents, which cannot fetch webfonts — a webfont here
// would change text metrics between page and lightbox and clip labels.

const FONT_STACK =
  'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const SHARED = {
  startOnLoad: false,
  securityLevel: "loose",
  theme: "base",
  flowchart: {
    curve: "linear",
    nodeSpacing: 45,
    rankSpacing: 55,
    padding: 14,
    htmlLabels: true,
  },
  sequence: { actorMargin: 60, messageMargin: 40, mirrorActors: false },
} as const;

export const MERMAID_LIGHT = {
  ...SHARED,
  themeVariables: {
    fontFamily: FONT_STACK,
    fontSize: "16px",
    primaryColor: "#eef2ff",
    primaryBorderColor: "#6366f1",
    primaryTextColor: "#1e293b",
    secondaryColor: "#f5f3ff",
    secondaryBorderColor: "#8b5cf6",
    tertiaryColor: "#f8fafc",
    tertiaryBorderColor: "#cbd5e1",
    mainBkg: "#eef2ff",
    nodeBorder: "#6366f1",
    lineColor: "#64748b",
    textColor: "#334155",
    titleColor: "#0f172a",
    edgeLabelBackground: "#eef2ff",
    clusterBkg: "#f8fafc",
    clusterBorder: "#e2e8f0",
    actorBkg: "#eef2ff",
    actorBorder: "#6366f1",
    actorTextColor: "#1e293b",
    actorLineColor: "#94a3b8",
    signalColor: "#475569",
    signalTextColor: "#334155",
    labelBoxBkgColor: "#e0e7ff",
    labelBoxBorderColor: "#6366f1",
    labelTextColor: "#1e293b",
    loopTextColor: "#1e293b",
    noteBkgColor: "#fef9c3",
    noteBorderColor: "#eab308",
    noteTextColor: "#713f12",
    activationBkgColor: "#e0e7ff",
    activationBorderColor: "#6366f1",
    sequenceNumberColor: "#ffffff",
    attributeBackgroundColorEven: "#f8fafc",
    attributeBackgroundColorOdd: "#ffffff",
  },
};

export const MERMAID_DARK = {
  ...SHARED,
  themeVariables: {
    fontFamily: FONT_STACK,
    fontSize: "16px",
    primaryColor: "#1e1b4b",
    primaryBorderColor: "#818cf8",
    primaryTextColor: "#e0e7ff",
    secondaryColor: "#2e1065",
    secondaryBorderColor: "#a78bfa",
    tertiaryColor: "#161618",
    tertiaryBorderColor: "#374151",
    mainBkg: "#1e1b4b",
    nodeBorder: "#818cf8",
    lineColor: "#94a3b8",
    textColor: "#cbd5e1",
    titleColor: "#e2e8f0",
    edgeLabelBackground: "#1e293b",
    clusterBkg: "#202127",
    clusterBorder: "#32363f",
    actorBkg: "#1e1b4b",
    actorBorder: "#818cf8",
    actorTextColor: "#e0e7ff",
    actorLineColor: "#64748b",
    signalColor: "#cbd5e1",
    signalTextColor: "#cbd5e1",
    labelBoxBkgColor: "#312e81",
    labelBoxBorderColor: "#818cf8",
    labelTextColor: "#e0e7ff",
    loopTextColor: "#e0e7ff",
    noteBkgColor: "#422006",
    noteBorderColor: "#d97706",
    noteTextColor: "#fde68a",
    activationBkgColor: "#312e81",
    activationBorderColor: "#818cf8",
    sequenceNumberColor: "#0f172a",
    attributeBackgroundColorEven: "#1f2937",
    attributeBackgroundColorOdd: "#161618",
  },
};
