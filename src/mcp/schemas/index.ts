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
    slug: z.string(), target: z.string(),
    assetName: z.string(), discoveredTier: z.number(), discoveredConfidence: z.number(),
    notes: z.string().optional(),
    status: z.enum(["active", "new-install", "disabled"]),
    reviewedByUser: z.boolean(),
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
  needsResolution: z.object({
    fuzzy: z.number(),
    newInstalls: z.number(),
  }),
  nextStep: z.string().optional(),
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

/**
 * Conflict resolution choice (mirrors `ResolutionChoice` in preservation/types.ts
 * but declared here so the MCP schema has no import cycle with lib/preservation).
 */
export const ResolutionChoiceSchema = z.enum([
  "take-live",
  "take-pack",
  "merge-diff3",
  "staged-for-merge",
  "take-live-at-new-path",
  "take-live-at-old-path",
]);

/** Shape of a PlanRow surfaced in the dry-run plan output. */
export const PlanRowSchema = z.object({
  path: z.string(),
  decision: z.enum([
    "take-newPack",
    "preserve-live",
    "take-newPack-rename",
    "drop",
    "conflict",
    "blocker",
  ]),
  rowNumber: z.number(),
  rename: z.object({ oldPath: z.string(), newPath: z.string() }).optional(),
  conflictOptions: z.array(ResolutionChoiceSchema).optional(),
  resolution: ResolutionChoiceSchema.optional(),
  blockerCode: z.enum(["CASE_COLLISION_DETECTED", "ENCRYPTED_TAMPER_DETECTED"]).optional(),
  blockerDetail: z.string().optional(),
  collision: z.object({ lowerPath: z.string(), paths: z.array(z.string()) }).optional(),
  liveSha: z.string().optional(),
  pristineSha: z.string().optional(),
  packSha: z.string().optional(),
});

export const ValidationFailureSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const DeployPlanSchema = z.object({
  rows: z.array(PlanRowSchema),
  blockers: z.array(PlanRowSchema),
  conflicts: z.array(PlanRowSchema),
  packValidationFailures: z.array(ValidationFailureSchema),
});

export const DeployAssetInput = z.object({
  grantId: z.number(),
  dryRun: z.boolean().optional(),
  packIndex: z.number().int().nonnegative().optional(),
  /**
   * Optional per-path conflict resolutions. Keys are repo-relative forward-slash
   * paths (as emitted by hashTree); values are a ResolutionChoice. When a
   * conflict row is missing from this map AND `dryRun` is false, deploy throws
   * `ConflictsUnresolvedError`.
   */
  conflictResolutions: z.record(ResolutionChoiceSchema).optional(),
});
export const DeployAssetOutput = z.object({
  slug: z.string(),
  deployedPath: z.string(),
  backupPath: z.string().nullable(),
  suggestedServerCfg: z.string().nullable(),
  suggestedRestartCommand: z.string(),
  dryRun: z.boolean(),
  /**
   * Full deploy plan. Populated on dryRun OR when `preservationMode !== "legacy"`.
   * Null on the legacy plain-swap path (Phase 1 behavior / `CFX_SYNC_PRESERVE=0`)
   * where no diff is computed.
   */
  plan: DeployPlanSchema.nullable().optional(),
  /** Layer 1 hints from mapping's `preservePaths`; informational only. */
  preservePathsHints: z.array(z.string()).optional(),
  /** Pack-extraction failures surfaced by unzipper (symlinks refused, etc). */
  packValidationFailures: z.array(ValidationFailureSchema).optional(),
  /** Which code path ran. "first-deploy" seeds pristine; "layer-2" runs the full diff. */
  preservationMode: z.enum(["first-deploy", "layer-2", "legacy"]).optional(),
  /** True iff a pristine baseline was captured or rotated in this run. */
  pristineCaptured: z.boolean().optional(),
  /**
   * First-deploy overlay: files that existed in live but NOT in the new pack
   * and were preserved by copying into staging before the swap. Typical
   * contents: operator-injected overlays like triage hooks, custom additions,
   * orphaned files from an older pack version. Only populated on the
   * first-deploy path (real, not dryRun). Undefined/omitted otherwise.
   */
  firstDeployOverlay: z.array(z.string()).optional(),
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

export const ResetPristineInput = z.object({
  grantId: z.number().int().positive().optional(),
  all: z.boolean().optional(),
}).strict().refine(
  (v) => !(v.grantId !== undefined && v.all === true),
  { message: "Pass grantId OR all, not both" }
);
export const ResetPristineOutput = z.object({
  removed: z.array(z.number()),
  orphansGced: z.array(z.number()),
}).strict();

// ---------------------------------------------------------------------------
// Phase 1.6 — cfx_scan_updates (Task 10).
//
// Schema mirrors `ScanUpdatesResult` (src/lib/updates/types.ts) 1:1 so the
// tool layer is purely a shape-forwarding adapter. Three of the four output
// buckets wrap a shared `ResourceSignal` base plus `source`; the fourth
// (`unmapped`) is narrower because log-only signals lack portal context.
// ---------------------------------------------------------------------------

export const ScanUpdatesInput = z.object({
  slug: z.string().optional(),
  grantId: z.number().int().positive().optional(),
  logLines: z.array(z.string()).optional(),
  forcePortal: z.boolean().optional(),
}).refine(
  (d) => !(d.slug !== undefined && d.grantId !== undefined),
  { message: "slug and grantId are mutually exclusive" }
);

const SignalSourceEnum = z.enum(["portal", "log", "portal+log"]);

// ResourceSignal base shape shared by available / suppressed / unknownSource.
// Expressed as an object literal (not a schema) so each bucket can merge its
// own tag fields while keeping field definitions DRY.
const ResourceSignalShape = {
  slug: z.string(),
  grantId: z.number().int().optional(),
  current: z.string().nullable(),
  announced: z.string(),
  releaseNotesUrl: z.string().optional(),
  severityNote: z.string().optional(),
  updatedAt: z.string().optional(),
  boundaryKnown: z.boolean(),
};

export const ScanUpdatesOutput = z.object({
  available: z.array(z.object({
    ...ResourceSignalShape,
    source: SignalSourceEnum,
  })),
  suppressed: z.array(z.object({
    ...ResourceSignalShape,
    source: SignalSourceEnum,
    reason: z.enum(["local-ahead", "local-equal", "ignore-upstream-updates"]),
  })),
  unknownSource: z.array(z.object({
    ...ResourceSignalShape,
    source: SignalSourceEnum,
    reason: z.enum(["no-semver", "missing-current", "missing-announced"]),
  })),
  unmapped: z.array(z.object({
    slug: z.string(),
    current: z.string().nullable(),
    announced: z.string(),
    source: z.literal("log"),
    releaseNotesUrl: z.string().optional(),
    severityNote: z.string().optional(),
    boundaryKnown: z.boolean(),
  })),
  scannedLogLines: z.number().int().nonnegative(),
  logHasStartupBoundary: z.boolean(),
  portalPolled: z.boolean(),
  portalFromCache: z.boolean(),
});

// ---------------------------------------------------------------------------
// Phase 1.6 — cfx_set_fork_mode (Task 11).
//
// Mutates a single mapping entry's `ignoreUpstreamUpdates*` triad so operators
// don't hand-edit cfx-sync-map.json for the common fork case (e.g. ULC with
// local 1.9.0 ahead of upstream v1.8.0). See spec §cfx_set_fork_mode.
// ---------------------------------------------------------------------------

export const SetForkModeInput = z.object({
  slug: z.string().optional(),
  grantId: z.number().int().positive().optional(),
  enabled: z.boolean(),
  reason: z.string().optional(),
}).refine(
  // Exactly one of {slug, grantId} must be supplied — xor.
  (d) => (d.slug !== undefined) !== (d.grantId !== undefined),
  { message: "Exactly one of slug or grantId is required" }
);

export const SetForkModeOutput = z.object({
  slug: z.string(),
  grantId: z.number().int(),
  ignoreUpstreamUpdates: z.boolean(),
  reason: z.string().optional(),
  setAt: z.string(),
});

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
  /**
   * Pristine versionId restored from pristine-history, or null if the backup
   * predated Phase 1.5 (no manifest / manifest with null pristine fields). In
   * the null case, state.pristine* is cleared so the next deploy runs as a
   * first-deploy.
   */
  pristineRotatedTo: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Phase 1.7 — cfx_list_unresolved (Task 7).
//
// Lists all mapping entries needing operator input: tier 3+4 fuzzy matches,
// new-installs, reactivated, name-collisions, plus pre-existing suspicious
// commits (reviewedByUser=false). Non-destructive query.
// ---------------------------------------------------------------------------

export const ListUnresolvedInput = z.object({});
export const ListUnresolvedOutput = z.object({
  unresolved: z.array(z.object({
    grantId: z.number(),
    assetName: z.string(),
    author: z.string().nullable(),
    proposed: z.object({
      target: z.string(),
      tier: z.number(),
      confidence: z.number(),
    }).nullable(),
    alternatives: z.array(z.object({
      target: z.string(),
      tier: z.number(),
      confidence: z.number(),
      authorPrefixBoosted: z.boolean(),
    })),
    reason: z.enum(["fuzzy-match", "new-install", "reactivated", "name-collision"]),
    collidesWith: z.object({ grantId: z.number(), target: z.string() }).optional(),
  })),
  suspicious: z.array(z.object({
    grantId: z.number(),
    assetName: z.string(),
    currentTarget: z.string(),
    tierAtCommit: z.number(),
    confidenceAtCommit: z.number(),
  })),
  summary: z.object({
    unresolvedCount: z.number(),
    suspiciousCount: z.number(),
    autoApprovedCount: z.number(),
  }),
  notice: z.string().optional(),
});
