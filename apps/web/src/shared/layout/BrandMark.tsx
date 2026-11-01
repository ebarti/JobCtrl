import { useId } from "react";
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
  const checkGradientId = useId();

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
        <linearGradient id={checkGradientId} x1="9" y1="20" x2="25" y2="7" gradientUnits="userSpaceOnUse">
          <stop stopColor="color-mix(in oklch, var(--foreground) 75%, var(--background))" />
          <stop offset="1" stopColor="var(--foreground)" />
        </linearGradient>
      </defs>
      <polygon
        points="16,15.5 27,21 16,26.5 5,21"
        fill="color-mix(in oklch, var(--foreground) 26%, var(--background))"
        stroke="color-mix(in oklch, var(--foreground) 26%, var(--background))"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <polygon
        points="16,11 27,16.5 16,22 5,16.5"
        fill="color-mix(in oklch, var(--foreground) 14%, var(--background))"
        stroke="color-mix(in oklch, var(--foreground) 14%, var(--background))"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 16 L14.6 20.2 L24 8.6"
        stroke={`url(#${checkGradientId})`}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
