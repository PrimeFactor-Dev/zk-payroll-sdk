/**
 * Policy Revision Attachment for Payroll Execution Receipts (#753)
 *
 * Attaches structured policy revision references to payroll execution
 * receipts so auditors and operators can trace exactly which policy version
 * governed each run at execution time. Policy revisions live in the receipt
 * metadata, are covered by the receipt's metadata digest, and never reveal
 * private employee or salary data.
 *
 * ## Privacy & Security Guarantees
 * - Policy revision references contain only policy identifiers, revision
 *   numbers, and public content digests — never employee or compensation data.
 * - Attachment helpers return new receipt objects; they never mutate the input.
 */

import { PayrollReceipt } from "./types";
import { canonicalizeMetadata } from "./digest";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A reference to a specific policy revision that governed a payroll execution.
 */
export interface PolicyRevision {
  /** Stable policy identifier (e.g. `"default"`, `"contractors-eu"`). */
  policyId: string;
  /** Monotonically increasing revision number for the policy. */
  revision: number;
  /**
   * Lowercase 64-character SHA-256 hex digest of the compiled policy payload,
   * when available. Binds the receipt to the exact policy content.
   */
  contentDigest?: string;
  /** ISO-8601 or epoch-ms timestamp when this revision became effective. */
  effectiveAt?: string | number;
  /** ISO-8601 or epoch-ms timestamp when this revision was superseded, if applicable. */
  supersededAt?: string | number;
  /** Optional non-sensitive label for display (e.g. `"2026-Q1 EU payroll"`). */
  label?: string;
}

/**
 * Metadata key under which policy revisions are stored on a receipt.
 */
export const POLICY_REVISION_METADATA_KEY = "policyRevisions";

// ── Validation ────────────────────────────────────────────────────────────────

/** Stable error codes for policy revision attachment validation. */
export type PolicyRevisionErrorCode =
  | "MISSING_POLICY_ID"
  | "MISSING_REVISION"
  | "INVALID_REVISION"
  | "INVALID_CONTENT_DIGEST"
  | "INVALID_EFFECTIVE_AT"
  | "DUPLICATE_POLICY_ID";

/**
 * A single validation issue with a policy revision reference.
 */
export interface PolicyRevisionIssue {
  code: PolicyRevisionErrorCode;
  /** Index of the offending revision in the input array. */
  index: number;
  field: string;
  /** Privacy-safe human-readable message. */
  message: string;
}

const HEX_64 = /^[a-fA-F0-9]{64}$/;

/**
 * Validate a single policy revision reference.
 * Returns a list of issues; empty means valid.
 */
export function validatePolicyRevision(revision: PolicyRevision): PolicyRevisionIssue[] {
  const issues: PolicyRevisionIssue[] = [];
  const index = 0;

  if (!revision.policyId || revision.policyId.trim().length === 0) {
    issues.push({
      code: "MISSING_POLICY_ID",
      index,
      field: "policyId",
      message: "Policy revision is missing a policyId.",
    });
  }

  if (typeof revision.revision !== "number" || !Number.isInteger(revision.revision)) {
    issues.push({
      code: "MISSING_REVISION",
      index,
      field: "revision",
      message: "Policy revision must have an integer revision number.",
    });
  } else if (revision.revision < 1) {
    issues.push({
      code: "INVALID_REVISION",
      index,
      field: "revision",
      message: "Policy revision number must be >= 1.",
    });
  }

  if (revision.contentDigest !== undefined) {
    if (typeof revision.contentDigest !== "string" || !HEX_64.test(revision.contentDigest.trim())) {
      issues.push({
        code: "INVALID_CONTENT_DIGEST",
        index,
        field: "contentDigest",
        message: "Policy revision contentDigest must be a 64-character hex string.",
      });
    }
  }

  if (revision.effectiveAt !== undefined) {
    const parsed =
      typeof revision.effectiveAt === "number"
        ? revision.effectiveAt
        : Date.parse(revision.effectiveAt);
    if (!Number.isFinite(parsed)) {
      issues.push({
        code: "INVALID_EFFECTIVE_AT",
        index,
        field: "effectiveAt",
        message: "Policy revision effectiveAt must be a valid timestamp.",
      });
    }
  }

  return issues;
}

/**
 * Validate an array of policy revision references, including duplicate policy IDs.
 * Returns a list of all issues; empty means valid.
 */
export function validatePolicyRevisions(revisions: PolicyRevision[]): PolicyRevisionIssue[] {
  const issues: PolicyRevisionIssue[] = [];
  const seen = new Set<string>();

  revisions.forEach((rev, index) => {
    const revIssues = validatePolicyRevision(rev);
    for (const issue of revIssues) {
      issues.push({ ...issue, index });
    }
    if (rev.policyId) {
      if (seen.has(rev.policyId)) {
        issues.push({
          code: "DUPLICATE_POLICY_ID",
          index,
          field: "policyId",
          message: `Duplicate policyId "${rev.policyId}" in policy revision list.`,
        });
      } else {
        seen.add(rev.policyId);
      }
    }
  });

  return issues;
}

// ── Attachment ────────────────────────────────────────────────────────────────

/**
 * Exception thrown when policy revision attachment fails validation.
 */
export class PolicyRevisionAttachmentError extends Error {
  public readonly issues: PolicyRevisionIssue[];

  constructor(message: string, issues: PolicyRevisionIssue[] = []) {
    super(message);
    this.name = "PolicyRevisionAttachmentError";
    this.issues = issues;
  }
}

/**
 * Attach one or more policy revision references to a payroll receipt.
 *
 * Returns a **new** receipt object; the input is never mutated. Policy
 * revisions are stored under `metadata.policyRevisions`. The caller is
 * responsible for recomputing `metadataDigest` (via `computeMetadataDigest`
 * from `./digest`) after attachment if the receipt must remain verifiable.
 *
 * @param receipt - The receipt to attach policy revisions to
 * @param revisions - One or more policy revision references
 * @param options - Attachment options
 * @returns A new receipt with policy revisions merged into its metadata
 * @throws {PolicyRevisionAttachmentError} when any revision fails validation
 *
 * @example
 * ```ts
 * const updated = attachPolicyRevision(receipt, {
 *   policyId: "default",
 *   revision: 3,
 *   contentDigest: "a".repeat(64),
 * });
 * ```
 */
export function attachPolicyRevision(
  receipt: PayrollReceipt,
  revisions: PolicyRevision | PolicyRevision[],
  options: { validate?: boolean } = {}
): PayrollReceipt {
  const { validate = true } = options;
  const list = Array.isArray(revisions) ? revisions : [revisions];

  if (validate) {
    const issues = validatePolicyRevisions(list);
    if (issues.length > 0) {
      throw new PolicyRevisionAttachmentError(
        `Policy revision attachment failed with ${issues.length} issue(s)`,
        issues
      );
    }
  }

  const existingMeta = (receipt.metadata ?? {}) as Record<string, unknown>;
  const existingRevisions = (existingMeta[POLICY_REVISION_METADATA_KEY] ?? []) as PolicyRevision[];

  // New revisions take precedence for the same policyId; unmatched existing
  // revisions are preserved so multiple policies can be tracked on one receipt.
  const mergedByPolicy = new Map<string, PolicyRevision>();
  for (const rev of existingRevisions) {
    if (rev && typeof rev === "object" && "policyId" in rev) {
      mergedByPolicy.set(rev.policyId, rev);
    }
  }
  for (const rev of list) {
    mergedByPolicy.set(rev.policyId, rev);
  }

  return {
    ...receipt,
    metadata: {
      ...existingMeta,
      [POLICY_REVISION_METADATA_KEY]: Array.from(mergedByPolicy.values()),
    },
  };
}

/**
 * Extract policy revision references from a receipt's metadata.
 * Returns an empty array when none are attached.
 */
export function extractPolicyRevisions(receipt: PayrollReceipt): PolicyRevision[] {
  const meta = receipt.metadata as Record<string, unknown> | undefined;
  const raw = meta?.[POLICY_REVISION_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is PolicyRevision =>
      r !== null && typeof r === "object" && "policyId" in r && "revision" in r
  );
}

/**
 * Look up the policy revision for a specific policy ID on a receipt.
 * Returns `undefined` when not attached.
 */
export function getPolicyRevision(
  receipt: PayrollReceipt,
  policyId: string
): PolicyRevision | undefined {
  return extractPolicyRevisions(receipt).find((r) => r.policyId === policyId);
}

/**
 * Whether the receipt has at least one policy revision attached.
 */
export function hasPolicyRevision(receipt: PayrollReceipt): boolean {
  return extractPolicyRevisions(receipt).length > 0;
}

/**
 * Compute a stable canonical digest string of the attached policy revisions.
 * Useful for comparing revision sets across receipts or audit packages.
 */
export function policyRevisionDigest(receipt: PayrollReceipt): string {
  return canonicalizeMetadata(extractPolicyRevisions(receipt));
}
