import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { uniqueSlug } from "./slugs";
import { logAudit } from "./audit";
import { assertText } from "./validation";

/**
 * Self-service onboarding (MILESTONES M0): any verified user can create an
 * organization and becomes its owner.
 */
export async function createOrg(
  ctx: MutationCtx,
  user: Doc<"users">,
  name: string,
): Promise<Doc<"organizations">> {
  const trimmed = assertText(name, { label: "Organization name", max: 100 });
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

  // Org owner/admin see every event in the org.
  const orgRows = await Promise.all(
    memberships.map(async (m) => {
      const [org, events] = await Promise.all([
        ctx.db.get("organizations", m.orgId),
        ctx.db
          .query("events")
          .withIndex("by_orgId", (q) => q.eq("orgId", m.orgId))
          .take(100),
      ]);
      return org === null ? null : { org, role: m.role, events };
    }),
  );

  const result: HomeOrg[] = [];
  const seenOrgIds = new Set<string>();
  for (const row of orgRows) {
    if (row === null) continue;
    seenOrgIds.add(row.org._id);
    result.push(row);
  }

  // Event-scoped memberships in orgs the user isn't an org member of.
  const scopedByOrg = new Map<string, typeof eventMemberships>();
  for (const em of eventMemberships) {
    if (seenOrgIds.has(em.orgId)) continue;
    const list = scopedByOrg.get(em.orgId) ?? [];
    list.push(em);
    scopedByOrg.set(em.orgId, list);
  }
  const scopedRows = await Promise.all(
    [...scopedByOrg].map(async ([orgId, ems]) => {
      const [org, events] = await Promise.all([
        ctx.db.get("organizations", orgId as Doc<"organizations">["_id"]),
        Promise.all(ems.map((em) => ctx.db.get("events", em.eventId))),
      ]);
      if (org === null) return null;
      return {
        org,
        role: null,
        events: events.filter((e): e is Doc<"events"> => e !== null),
      };
    }),
  );
  for (const row of scopedRows) {
    if (row !== null) result.push(row);
  }
  return result;
}
