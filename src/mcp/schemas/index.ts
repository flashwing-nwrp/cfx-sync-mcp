import { z } from "zod";

// Per-tool input/output
export const LoginInput = z.object({ timeoutMinutes: z.number().int().positive().optional() });
export const LoginOutput = z.object({
  username: z.string(),
  cookieCount: z.number(),
  expiresAtHint: z.number().nullable(),
  storageStatePath: z.string(),
});

export const LogoutInput = z.object({});
export const LogoutOutput = z.object({ wiped: z.boolean() });

export const StatusInput = z.object({});
export const StatusOutput = z.object({
  cookiesPresent: z.boolean(),
  cookieAgeMs: z.number().nullable(),
  mappingApproved: z.boolean(),
  deployedCount: z.number(),
  lastPolledAt: z.string().nullable(),
});

export const ListGrantsInput = z.object({
  search: z.string().optional(),
  force: z.boolean().optional(),
});
export const ListGrantsOutput = z.object({
  grants: z.array(z.object({
    grantId: z.number(), assetName: z.string(), author: z.string(),
    updatedAt: z.string(), isDisabled: z.boolean(),
  })),
  stale: z.boolean(),
});

export const CheckUpdatesInput = z.object({ force: z.boolean().optional() });
export const CheckUpdatesOutput = z.object({
  updated: z.array(z.object({
    grantId: z.number(), slug: z.string(), assetName: z.string(),
    reason: z.enum(["version_bump", "never_deployed", "force_refresh"]),
  })),
  stale: z.boolean(),
});

export const DiscoverInput = z.object({
  layout: z.enum(["categorized", "flat"]).optional(),
  force: z.boolean().optional(),
});
export const DiscoverOutput = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  entries: z.record(z.object({
    slug: z.string(), target: z.string(), disabled: z.boolean(),
    assetName: z.string(), discoveredTier: z.number(), discoveredConfidence: z.number(),
    notes: z.string().optional(),
  })),
  newInstalls: z.array(z.number()),
  orphaned: z.array(z.string()),
  caveats: z.array(z.string()),
});

export const ApproveMappingInput = z.object({
  proposed: DiscoverOutput,
});
export const ApproveMappingOutput = z.object({
  path: z.string(),
  entriesCount: z.number(),
});

export const DownloadAssetInput = z.object({
  grantId: z.number(),
  packIndex: z.number().int().nonnegative().optional(),
  force: z.boolean().optional(),
});
export const DownloadAssetOutput = z.object({
  cachedZipPath: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  versionId: z.number(),
  packId: z.number(),
});

export const DeployAssetInput = z.object({
  grantId: z.number(),
  dryRun: z.boolean().optional(),
  packIndex: z.number().int().nonnegative().optional(),
});
export const DeployAssetOutput = z.object({
  slug: z.string(),
  deployedPath: z.string(),
  backupPath: z.string().nullable(),
  suggestedServerCfg: z.string().nullable(),
  suggestedRestartCommand: z.string(),
  dryRun: z.boolean(),
});

export const SyncAllInput = z.object({
  dryRun: z.boolean().optional(),
  only: z.array(z.number()).optional(),
  skip: z.array(z.number()).optional(),
  force: z.boolean().optional(),
});
export const SyncAllOutput = z.object({
  summary: z.object({
    checked: z.number(), changed: z.number(), downloaded: z.number(),
    deployed: z.number(), skipped: z.number(), failed: z.number(),
  }),
  perAsset: z.array(z.object({
    grantId: z.number(), slug: z.string(),
    action: z.enum(["no-change", "downloaded", "deployed", "skipped", "failed"]),
    error: z.object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
      retryable: z.boolean().optional(),
    }).optional(),
  })),
  suggestedRestarts: z.array(z.string()),
});

export const ScanConfigsInput = z.object({
  grantId: z.number().int().positive().optional(),
  all: z.boolean().optional(),
}).strict().refine(
  (v) => !(v.grantId !== undefined && v.all === true),
  { message: "Pass grantId OR all, not both" }
);
export const ScanConfigsOutput = z.object({
  scanned: z.array(z.object({
    grantId: z.number(),
    slug: z.string(),
    preservePaths: z.array(z.string()),
    count: z.number(),
  })),
  totalPreservePaths: z.number(),
  skipped: z.array(z.object({
    grantId: z.number(),
    reason: z.string(),
  })).optional(),
}).strict();

export const RollbackInput = z.object({
  grantId: z.number().optional(),
  slug: z.string().optional(),
  toTimestamp: z.string().optional(),
}).refine((v) => v.grantId !== undefined || v.slug !== undefined, {
  message: "Pass grantId or slug",
});
export const RollbackOutput = z.object({
  restoredPath: z.string(),
  fromBackup: z.string(),
  newRollingBackup: z.string(),
  suggestedRestartCommand: z.string(),
});
