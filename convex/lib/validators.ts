import { typedV } from "convex-helpers/validators";
import schema from "../schema";

// `vv` is `v` plus type-safe `vv.id(table)` and `vv.doc(table)` (doc validator
// including system fields) — used for function `returns` validators.
export const vv = typedV(schema);
