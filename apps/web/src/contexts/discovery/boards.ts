const BOARD_LABELS: Readonly<Record<string, string>> = { indeed: "Indeed", linkedin: "LinkedIn", glassdoor: "Glassdoor", zip_recruiter: "ZipRecruiter", google: "Google Jobs", bayt: "Bayt", bdjobs: "Bdjobs", naukri: "Naukri" };

export function boardLabel(board: string): string {
  return BOARD_LABELS[board] ?? board;
}
