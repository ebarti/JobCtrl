const REPOSITORY_URL = "https://github.com/ebarti/JobCtrl";

interface LegalNoticeProps {
  readonly className?: string;
}

export function LegalNotice({ className }: LegalNoticeProps) {
  return (
    <footer className={className} data-typography="metadata">
      <span>Copyright © 2026 Eloi Barti</span>
      <span>
        <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
          AGPL-3.0-only
        </a>
        {" · "}
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
          Source code
        </a>
      </span>
    </footer>
  );
}
