/**
 * Tests for Policy Revision Attachment on Payroll Execution Receipts (#753)
 *
 * Covers:
 *  - validatePolicyRevision / validatePolicyRevisions — success, rejected, boundary
 *  - attachPolicyRevision — single and multiple revisions, merge semantics
 *  - extractPolicyRevisions / getPolicyRevision / hasPolicyRevision
 *  - policyRevisionDigest — deterministic digest
 *  - Privacy: no salary or employee data in revisions or errors
 */

import {
  PolicyRevision,
  validatePolicyRevision,
  validatePolicyRevisions,
  attachPolicyRevision,
  extractPolicyRevisions,
  getPolicyRevision,
  hasPolicyRevision,
  policyRevisionDigest,
  PolicyRevisionAttachmentError,
  POLICY_REVISION_METADATA_KEY,
} from "../../src/receipts/policyRevisionAttachment";
import type { PayrollReceipt } from "../../src/receipts/types";

function makeReceipt(overrides?: Partial<PayrollReceipt>): PayrollReceipt {
  return {
    receiptId: "rcpt_test_001",
    payrollId: "pr_test_001",
    settlementStatus: "settled",
    transactionReference: {
      txHash: "a".repeat(64),
    },
    metadataDigest: "b".repeat(64),
    issuedAt: 1700000000000,
    ...overrides,
  };
}

const VALID_REVISION: PolicyRevision = {
  policyId: "default",
  revision: 3,
  contentDigest: "c".repeat(64),
  effectiveAt: 1700000000000,
};

describe("validatePolicyRevision", () => {
  it("accepts a valid revision (successful case)", () => {
    expect(validatePolicyRevision(VALID_REVISION)).toHaveLength(0);
  });

  it("rejects missing policyId (rejected case)", () => {
    const issues = validatePolicyRevision({ ...VALID_REVISION, policyId: "" });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("MISSING_POLICY_ID");
  });

  it("rejects non-integer revision numbers", () => {
    const issues = validatePolicyRevision({ ...VALID_REVISION, revision: 1.5 });
    expect(issues.some((i) => i.code === "MISSING_REVISION")).toBe(true);
  });

  it("rejects revision < 1 (boundary case)", () => {
    const issues = validatePolicyRevision({ ...VALID_REVISION, revision: 0 });
    expect(issues.some((i) => i.code === "INVALID_REVISION")).toBe(true);
  });

  it("accepts revision = 1 (boundary case)", () => {
    expect(validatePolicyRevision({ ...VALID_REVISION, revision: 1 })).toHaveLength(0);
  });

  it("rejects malformed contentDigest", () => {
    const issues = validatePolicyRevision({ ...VALID_REVISION, contentDigest: "xyz" });
    expect(issues.some((i) => i.code === "INVALID_CONTENT_DIGEST")).toBe(true);
  });

  it("accepts missing contentDigest", () => {
    const rev: PolicyRevision = { policyId: "p", revision: 1 };
    expect(validatePolicyRevision(rev)).toHaveLength(0);
  });

  it("rejects invalid effectiveAt", () => {
    const issues = validatePolicyRevision({
      ...VALID_REVISION,
      effectiveAt: "not-a-date",
    });
    expect(issues.some((i) => i.code === "INVALID_EFFECTIVE_AT")).toBe(true);
  });

  it("accepts numeric and string effectiveAt", () => {
    expect(validatePolicyRevision({ ...VALID_REVISION, effectiveAt: 1700000000000 })).toHaveLength(0);
    expect(
      validatePolicyRevision({ ...VALID_REVISION, effectiveAt: "2026-01-01T00:00:00Z" })
    ).toHaveLength(0);
  });
});

describe("validatePolicyRevisions", () => {
  it("accepts multiple valid revisions with distinct policyIds", () => {
    const issues = validatePolicyRevisions([
      { policyId: "a", revision: 1 },
      { policyId: "b", revision: 2 },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("flags duplicate policyIds (rejected case)", () => {
    const issues = validatePolicyRevisions([
      { policyId: "a", revision: 1 },
      { policyId: "a", revision: 2 },
    ]);
    expect(issues.some((i) => i.code === "DUPLICATE_POLICY_ID")).toBe(true);
  });

  it("collects issues with correct indices", () => {
    const issues = validatePolicyRevisions([
      { policyId: "a", revision: 1 },
      { policyId: "", revision: 2 },
    ]);
    expect(issues[0].index).toBe(1);
    expect(issues[0].code).toBe("MISSING_POLICY_ID");
  });

  it("handles empty array (boundary case)", () => {
    expect(validatePolicyRevisions([])).toHaveLength(0);
  });
});

describe("attachPolicyRevision", () => {
  it("attaches a single revision to a receipt (successful case)", () => {
    const receipt = makeReceipt();
    const updated = attachPolicyRevision(receipt, VALID_REVISION);
    const revisions = extractPolicyRevisions(updated);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].policyId).toBe("default");
    expect(revisions[0].revision).toBe(3);
  });

  it("does not mutate the original receipt", () => {
    const receipt = makeReceipt();
    attachPolicyRevision(receipt, VALID_REVISION);
    expect(extractPolicyRevisions(receipt)).toHaveLength(0);
    expect(receipt.metadata).toBeUndefined();
  });

  it("attaches multiple revisions in one call", () => {
    const updated = attachPolicyRevision(makeReceipt(), [
      { policyId: "a", revision: 1 },
      { policyId: "b", revision: 2 },
    ]);
    expect(extractPolicyRevisions(updated)).toHaveLength(2);
  });

  it("merges new revisions over existing ones for the same policyId", () => {
    const first = attachPolicyRevision(makeReceipt(), { policyId: "default", revision: 1 });
    const second = attachPolicyRevision(first, { policyId: "default", revision: 2 });
    const revisions = extractPolicyRevisions(second);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision).toBe(2);
  });

  it("preserves revisions for other policyIds when merging", () => {
    const first = attachPolicyRevision(makeReceipt(), { policyId: "a", revision: 1 });
    const second = attachPolicyRevision(first, { policyId: "b", revision: 1 });
    expect(extractPolicyRevisions(second)).toHaveLength(2);
  });

  it("throws PolicyRevisionAttachmentError for invalid revisions (rejected case)", () => {
    expect(() =>
      attachPolicyRevision(makeReceipt(), { policyId: "", revision: 1 })
    ).toThrow(PolicyRevisionAttachmentError);
  });

  it("skips validation when validate is false", () => {
    const updated = attachPolicyRevision(
      makeReceipt(),
      { policyId: "", revision: 1 },
      { validate: false }
    );
    expect(updated.metadata).toBeDefined();
  });

  it("preserves existing receipt metadata keys", () => {
    const receipt = makeReceipt({ metadata: { customKey: "customValue" } });
    const updated = attachPolicyRevision(receipt, VALID_REVISION);
    expect((updated.metadata as Record<string, unknown>).customKey).toBe("customValue");
    expect((updated.metadata as Record<string, unknown>)[POLICY_REVISION_METADATA_KEY]).toBeDefined();
  });

  it("does not leak salary or employee data", () => {
    const updated = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    const json = JSON.stringify(updated.metadata);
    expect(json.toLowerCase()).not.toContain("salary");
    expect(json.toLowerCase()).not.toContain("employee");
    expect(json.toLowerCase()).not.toContain("recipient");
  });
});

describe("extractPolicyRevisions / getPolicyRevision / hasPolicyRevision", () => {
  it("returns empty array when no revisions attached", () => {
    expect(extractPolicyRevisions(makeReceipt())).toEqual([]);
    expect(hasPolicyRevision(makeReceipt())).toBe(false);
    expect(getPolicyRevision(makeReceipt(), "default")).toBeUndefined();
  });

  it("returns empty array when metadata is missing", () => {
    expect(extractPolicyRevisions(makeReceipt({ metadata: undefined }))).toEqual([]);
  });

  it("finds a revision by policyId", () => {
    const updated = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    const found = getPolicyRevision(updated, "default");
    expect(found).toBeDefined();
    expect(found!.revision).toBe(3);
    expect(getPolicyRevision(updated, "other")).toBeUndefined();
  });

  it("hasPolicyRevision returns true when revisions exist", () => {
    const updated = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    expect(hasPolicyRevision(updated)).toBe(true);
  });

  it("ignores malformed metadata entries (boundary case)", () => {
    const receipt = makeReceipt({
      metadata: { [POLICY_REVISION_METADATA_KEY]: [null, "not-an-object", { foo: 1 }] },
    });
    expect(extractPolicyRevisions(receipt)).toEqual([]);
  });
});

describe("policyRevisionDigest", () => {
  it("produces a deterministic digest for the same revisions", () => {
    const a = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    const b = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    expect(policyRevisionDigest(a)).toBe(policyRevisionDigest(b));
  });

  it("produces different digests for different revisions", () => {
    const a = attachPolicyRevision(makeReceipt(), VALID_REVISION);
    const b = attachPolicyRevision(makeReceipt(), { ...VALID_REVISION, revision: 99 });
    expect(policyRevisionDigest(a)).not.toBe(policyRevisionDigest(b));
  });

  it("returns a stable digest for empty revisions", () => {
    expect(policyRevisionDigest(makeReceipt())).toBe(policyRevisionDigest(makeReceipt()));
  });
});
