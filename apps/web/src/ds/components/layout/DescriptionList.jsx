import React from "react";

export function DescriptionList({ items = [], stacked = false, className = "", ...rest }) {
  return (
    <dl className={["ss-dl", stacked ? "ss-dl--stacked" : "", className].filter(Boolean).join(" ")} {...rest}>
      {items.map(function (it, i) {
        return (
          <React.Fragment key={i}>
            <dt>{it.term}</dt>
            <dd>{it.value}</dd>
          </React.Fragment>
        );
      })}
    </dl>
  );
}
