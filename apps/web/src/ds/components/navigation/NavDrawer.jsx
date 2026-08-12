import React from "react";
import { Dialog } from "../feedback/Dialog.jsx";
import { SidebarNav } from "./SidebarNav.jsx";

/**
 * The phone's navigation surface: a full-height drawer holding the same
 * grouped rail the desktop shows.
 *
 * It is a Dialog wearing a different shape, on purpose. `Dialog` already owns
 * the modal mechanics this needs and owns them correctly (audited in W6): it
 * moves focus in on open, traps Tab both ways, closes on Escape, returns focus
 * to the opener, and freezes the page behind the scrim. Re-implementing any of
 * that here would be a second trap to keep right forever. What Dialog's own
 * responsive mode gives — a bottom SHEET under 640px — is the wrong shape for
 * fifteen grouped entries, so the `ss-drawer` class re-anchors the surface to
 * the inline start edge at full height. Same element, same behaviour, and the
 * shape is CSS.
 */
export function NavDrawer({ open = false, id, title, groups = [], activeId, onSelect, onClose, footer }) {
  if (!open) return null;
  return (
    <Dialog
      open
      id={id}
      className="ss-drawer"
      title={title}
      onClose={onClose}
      footer={footer}
    >
      <SidebarNav
        className="ss-sidebar--drawer"
        groups={groups}
        activeId={activeId}
        onSelect={function (id) { if (onSelect) onSelect(id); }}
      />
    </Dialog>
  );
}
