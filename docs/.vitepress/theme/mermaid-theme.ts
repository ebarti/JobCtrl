// Curated mermaid palettes for both color modes. The renderer component
// (MermaidRenderer.vue) picks one per render based on the html `.dark` class;
// both build on mermaid's "base" theme so every variable here is authoritative
// rather than blended with a stock theme.
//
// fontFamily stays a SYSTEM stack on purpose: the lightbox serializes diagrams
// into data-URL <img> documents, which cannot fetch webfonts — a webfont here
// would change text metrics between page and lightbox and clip labels.

const FONT_STACK =
  '"Helvetica Neue", Helvetica, Arial, sans-serif';

interface SemanticPalette {
  ui: [fill: string, stroke: string, text: string];
  ts: [fill: string, stroke: string, text: string];
  py: [fill: string, stroke: string, text: string];
  infra: [fill: string, stroke: string, text: string];
  store: [fill: string, stroke: string, text: string];
  ext: [fill: string, stroke: string, text: string];
}

function semanticThemeCss(palette: SemanticPalette): string {
  const nodeRule = (name: keyof SemanticPalette, dashed = false): string => {
    const [fill, stroke, text] = palette[name];
    return `
      .node.${name} :is(rect, circle, ellipse, polygon, path),
      .actor.${name} {
        fill: ${fill} !important;
        stroke: ${stroke} !important;
        ${dashed ? "stroke-dasharray: 6 4 !important;" : ""}
      }
      .node.${name} .nodeLabel,
      .node.${name} .label,
      .actor.${name} text {
        color: ${text} !important;
        fill: ${text} !important;
      }
      .node.${name}.icon-shape g[style*="color:"] {
        color: ${stroke} !important;
      }
      .node.${name}.icon-shape g[style*="color:"]
        :is(path, line, polyline, polygon, circle, ellipse, rect) {
        fill: none !important;
        stroke: currentColor !important;
      }
    `;
  };

  return `
    ${nodeRule("ui")}
    ${nodeRule("ts")}
    ${nodeRule("py")}
    ${nodeRule("infra")}
    ${nodeRule("store")}
    ${nodeRule("ext", true)}
    .cluster rect {
      rx: 0px;
      ry: 0px;
    }
    .cluster-label text,
    .cluster-label span {
      font-weight: 700 !important;
    }
    .edgeLabel {
      border-radius: 0px;
      padding: 2px 4px;
    }
  `;
}

// Labels, icons, cylinder/stadium shapes and dashed external edges carry
// semantics; categories follow the product's neutral palette.
const LIGHT_SEMANTIC: SemanticPalette = {
  ui: ["#ffffff", "#525252", "#171717"],
  ts: ["#f5f5f5", "#525252", "#171717"],
  py: ["#e5e5e5", "#525252", "#171717"],
  infra: ["#f5f5f5", "#737373", "#171717"],
  store: ["#e5e5e5", "#525252", "#171717"],
  ext: ["#ffffff", "#737373", "#404040"],
};

const DARK_SEMANTIC: SemanticPalette = {
  ui: ["#171717", "#a3a3a3", "#fafafa"],
  ts: ["#262626", "#a3a3a3", "#fafafa"],
  py: ["#404040", "#a3a3a3", "#fafafa"],
  infra: ["#262626", "#a3a3a3", "#fafafa"],
  store: ["#404040", "#a3a3a3", "#fafafa"],
  ext: ["#171717", "#a3a3a3", "#e5e5e5"],
};

const SHARED = {
  startOnLoad: false,
  securityLevel: "loose",
  look: "classic",
  theme: "base",
  flowchart: {
    curve: "linear",
    nodeSpacing: 40,
    rankSpacing: 50,
    padding: 16,
    htmlLabels: true,
  },
  sequence: { actorMargin: 48, messageMargin: 32, mirrorActors: false },
} as const;

export const MERMAID_LIGHT = {
  ...SHARED,
  themeCSS: semanticThemeCss(LIGHT_SEMANTIC),
  themeVariables: {
    fontFamily: FONT_STACK,
    fontSize: "16px",
    primaryColor: "#f5f5f5",
    primaryBorderColor: "#525252",
    primaryTextColor: "#171717",
    secondaryColor: "#f5f5f5",
    secondaryBorderColor: "#525252",
    tertiaryColor: "#fafafa",
    tertiaryBorderColor: "#a3a3a3",
    mainBkg: "#f5f5f5",
    nodeBorder: "#525252",
    lineColor: "#525252",
    textColor: "#404040",
    titleColor: "#171717",
    edgeLabelBackground: "#f5f5f5",
    clusterBkg: "#fafafa",
    clusterBorder: "#d4d4d4",
    actorBkg: "#f5f5f5",
    actorBorder: "#525252",
    actorTextColor: "#171717",
    actorLineColor: "#737373",
    signalColor: "#525252",
    signalTextColor: "#404040",
    labelBoxBkgColor: "#e5e5e5",
    labelBoxBorderColor: "#525252",
    labelTextColor: "#171717",
    loopTextColor: "#171717",
    noteBkgColor: "#fef9c3",
    noteBorderColor: "#eab308",
    noteTextColor: "#713f12",
    activationBkgColor: "#e5e5e5",
    activationBorderColor: "#525252",
    sequenceNumberColor: "#ffffff",
    attributeBackgroundColorEven: "#fafafa",
    attributeBackgroundColorOdd: "#ffffff",
  },
};

export const MERMAID_DARK = {
  ...SHARED,
  themeCSS: semanticThemeCss(DARK_SEMANTIC),
  themeVariables: {
    fontFamily: FONT_STACK,
    fontSize: "16px",
    primaryColor: "#262626",
    primaryBorderColor: "#a3a3a3",
    primaryTextColor: "#fafafa",
    secondaryColor: "#262626",
    secondaryBorderColor: "#a3a3a3",
    tertiaryColor: "#171717",
    tertiaryBorderColor: "#737373",
    mainBkg: "#262626",
    nodeBorder: "#a3a3a3",
    lineColor: "#a3a3a3",
    textColor: "#e5e5e5",
    titleColor: "#fafafa",
    edgeLabelBackground: "#262626",
    clusterBkg: "#171717",
    clusterBorder: "#525252",
    actorBkg: "#262626",
    actorBorder: "#a3a3a3",
    actorTextColor: "#fafafa",
    actorLineColor: "#a3a3a3",
    signalColor: "#e5e5e5",
    signalTextColor: "#e5e5e5",
    labelBoxBkgColor: "#404040",
    labelBoxBorderColor: "#a3a3a3",
    labelTextColor: "#fafafa",
    loopTextColor: "#fafafa",
    noteBkgColor: "#422006",
    noteBorderColor: "#d97706",
    noteTextColor: "#fde68a",
    activationBkgColor: "#404040",
    activationBorderColor: "#a3a3a3",
    sequenceNumberColor: "#171717",
    attributeBackgroundColorEven: "#262626",
    attributeBackgroundColorOdd: "#171717",
  },
};
