import type { QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : "untitled";
}

export function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) {
    throw new ConvexError({
      code: "invalid_slug",
      message:
        "Slugs are 1-60 lowercase letters, digits, and hyphens (no leading/trailing hyphen).",
    });
  }
}

type SlugTable = "organizations" | "events";

async function slugTaken(
  ctx: QueryCtx,
  table: SlugTable,
  slug: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query(table)
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  return existing !== null;
}

/** Derive a unique slug from a display name, suffixing -2, -3, … on collision. */
export async function uniqueSlug(
  ctx: QueryCtx,
  table: SlugTable,
  name: string,
): Promise<string> {
  const base = slugify(name);
  if (!(await slugTaken(ctx, table, base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await slugTaken(ctx, table, candidate))) return candidate;
  }
  throw new ConvexError({
    code: "slug_exhausted",
    message: "Could not find a free slug; pick one explicitly.",
  });
}
