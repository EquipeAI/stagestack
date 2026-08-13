import React from "react";
import { Button } from "../core/Button.jsx";

// The row-overflow menu (W12). A table row shows at most two actions; the rest
// live here.
//
// The W6 audit named menus as the one open piece of ground in the keyboard
// story, so this is a real `role="menu"` with real roving focus: exactly one
// item is a tab stop at a time (`tabIndex=0` on the active one, `-1` on the
// rest), arrows move between them and wrap, Home/End jump, Escape closes and
// puts focus back on the trigger, and tabbing out in EITHER direction closes
// it — including Shift+Tab onto the trigger itself, which is inside the menu's
// own container and would otherwise leave a menu visibly refusing to close.

export function MenuButton({
  label,
  icon = "ellipsis",
  iconRight,
  variant = "ghost",
  size = "sm",
  align = "end",
  width = "14rem",
  disabled = false,
  items = [],
  className = "",
  // The trigger's own accessible name (W2). A menu whose label is a value —
  // "Inbox", a view name, a selected filter — reads as that word and nothing
  // else, so the caller can say what the word IS. Taken off `rest` on purpose:
  // it belongs to the button, not to the wrapper.
  "aria-label": ariaLabel,
  ...rest
}) {
  const [open, setOpen] = React.useState(false);
  // The item that currently owns the menu's single tab stop.
  const [activeId, setActiveId] = React.useState(null);
  const hostRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const menuId = React.useId();
  const triggerId = React.useId();
  const live = items.filter(Boolean);
  const enabled = live.filter((item) => !item.disabled);
  // Whichever item is active, or the first one that can be — never nothing, or
  // the menu would have no tab stop at all.
  const active =
    enabled.find((item) => item.id === activeId)?.id ?? enabled[0]?.id ?? null;

  const nodes = React.useCallback(function () {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.prototype.slice.call(
      menu.querySelectorAll("[role='menuitem']:not([disabled])")
    );
  }, []);

  const close = React.useCallback(function (returnFocus) {
    setOpen(false);
    setActiveId(null);
    if (returnFocus !== false) triggerRef.current?.focus();
  }, []);

  // Focus lands INSIDE the menu on open — otherwise the first arrow press goes
  // to the page and the menu is only openable, not usable.
  React.useEffect(
    function () {
      if (!open) return;
      nodes()[0]?.focus();
      const onPointerDown = (event) => {
        if (hostRef.current?.contains(event.target) === true) return;
        setOpen(false);
        setActiveId(null);
      };
      document.addEventListener("mousedown", onPointerDown);
      return () => document.removeEventListener("mousedown", onPointerDown);
    },
    [open, nodes]
  );

  const move = (delta) => {
    const list = nodes();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement);
    const next = at < 0 ? 0 : (at + delta + list.length) % list.length;
    const node = list[next];
    node?.focus();
    if (node) setActiveId(node.dataset.itemId ?? null);
  };

  const focusEdge = (which) => {
    const list = nodes();
    const node = which === "first" ? list[0] : list[list.length - 1];
    node?.focus();
    if (node) setActiveId(node.dataset.itemId ?? null);
  };

  return (
    <div
      ref={hostRef}
      className={["ss-menu", className].filter(Boolean).join(" ")}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          close();
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          focusEdge(e.key === "Home" ? "first" : "last");
          return;
        }
        if (e.key === "Tab") {
          // A disclosure, not a modal: rather than trapping Tab, let the
          // browser move focus and close once it has landed outside the PANEL.
          // Checked against the panel and not the whole host, because
          // Shift+Tab from the first item lands on the trigger — which is
          // inside the host, and would otherwise keep the menu open behind a
          // focus ring that has already left it.
          window.setTimeout(() => {
            if (menuRef.current?.contains(document.activeElement) !== true) {
              setOpen(false);
              setActiveId(null);
            }
          }, 0);
        }
      }}
      {...rest}
    >
      <Button
        id={triggerId}
        ref={triggerRef}
        variant={variant}
        size={size}
        iconLeft={icon}
        iconRight={iconRight}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={
          ariaLabel ?? (typeof label === "string" ? undefined : "More actions")
        }
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (open || e.key !== "ArrowDown") return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open ? (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-labelledby={triggerId}
          className={`ss-menu__panel ss-menu__panel--${align}`}
          style={{ width }}
        >
          {live.map(function (item) {
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-item-id={item.id}
                // Exactly one tab stop in the menu: roving focus, so Tab
                // leaves the menu rather than walking through it.
                tabIndex={item.id === active ? 0 : -1}
                disabled={item.disabled}
                className={[
                  "ss-menu__item",
                  item.tone === "danger" ? "ss-menu__item--danger" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onFocus={() => setActiveId(item.id)}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
