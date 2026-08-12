import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * A collapsible section.
 *
 * Built on native <details>/<summary> on purpose: the disclosure semantics,
 * the keyboard behaviour and the accessible name all come from the platform.
 *
 * TRULY uncontrolled, and that word is load-bearing. Passing `open={defaultOpen}`
 * looks uncontrolled but is not: React writes the `open` property on EVERY
 * render, so any parent re-render — and the control center's parent re-renders
 * once a minute, because `now` ticks — silently reopens a section the reader
 * deliberately collapsed. So the element's own state is the source of truth,
 * `onToggle` mirrors it back into React, and every subsequent render writes the
 * value the DOM already has.
 *
 * `defaultOpen` (not `open`) because collapsing a section is the reader's
 * decision, not the page's. Nothing about it is persisted anywhere.
 */
export function Panel({
  title,
  subtitle,
  meta,
  defaultOpen = true,
  className = "",
  children,
  onToggle,
  ...rest
}) {
  const cls = ["ss-panel", className].filter(Boolean).join(" ");
  // Initial value only — never re-derived from the prop, or a `defaultOpen`
  // that changes identity would yank the section back open under the reader.
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <details
      className={cls}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (onToggle) onToggle(event);
      }}
      {...rest}
    >
      <summary className="ss-panel__summary">
        <Icon name="chevron-right" size={16} className="ss-panel__chevron" />
        <span className="ss-panel__titles">
          <span className="ss-panel__title">{title}</span>
          {subtitle ? (
            <span className="ss-panel__subtitle">{subtitle}</span>
          ) : null}
        </span>
        {meta ? <span className="ss-panel__meta">{meta}</span> : null}
      </summary>
      <div className="ss-panel__body">{children}</div>
    </details>
  );
}
