import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { uniqueSlug } from "./slugs";
import { logAudit } from "./audit";

/**
 * Self-service onboarding (MILESTONES M0): any verified user can create an
 * organization and becomes its owner.
 */
export async function createOrg(
  ctx: MutationCtx,
  user: Doc<"users">,
  name: string,
): Promise<Doc<"organizations">> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new ConvexError({
      code: "invalid_name",
      message: "Organization name must be 1-100 characters.",
    });
  }
  const slug = await uniqueSlug(ctx, "organizations", trimmed);
  const orgId = await ctx.db.insert("organizations", {
    name: trimmed,
    slug,
    createdBy: user._id,
  });
  await ctx.db.insert("members", {
    orgId,
    userId: user._id,
    role: "owner",
  });
  await logAudit(ctx, {
    orgId,
    actorUserId: user._id,
    action: "org.create",
    targetType: "organization",
    targetId: orgId,
  });
  const org = await ctx.db.get("organizations", orgId);
  if (org === null) throw new Error("unreachable: org just inserted");
  return org;
}

export type HomeOrg = {
  org: Doc<"organizations">;
  role: "owner" | "admin" | null;
  events: Array<Doc<"events">>;
};

/**
 * My StageStack home: every org the user belongs to (org-wide or via event
 * membership) with the events they can see in each.
 */
export async function myHome(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<HomeOrg[]> {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(50);
  const eventMemberships = await ctx.db
    .query("eventMembers")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(200);

  const result: HomeOrg[] = [];
  const seenOrgIds = new Set<string>();

  for (const m of memberships) {
    const org = await ctx.db.get("organizations", m.orgId);
    if (org === null) continue;
    seenOrgIds.add(org._id);
    // Org owner/admin see every event in the org.
    const events = await ctx.db
      .query("events")
      .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
      .take(100);
    result.push({ org, role: m.role, events });
  }

  // Event-scoped memberships in orgs the user isn't an org member of.
  const scopedByOrg = new Map<string, typeof eventMemberships>();
  for (const em of eventMemberships) {
    if (seenOrgIds.has(em.orgId)) continue;
    const list = scopedByOrg.get(em.orgId) ?? [];
    list.push(em);
    scopedByOrg.set(em.orgId, list);
  }
  for (const [orgId, ems] of scopedByOrg) {
    const org = await ctx.db.get(
      "organizations",
      orgId as Doc<"organizations">["_id"],
    );
    if (org === null) continue;
    const events: Array<Doc<"events">> = [];
    for (const em of ems) {
      const event = await ctx.db.get("events", em.eventId);
      if (event !== null) events.push(event);
    }
    result.push({ org, role: null, events });
  }
  return result;
}
