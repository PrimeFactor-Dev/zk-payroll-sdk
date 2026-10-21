/**
 * Machine-readable reason codes for settlement expiry events.
 *
 * Settlement expiry occurs when a payroll run's settlement window closes
 * before the run reaches a terminal settled state. These codes let operators
 * and dashboards surface an actionable explanation without string-matching
 * free-form messages, and never reveal private payroll amounts or employee
 * identities.
 */

export const SettlementExpiryReasonCode = {
  /** The configured settlement window elapsed before execution completed. */
  SETTLEMENT_WINDOW_ELAPSED: "SETTLEMENT_WINDOW_ELAPSED",
  /** Treasury balance fell below the policy's minimum reserve requirement. */
  INSUFFICIENT_TREASURY_RESERVE: "INSUFFICIENT_TREASURY_RESERVE",
  /** The governing policy expired before the run could settle. */
  POLICY_EXPIRED: "POLICY_EXPIRED",
  /** An operator cancelled the run before settlement completed. */
  MANUALLY_CANCELLED: "MANUALLY_CANCELLED",
  /** A compliance hold blocked settlement until the window closed. */
  COMPLIANCE_HOLD: "COMPLIANCE_HOLD",
  /** Batch submission timed out before all payments confirmed. */
  BATCH_TIMEOUT: "BATCH_TIMEOUT",
  /** The run was superseded by a replacement run before settling. */
  SUPERSEDED_BY_REPLACEMENT: "SUPERSEDED_BY_REPLACEMENT",
  /** Reason not covered by the standard set; see accompanying event notes. */
  UNKNOWN: "UNKNOWN",
} as const;

export type SettlementExpiryReasonCodeType =
  (typeof SettlementExpiryReasonCode)[keyof typeof SettlementExpiryReasonCode];

export type SettlementExpiryReasonCategory =
  | "window"
  | "treasury"
  | "policy"
  | "operator"
  | "compliance"
  | "execution"
  | "unknown";

export interface SettlementExpiryReasonMetadata {
  code: SettlementExpiryReasonCodeType;
  category: SettlementExpiryReasonCategory;
  description: string;
  suggestedAction: string;
  severity: "error" | "warning";
  retryable: boolean;
}

export const SETTLEMENT_EXPIRY_REASON_REGISTRY: Record<
  SettlementExpiryReasonCodeType,
  SettlementExpiryReasonMetadata
> = {
  [SettlementExpiryReasonCode.SETTLEMENT_WINDOW_ELAPSED]: {
    code: SettlementExpiryReasonCode.SETTLEMENT_WINDOW_ELAPSED,
    category: "window",
    description:
      "The settlement window closed before the payroll run reached a settled state.",
    suggestedAction:
      "Increase the policy settlement window or reschedule the run in a new window.",
    severity: "error",
    retryable: true,
  },
  [SettlementExpiryReasonCode.INSUFFICIENT_TREASURY_RESERVE]: {
    code: SettlementExpiryReasonCode.INSUFFICIENT_TREASURY_RESERVE,
    category: "treasury",
    description:
      "Treasury reserve fell below the policy minimum before settlement could complete.",
    suggestedAction:
      "Deposit additional treasury funds and reschedule the run.",
    severity: "error",
    retryable: true,
  },
  [SettlementExpiryReasonCode.POLICY_EXPIRED]: {
    code: SettlementExpiryReasonCode.POLICY_EXPIRED,
    category: "policy",
    description: "The governing payroll policy expired before the run settled.",
    suggestedAction:
      "Renew or replace the policy, then create a new payroll run under the active policy.",
    severity: "error",
    retryable: false,
  },
  [SettlementExpiryReasonCode.MANUALLY_CANCELLED]: {
    code: SettlementExpiryReasonCode.MANUALLY_CANCELLED,
    category: "operator",
    description: "An operator cancelled the run before settlement completed.",
    suggestedAction:
      "Review the cancellation note and recreate the run if the cancellation was unintentional.",
    severity: "warning",
    retryable: false,
  },
  [SettlementExpiryReasonCode.COMPLIANCE_HOLD]: {
    code: SettlementExpiryReasonCode.COMPLIANCE_HOLD,
    category: "compliance",
    description: "A compliance hold blocked settlement until the window closed.",
    suggestedAction:
      "Resolve the compliance hold and schedule a new run once cleared.",
    severity: "error",
    retryable: true,
  },
  [SettlementExpiryReasonCode.BATCH_TIMEOUT]: {
    code: SettlementExpiryReasonCode.BATCH_TIMEOUT,
    category: "execution",
    description: "Batch submission timed out before all payments confirmed on-ledger.",
    suggestedAction:
      "Resume the batch from the last checkpoint or resubmit the remaining entries.",
    severity: "error",
    retryable: true,
  },
  [SettlementExpiryReasonCode.SUPERSEDED_BY_REPLACEMENT]: {
    code: SettlementExpiryReasonCode.SUPERSEDED_BY_REPLACEMENT,
    category: "operator",
    description: "The run was superseded by a replacement run before settling.",
    suggestedAction: "Track the replacement run instead of this one.",
    severity: "warning",
    retryable: false,
  },
  [SettlementExpiryReasonCode.UNKNOWN]: {
    code: SettlementExpiryReasonCode.UNKNOWN,
    category: "unknown",
    description:
      "Settlement expired for a reason not covered by the standard code set.",
    suggestedAction:
      "Inspect the on-chain event notes and contract logs for the underlying cause.",
    severity: "warning",
    retryable: true,
  },
};

/**
 * Look up registered metadata for a settlement expiry reason code.
 * Returns `undefined` for unrecognized codes.
 */
export function getSettlementExpiryReasonMetadata(
  code: string
): SettlementExpiryReasonMetadata | undefined {
  return SETTLEMENT_EXPIRY_REASON_REGISTRY[code as SettlementExpiryReasonCodeType];
}

/**
 * Returns a human-friendly description for a settlement expiry reason code.
 * Falls back to a generic message for unrecognized codes.
 */
export function getSettlementExpiryReasonDescription(code: string): string {
  return (
    getSettlementExpiryReasonMetadata(code)?.description ??
    `Settlement expired due to unrecognized reason code: ${code}`
  );
}

/**
 * Returns the suggested remediation action for a settlement expiry reason code.
 */
export function getSettlementExpiryReasonAction(code: string): string {
  return (
    getSettlementExpiryReasonMetadata(code)?.suggestedAction ??
    "Inspect the event payload and contract state for more detail."
  );
}

/** Whether `code` is one of the SDK's standard settlement expiry reason codes. */
export function isKnownSettlementExpiryReason(
  code: string
): code is SettlementExpiryReasonCodeType {
  return code in SETTLEMENT_EXPIRY_REASON_REGISTRY;
}

/**
 * Normalize an arbitrary on-chain reason code into a known
 * {@link SettlementExpiryReasonCodeType}, mapping anything unrecognized
 * to `UNKNOWN`.
 */
export function normalizeSettlementExpiryReason(
  code: string | undefined | null
): SettlementExpiryReasonCodeType {
  if (!code) return SettlementExpiryReasonCode.UNKNOWN;
  return isKnownSettlementExpiryReason(code)
    ? code
    : SettlementExpiryReasonCode.UNKNOWN;
}
