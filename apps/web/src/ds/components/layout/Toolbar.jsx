import React from "react";

export function Toolbar({ left, right, sunken = false, className = "", children, ...rest }) {
  return (
    <div className={["ss-toolbar", sunken ? "ss-toolbar--sunken" : "", className].filter(Boolean).join(" ")} {...rest}>
      {left}
      {children}
      {right ? <><span className="ss-toolbar__spacer" />{right}</> : null}
    </div>
  );
}
