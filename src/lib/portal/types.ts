export interface Pack { id: number }
export interface Version { id: number; packs: Pack[] }
export interface Asset {
  id: number;
  author: string;
  name: string;
  state: string;
  is_disabled: boolean;
  disabled_reason: string | null;
  versions: Version[];
}
export interface Grant {
  grant_id: number;
  transferable: boolean;
  updated_since_last_download: boolean;
  download_url: string;
  received_at: string;
  updated_at: string;
  asset: Asset;
}
export interface Me {
  id: number;
  username: string;
  email: string;
  avatar_url: string;
  groups: unknown[];
  has_patreon: boolean;
  has_portal_subscription: boolean;
}
export interface GrantsResponse {
  grants: Grant[];
  page: number;
  page_count: number;
  item_count: number;
}
