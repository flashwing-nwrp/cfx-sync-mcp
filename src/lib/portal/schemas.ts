import { z } from "zod";

export const PackSchema = z.object({ id: z.number() });
export const VersionSchema = z.object({ id: z.number(), packs: z.array(PackSchema) });
export const AssetSchema = z.object({
  id: z.number(),
  author: z.string(),
  name: z.string(),
  state: z.string(),
  is_disabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  versions: z.array(VersionSchema),
});
export const GrantSchema = z.object({
  grant_id: z.number(),
  transferable: z.boolean(),
  updated_since_last_download: z.boolean(),
  download_url: z.string(),
  received_at: z.string(),
  updated_at: z.string(),
  asset: AssetSchema,
});
export const MeSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string(),
  avatar_url: z.string(),
  groups: z.array(z.unknown()),
  has_patreon: z.boolean(),
  has_portal_subscription: z.boolean(),
});

// IMPORTANT: `grant_transfers` is .omit()-ed at the boundary. The field
// never reaches any tool output. See spec Decision D24.
export const GrantsResponseSchema = z
  .object({
    grants: z.array(GrantSchema),
    grant_transfers: z.array(z.unknown()).optional(), // accept, then strip
    page: z.number(),
    page_count: z.number(),
    item_count: z.number(),
  })
  .transform(({ grant_transfers: _stripped, ...rest }) => rest);
