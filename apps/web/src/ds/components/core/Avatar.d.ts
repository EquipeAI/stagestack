import * as React from "react";
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Full name — drives initials and the tooltip. */
  name?: string;
  /** Headshot URL. Falls back to initials when absent (common pre-task-completion). */
  src?: string;
  size?: number;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
export interface AvatarGroupProps {
  people: Array<{ name: string; src?: string }>;
  size?: number;
  max?: number;
}
export declare function AvatarGroup(props: AvatarGroupProps): JSX.Element;
