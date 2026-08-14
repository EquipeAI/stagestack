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
export const vParticipantState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);
