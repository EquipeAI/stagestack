import * as React from "react";
export interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  title: React.ReactNode;
  /** One line stating exactly what will happen and to whom. */
  description?: React.ReactNode;
  /** Max width in px. 480 confirm · 640 form · 860 preview. */
  width?: number;
  onClose?: () => void;
  /** Wrap in a `.ss-dialog-host` ancestor to keep the scrim inside a demo box instead of the viewport. */
  footer?: React.ReactNode;
}
export declare function Dialog(props: DialogProps): JSX.Element;
