/**
 * Tests for Batch Commitment Duplicate Validation (#751)
 *
 * Covers:
 *  - validateCommitmentDuplicates — success, rejected, and boundary cases
 *  - assertNoDuplicateCommitments — throwing variant
 *  - validateBatchCommitmentHashes — convenience helper
 *  - Privacy: violation messages never expose employee or salary data
 */

import {
  validateCommitmentDuplicates,
  assertNoDuplicateCommitments,
  validateBatchCommitmentHashes,
  CommitmentEntry,
} from "../../src/batch/commitmentDuplicateValidator";
import { ProofCommitmentDuplicateError } from "../../src/proofs/errors";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function entry(index: number, commitmentHash?: string): CommitmentEntry {
  return { index, commitmentHash };
}

describe("validateCommitmentDuplicates", () => {
  it("returns no violations for unique commitments (successful case)", () => {
    const result = validateCommitmentDuplicates([
      entry(0, HASH_A),
      entry(1, HASH_B),
      entry(2, HASH_C),
    ]);
    expect(result.hasDuplicates).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(result.totalChecked).toBe(3);
    expect(result.uniqueCount).toBe(3);
  });

  it("flags duplicate commitment hashes (rejected case)", () => {
    const result = validateCommitmentDuplicates([
      entry(0, HASH_A),
      entry(1, HASH_B),
      entry(2, HASH_A),
    ]);
    expect(result.hasDuplicates).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe("DUPLICATE_COMMITMENT");
    expect(result.violations[0].index).toBe(2);
    expect(result.violations[0].matchedIndex).toBe(0);
    expect(result.uniqueCount).toBe(2);
  });

  it("flags multiple independent duplicates", () => {
    const result = validateCommitmentDuplicates([
      entry(0, HASH_A),
      entry(1, HASH_B),
      entry(2, HASH_A),
      entry(3, HASH_B),
    ]);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].index).toBe(2);
    expect(result.violations[1].index).toBe(3);
  });

  it("skips entries without commitment hashes by default", () => {
    const result = validateCommitmentDuplicates([
      entry(0, HASH_A),
      entry(1),
      entry(2, undefined),
    ]);
    expect(result.hasDuplicates).toBe(false);
    expect(result.uniqueCount).toBe(1);
    expect(result.totalChecked).toBe(3);
  });

  it("reports missing hashes when requireCommitmentHashes is true", () => {
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1)], {
      requireCommitmentHashes: true,
    });
    expect(result.hasDuplicates).toBe(true);
    expect(result.violations[0].code).toBe("MISSING_COMMITMENT_HASH");
  });

  it("rejects malformed commitment hashes when validateHashFormat is true", () => {
    const result = validateCommitmentDuplicates([entry(0, "not-a-hash")]);
    expect(result.hasDuplicates).toBe(true);
    expect(result.violations[0].code).toBe("INVALID_COMMITMENT_HASH");
  });

  it("allows malformed hashes when validateHashFormat is false", () => {
    const result = validateCommitmentDuplicates([entry(0, "not-a-hash")], {
      validateHashFormat: false,
    });
    expect(result.hasDuplicates).toBe(false);
  });

  it("treats hashes case-insensitively by default (boundary case)", () => {
    const upper = HASH_A.toUpperCase();
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1, upper)]);
    expect(result.hasDuplicates).toBe(true);
    expect(result.violations[0].code).toBe("DUPLICATE_COMMITMENT");
  });

  it("treats hashes case-sensitively when requested", () => {
    const upper = HASH_A.toUpperCase();
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1, upper)], {
      caseSensitive: true,
    });
    expect(result.hasDuplicates).toBe(false);
  });

  it("trims whitespace around hashes before comparing", () => {
    const padded = `  ${HASH_A}  `;
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1, padded)]);
    expect(result.hasDuplicates).toBe(true);
  });

  it("handles empty batch (boundary case)", () => {
    const result = validateCommitmentDuplicates([]);
    expect(result.hasDuplicates).toBe(false);
    expect(result.totalChecked).toBe(0);
    expect(result.uniqueCount).toBe(0);
  });

  it("handles single entry (boundary case)", () => {
    const result = validateCommitmentDuplicates([entry(0, HASH_A)]);
    expect(result.hasDuplicates).toBe(false);
    expect(result.uniqueCount).toBe(1);
  });

  it("does not leak salary or recipient data in messages", () => {
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1, HASH_A)]);
    for (const v of result.violations) {
      expect(v.message.toLowerCase()).not.toContain("salary");
      expect(v.message.toLowerCase()).not.toContain("amount");
      expect(v.message.toLowerCase()).not.toContain("recipient");
      expect(v.message).not.toMatch(/G[A-Z0-9]{55}/);
    }
  });

  it("truncates long hashes in redactedHash", () => {
    const result = validateCommitmentDuplicates([entry(0, HASH_A), entry(1, HASH_A)]);
    const redacted = result.violations[0].redactedHash;
    expect(redacted.length).toBeLessThan(HASH_A.length);
    expect(redacted).toContain("…");
  });
});

describe("assertNoDuplicateCommitments", () => {
  it("returns the result when there are no duplicates", () => {
    const result = assertNoDuplicateCommitments([entry(0, HASH_A), entry(1, HASH_B)]);
    expect(result.hasDuplicates).toBe(false);
  });

  it("throws ProofCommitmentDuplicateError when duplicates exist", () => {
    expect(() =>
      assertNoDuplicateCommitments([entry(0, HASH_A), entry(1, HASH_A)])
    ).toThrow(ProofCommitmentDuplicateError);
  });

  it("attaches violations to the thrown error", () => {
    try {
      assertNoDuplicateCommitments([entry(0, HASH_A), entry(1, HASH_A)]);
    } catch (e) {
      expect(e).toBeInstanceOf(ProofCommitmentDuplicateError);
      const err = e as ProofCommitmentDuplicateError;
      expect(err.violations).toHaveLength(1);
      expect(err.violations[0].code).toBe("DUPLICATE_COMMITMENT");
    }
  });
});

describe("validateBatchCommitmentHashes", () => {
  it("validates plain commitmentHash objects", () => {
    const result = validateBatchCommitmentHashes([
      { commitmentHash: HASH_A },
      { commitmentHash: HASH_B },
    ]);
    expect(result.hasDuplicates).toBe(false);
  });

  it("detects duplicates among plain objects", () => {
    const result = validateBatchCommitmentHashes([
      { commitmentHash: HASH_A },
      { commitmentHash: HASH_A },
    ]);
    expect(result.hasDuplicates).toBe(true);
    expect(result.violations[0].code).toBe("DUPLICATE_COMMITMENT");
  });

  it("skips entries without commitmentHash", () => {
    const result = validateBatchCommitmentHashes([
      { commitmentHash: HASH_A },
      {},
    ]);
    expect(result.hasDuplicates).toBe(false);
  });
});
