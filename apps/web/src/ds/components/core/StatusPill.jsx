import React from "react";
import { Badge } from "./Badge.jsx";

/** The single source of truth for how a StageStack workflow state is coloured. */
export const STATUS_TONES = {
  draft: "neutral",
  private: "neutral",
  withdrawn: "neutral",
  "not applicable": "neutral",
  submitted: "info",
  "under review": "info",
  "awaiting response": "info",
  "awaiting acknowledgement": "info",
  "awaiting review": "info",
  scheduled: "info",
  accepted: "success",
  confirmed: "success",
  acknowledged: "success",
  approved: "success",
  ready: "success",
  published: "success",
  complete: "success",
  provided: "attention",
  "needs attention": "attention",
  overdue: "attention",
  "changes requested": "attention",
  deferred: "attention",
  declined: "blocked",
  blocked: "blocked",
  conflict: "blocked",
  cancelled: "blocked",
  "unpublished": "neutral"
};

export function StatusPill({ status, size = "sm", tone, ...rest }) {
  const key = String(status || "").toLowerCase();
  return (
    <Badge tone={tone || STATUS_TONES[key] || "neutral"} size={size} dot {...rest}>
      {status}
    </Badge>
  );
}
