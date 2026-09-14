import { v } from "convex/values";
import { typedV } from "convex-helpers/validators";
import schema from "../schema";

// `vv` is `v` plus type-safe `vv.id(table)` and `vv.doc(table)` (doc validator
// including system fields) — used for function `returns` validators.
export const vv = typedV(schema);

/**
 * A speaker's participation state on one session. Mirrors
 * `sessionParticipants.state` in the schema; declared once here because five
 * public modules return it and five copies is five chances to drift.
 */
/**
 * A proposal's lifecycle status. Mirrors `proposals.status` in the schema;
 * declared once here because both the CFP surface and the agent tool surface
 * accept it as a filter, and two copies is one chance to drift.
 */
export const vProposalStatus = v.union(
  v.literal("draft"),
  v.literal("pending"),
  v.literal("acceptQueue"),
  v.literal("declineQueue"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

export const vParticipantState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

/**
 * A speaker task's review state. Mirrors `taskInstances.status` in the schema;
 * declared once here for the same reason as the two above — the task surface
 * and the agent tool surface both return it, and a second copy is a chance to
 * drift.
 */
export const vTaskStatus = v.union(
  v.literal("pending"),
  v.literal("provided"),
  v.literal("changesRequested"),
  v.literal("approved"),
  v.literal("complete"),
  v.literal("notApplicable"),
);
