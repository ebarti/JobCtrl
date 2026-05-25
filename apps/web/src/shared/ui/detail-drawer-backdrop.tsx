import type { MouseEvent, ReactNode } from "react";

export interface DetailDrawerBackdropProps {
  children: ReactNode;
  onDismiss: () => void;
}

export function DetailDrawerBackdrop({
  children,
  onDismiss,
}: DetailDrawerBackdropProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onDismiss();
    }
  };

  return (
    <div className="drawer-backdrop" onClick={handleClick}>
      {children}
    </div>
  );
}
