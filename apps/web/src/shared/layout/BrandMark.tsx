import { cn } from "../lib/cn.js";

interface BrandMarkProps {
  readonly showWordmark?: boolean;
  readonly showTagline?: boolean;
  readonly className?: string;
}

export function BrandMark({ showWordmark = true, showTagline = false, className }: BrandMarkProps) {
  return (
    <span className={cn("brand-lockup", className)}>
      <BrandGlyph />
      {showWordmark ? (
        <span className="brand-lockup__text">
          <span className="side-rail__wordmark" data-typography="component-title">
            Job<span className="side-rail__wordmark-accent">Ctrl</span>
          </span>
          {showTagline ? (
            <span className="side-rail__tagline" data-typography="metadata">
              Plan. Apply. Track. Succeed.
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function BrandGlyph() {
  return (
    <svg
      className="brand-mark-svg"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="brandCheckGradient" x1="9" y1="20" x2="25" y2="7" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <polygon
        points="16,15.5 27,21 16,26.5 5,21"
        fill="#c4b5fd"
        stroke="#c4b5fd"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <polygon
        points="16,11 27,16.5 16,22 5,16.5"
        fill="#ddd6fe"
        stroke="#ddd6fe"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 16 L14.6 20.2 L24 8.6"
        stroke="url(#brandCheckGradient)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
