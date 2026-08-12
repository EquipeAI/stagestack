import React from "react";
import { Icon } from "../core/Icon.jsx";

// The horizontal tab strip. It has always carried role="tablist"/role="tab",
// which is a PROMISE about keyboard behaviour that this component did not keep
// until W9: a screen-reader user told "tab, 3 of 8" expects the arrow keys to
// move between them and Tab to leave the strip entirely. Instead every tab was
// its own tab stop and the arrows did nothing — eight stops to cross a strip,
// and the announced pattern lying about how to drive it. (W6 flagged this and
// deferred it; the routed workspaces made the strip load-bearing, so it is
// closed here, for every consumer at once.)
//
// The implementation is the ARIA Authoring Practices tabs pattern:
//   · roving tabindex — exactly ONE tab is in the page's tab order, the
//     selected one, so Tab enters the strip once and Tab again leaves it;
//   · ArrowLeft/ArrowRight move by one and WRAP, Home/End jump to the ends;
//   · automatic activation — moving selects. That is the recommended default
//     when switching is cheap, and every panel here is already rendered from
//     local state or a URL param, so there is nothing to wait for.
//
// Focus is moved imperatively because selection is the caller's state: after
// `onChange` the newly selected button is the one that must hold focus, and
// re-rendering alone would leave focus on a button that just became tabindex
// -1. The refs are keyed by tab id, not by index, so a strip whose tabs change
// shape cannot move focus to the wrong control.

export function Tabs({ tabs = [], value, onChange, variant = "underline", className = "", ...rest }) {
  const refs = React.useRef(new Map());

  // The tab that owns the page's tab stop. Falling back to the first tab
  // matters: if `value` names nothing (a stale URL, a loading parent), the
  // strip must still be reachable by Tab rather than becoming a dead region
  // with no tab stop at all.
  const selectedIndex = tabs.findIndex(function (t) { return t.id === value; });
  const rovingIndex = selectedIndex === -1 ? 0 : selectedIndex;

  function move(nextIndex) {
    const next = tabs[nextIndex];
    if (!next) return;
    if (onChange) onChange(next.id);
    const node = refs.current.get(next.id);
    if (node) node.focus();
  }

  function onKeyDown(e) {
    const count = tabs.length;
    if (count === 0) return;
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        move((rovingIndex + 1) % count);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move((rovingIndex - 1 + count) % count);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(count - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div className={["ss-tabs", variant === "pill" ? "ss-tabs--pill" : "", className].filter(Boolean).join(" ")} role="tablist" {...rest}>
      {tabs.map(function (t, i) {
        return (
          <button
            type="button"
            key={t.id}
            role="tab"
            className="ss-tab"
            data-active={value === t.id}
            aria-selected={value === t.id}
            tabIndex={i === rovingIndex ? 0 : -1}
            ref={function (node) {
              if (node) refs.current.set(t.id, node);
              else refs.current.delete(t.id);
            }}
            onKeyDown={onKeyDown}
            onClick={function () { if (onChange) onChange(t.id); }}
          >
            {t.icon ? <Icon name={t.icon} size={14} /> : null}
            {t.label}
            {t.count != null ? <span className="ss-tab__count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
