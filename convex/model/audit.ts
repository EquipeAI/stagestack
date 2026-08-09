import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Every consequential action writes one audit row (MILESTONES M0 trust
// boundary: audit the initiating user, agent-assisted action, and result).
export async function logAudit(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventId?: Id<"events">;
    actorUserId: Id<"users">;
    viaAgent?: boolean;
    action: string;
    targetType?: string;
    targetId?: string;
    meta?: unknown;
  },
): Promise<void> {
  await ctx.db.insert("auditLog", entry);
}
