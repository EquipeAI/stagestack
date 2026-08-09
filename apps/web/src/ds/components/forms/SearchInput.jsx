import React from "react";
import { Icon } from "../core/Icon.jsx";

export function SearchInput({ shortcut, size = "sm", className = "", ...rest }) {
  return (
    <span className={["ss-search", className].filter(Boolean).join(" ")}>
      <Icon name="search" size={14} />
      <input
        type="search"
        className={["ss-input", "ss-input--" + size].join(" ")}
        // Mobile keyboard: a search field should offer a "Search" return key,
        // and must not autocapitalise or autocorrect a query — on iOS, typing a
        // speaker's surname or a session slug otherwise gets "helpfully"
        // rewritten into a different word and the search silently misses.
        inputMode="search"
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...rest}
      />
      {/* The keyboard shortcut hint is meaningless on a device with no
          physical keyboard, and it overlaps the native clear (×) button that
          type="search" draws on iOS. */}
      {shortcut ? <kbd className="ss-search__kbd">{shortcut}</kbd> : null}
    </span>
  );
}
