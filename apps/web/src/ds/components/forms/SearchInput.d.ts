import * as React from "react";
export interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Keyboard hint rendered on the trailing edge, e.g. "/". */
  shortcut?: string;
  size?: "sm" | "md" | "lg";
}
export declare function SearchInput(props: SearchInputProps): JSX.Element;
