export const COLOR_SCHEMES = [
  { id: "graphite", label: "Graphite · default" },
  { id: "cobalt", label: "Cobalt" },
  { id: "teal", label: "Teal" },
  { id: "forest", label: "Forest" },
  { id: "indigo", label: "Indigo" },
  { id: "plum", label: "Plum" },
  { id: "rose", label: "Rose" },
  { id: "terracotta", label: "Terracotta" },
  { id: "amber", label: "Amber" },
  { id: "ocean", label: "Ocean" },
] as const;

export const FONT_SCHEMES = [
  { id: "geist", label: "Geist · default" },
  { id: "inter", label: "Inter" },
  { id: "manrope", label: "Manrope" },
  { id: "dm", label: "DM Sans" },
  { id: "plex", label: "IBM Plex Sans" },
  { id: "source", label: "Source Sans 3" },
  { id: "work", label: "Work Sans" },
  { id: "lato", label: "Lato" },
  { id: "literary", label: "Merriweather + Inter" },
  { id: "editorial", label: "Newsreader + DM Sans" },
] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number]["id"];
export type FontScheme = (typeof FONT_SCHEMES)[number]["id"];

export function isColorScheme(value: unknown): value is ColorScheme {
  return COLOR_SCHEMES.some((scheme) => scheme.id === value);
}

export function isFontScheme(value: unknown): value is FontScheme {
  return FONT_SCHEMES.some((scheme) => scheme.id === value);
}
