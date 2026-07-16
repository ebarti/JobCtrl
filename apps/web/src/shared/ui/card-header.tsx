import type { ReactNode } from "react";

import {
  CardAction,
  CardHeader as CardHeaderPrimitive,
  CardTitle,
} from "./card.js";

export interface CardHeaderProps {
  title: string;
  meta?: ReactNode;
}

/**
 * Compatibility adapter for legacy `.card` sections. New card surfaces should
 * compose the primitives from `card.tsx` directly.
 */
export function CardHeader({ title, meta }: CardHeaderProps) {
  return (
    <CardHeaderPrimitive className="card-hd">
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
      {meta ? (
        <CardAction>
          <span className="meta">{meta}</span>
        </CardAction>
      ) : null}
    </CardHeaderPrimitive>
  );
}
