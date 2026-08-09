import React from "react";
import { IconButton } from "../core/IconButton.jsx";

// Anything that can take focus inside the surface. Used both to move focus in
// on open and to work out the ends of the Tab cycle.
const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visibleFocusables(surface) {
  return Array.prototype.filter.call(
    surface.querySelectorAll(FOCUSABLE),
    function (el) {
      return el.getClientRects().length > 0;
    },
  );
}

// How many dialogs currently want the page behind them frozen. Nested dialogs
// (a confirm on top of a detail sheet) must not have the inner one restore
// scrolling when it closes, so the lock is released on the last one out.
let scrollLocks = 0;
let restoreScroll = null;

/**
 * Freeze the document behind an open dialog.
 *
 * `overflow:hidden` on <body> alone does not hold on iOS Safari — the page
 * still rubber-bands, and worse, Safari discards the scroll position, so
 * closing the dialog dumps you at the top of a long list. Pinning the body
 * with `position:fixed` at a negative offset keeps the rendered position and
 * genuinely stops touch scrolling; the offset is read back on release.
 */
function lockBodyScroll() {
  scrollLocks += 1;
  if (scrollLocks > 1) return;
  const y = window.scrollY;
  const body = document.body;
  restoreScroll = {
    y,
    top: body.style.top,
    position: body.style.position,
    width: body.style.width,
    overflowY: body.style.overflowY,
  };
  body.style.position = "fixed";
  body.style.top = `-${y}px`;
  // Without this the body collapses to its content width once it is taken out
  // of flow, which reflows the frozen page visibly behind the scrim.
  body.style.width = "100%";
  // Keeps the scrollbar gutter on desktop so the page does not shift sideways.
  body.style.overflowY = "scroll";
}

function unlockBodyScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks > 0 || restoreScroll === null) return;
  const { y, top, position, width, overflowY } = restoreScroll;
  restoreScroll = null;
  const body = document.body;
  body.style.position = position;
  body.style.top = top;
  body.style.width = width;
  body.style.overflowY = overflowY;
  // Instant, not smooth: this is restoring a position, not a navigation.
  // Guarded because jsdom (and very old Safari) has no options-object form.
  if (typeof window.scrollTo === "function") {
    try {
      window.scrollTo({ top: y, behavior: "instant" });
    } catch {
      window.scrollTo(0, y);
    }
  }
}

export function Dialog({ open = true, ...rest }) {
  // The surface owns the focus/Escape effects, so mounting it only while open
  // keeps those hooks unconditional and ties them to the dialog's lifetime.
  if (!open) return null;
  return <DialogSurface {...rest} />;
}

function DialogSurface({ title, description, width = 480, onClose, footer, className = "", children, ...rest }) {
  const surfaceRef = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const titleId = React.useId();
  const descId = React.useId();

  // Focus moves in on open and back to whatever opened the dialog on close. An
  // element that already claimed focus during the same commit (autoFocus) wins.
  React.useEffect(function () {
    const opener = document.activeElement;
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      const first = visibleFocusables(surface)[0];
      // `preventScroll` matters on a phone: focusing the first field of a
      // bottom sheet otherwise scrolls the frozen page behind the scrim.
      (first || surface).focus({ preventScroll: true });
    }
    return function () {
      if (
        opener &&
        typeof opener.focus === "function" &&
        document.contains(opener)
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // The page behind the scrim must not scroll while the dialog is up.
  React.useEffect(function () {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);

  // Escape closes and Tab cycles inside the surface. Both stop propagation so a
  // dialog rendered inside another one — and the app's document-level Escape
  // handler — never act on a key this dialog already answered.
  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (!closeRef.current) return;
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const surface = surfaceRef.current;
    if (!surface) return;
    e.stopPropagation();
    const items = visibleFocusables(surface);
    const active = document.activeElement;
    if (items.length === 0) {
      e.preventDefault();
      surface.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (active === first || active === surface)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || active === surface)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="ss-dialog__scrim" onClick={onClose}>
      <div
        ref={surfaceRef}
        className={["ss-dialog", className].filter(Boolean).join(" ")}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={function (e) { e.stopPropagation(); }}
        {...rest}
      >
        <header className="ss-dialog__header">
          <div style={{ flex: 1 }}>
            <div className="ss-dialog__title" id={titleId}>{title}</div>
            {description ? <p className="ss-dialog__desc" id={descId}>{description}</p> : null}
          </div>
          {onClose ? <IconButton icon="x" label="Close" size="sm" onClick={onClose} /> : null}
        </header>
        {children ? <div className="ss-dialog__body">{children}</div> : null}
        {footer ? <footer className="ss-dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
