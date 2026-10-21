/**
 * Tests for Settlement Expiry Reason Code decoding
 *
 * Covers:
 *  - parseSettlementExpiredEvent — happy path, field validation, reason normalization
 *  - tryParseSettlementExpiredEvent / isSettlementExpiredEvent — stream filtering
 *  - parseSettlementExpiredEvents — batch parsing with mixed event types
 *  - SettlementExpiryReasonCode registry lookups
 *  - Boundary: missing optional fields, unknown reason codes, empty topics
 *  - Privacy: error messages never expose salary or recipient data
 */

import {
  parseSettlementExpiredEvent,
  tryParseSettlementExpiredEvent,
  isSettlementExpiredEvent,
  parseSettlementExpiredEvents,
} from "../../src/events/settlementExpiry";
import {
  SettlementExpiryReasonCode,
  getSettlementExpiryReasonMetadata,
  getSettlementExpiryReasonDescription,
  getSettlementExpiryReasonAction,
  isKnownSettlementExpiryReason,
  normalizeSettlementExpiryReason,
  SETTLEMENT_EXPIRY_REASON_REGISTRY,
} from "../../src/errors/settlementExpiryReasonCodes";
import { EventDecodingError } from "../../src/events/types";
import type { RawContractEvent } from "../../src/event-parser";
import { xdr, Address, Keypair } from "@stellar/stellar-sdk";

const TEST_EMPLOYER = Keypair.random().publicKey();

function makeEventScValMap(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(entries).map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val,
        })
    )
  );
}

function symbolScVal(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function stringScVal(str: string): xdr.ScVal {
  return xdr.ScVal.scvString(str);
}

function u64ScVal(value: number): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(value)));
}

function makeValidEvent(overrides?: {
  reasonCode?: string;
  omitReasonCode?: boolean;
  omitScheduledAt?: boolean;
  omitExpiredAt?: boolean;
  omitWindowClosedAt?: boolean;
  omitSettlementId?: boolean;
}): RawContractEvent {
  const dataEntries: Record<string, xdr.ScVal> = {};
  if (!overrides?.omitSettlementId) {
    dataEntries.settlement_id = stringScVal("settle_abc123");
  }
  if (!overrides?.omitReasonCode) {
    dataEntries.reason_code = stringScVal(overrides?.reasonCode ?? "SETTLEMENT_WINDOW_ELAPSED");
  }
  if (!overrides?.omitScheduledAt) {
    dataEntries.scheduled_at = u64ScVal(1700000000);
  }
  if (!overrides?.omitExpiredAt) {
    dataEntries.expired_at = u64ScVal(1700003600);
  }
  if (!overrides?.omitWindowClosedAt) {
    dataEntries.window_closed_at = u64ScVal(1700003600);
  }

  return {
    topics: [symbolScVal("settlement_expired"), new Address(TEST_EMPLOYER).toScVal()],
    data: makeEventScValMap(dataEntries),
    contractId: "CABC123",
    ledger: 100,
    ledgerClosedAt: "2026-08-29T00:00:00Z",
  };
}

describe("parseSettlementExpiredEvent", () => {
  it("parses a valid settlement_expired event", () => {
    const event = parseSettlementExpiredEvent(makeValidEvent());
    expect(event.type).toBe("settlement_expired");
    expect(event.employer).toBe(TEST_EMPLOYER);
    expect(event.settlementId).toBe("settle_abc123");
    expect(event.reasonCode).toBe(SettlementExpiryReasonCode.SETTLEMENT_WINDOW_ELAPSED);
    expect(event.rawReasonCode).toBe("SETTLEMENT_WINDOW_ELAPSED");
    expect(event.scheduledAt).toBe(1700000000);
    expect(event.expiredAt).toBe(1700003600);
    expect(event.windowClosedAt).toBe(1700003600);
    expect(event.contractId).toBe("CABC123");
    expect(event.ledger).toBe(100);
  });

  it("normalizes unknown reason codes to UNKNOWN", () => {
    const event = parseSettlementExpiredEvent(makeValidEvent({ reasonCode: "SOME_FUTURE_CODE" }));
    expect(event.reasonCode).toBe(SettlementExpiryReasonCode.UNKNOWN);
    expect(event.rawReasonCode).toBe("SOME_FUTURE_CODE");
  });

  it("defaults reasonCode to UNKNOWN when reason_code is absent", () => {
    const event = parseSettlementExpiredEvent(makeValidEvent({ omitReasonCode: true }));
    expect(event.reasonCode).toBe(SettlementExpiryReasonCode.UNKNOWN);
    expect(event.rawReasonCode).toBeUndefined();
  });

  it("handles missing window_closed_at gracefully", () => {
    const event = parseSettlementExpiredEvent(makeValidEvent({ omitWindowClosedAt: true }));
    expect(event.windowClosedAt).toBeUndefined();
  });

  it("handles missing scheduled_at as zero", () => {
    const event = parseSettlementExpiredEvent(makeValidEvent({ omitScheduledAt: true }));
    expect(event.scheduledAt).toBe(0);
  });

  it("throws EventDecodingError for empty topics", () => {
    const event: RawContractEvent = { topics: [], data: xdr.ScVal.scvVoid() };
    expect(() => parseSettlementExpiredEvent(event)).toThrow(EventDecodingError);
  });

  it("throws EventDecodingError for wrong event name", () => {
    const event = makeValidEvent();
    event.topics = [symbolScVal("other_event"), new Address(TEST_EMPLOYER).toScVal()];
    expect(() => parseSettlementExpiredEvent(event)).toThrow(EventDecodingError);
  });

  it("throws EventDecodingError when employer topic is missing", () => {
    const event = makeValidEvent();
    event.topics = [symbolScVal("settlement_expired")];
    expect(() => parseSettlementExpiredEvent(event)).toThrow(EventDecodingError);
  });

  it("throws EventDecodingError when settlement_id is missing", () => {
    expect(() => parseSettlementExpiredEvent(makeValidEvent({ omitSettlementId: true }))).toThrow(
      EventDecodingError
    );
  });

  it("throws EventDecodingError when expired_at is missing", () => {
    expect(() => parseSettlementExpiredEvent(makeValidEvent({ omitExpiredAt: true }))).toThrow(
      EventDecodingError
    );
  });

  it("does not leak sensitive data in error messages", () => {
    const event = makeValidEvent({ omitSettlementId: true });
    let caught: unknown;
    try {
      parseSettlementExpiredEvent(event);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EventDecodingError);
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toMatch(/\d{4,}/);
    expect(msg.toLowerCase()).not.toContain("salary");
    expect(msg.toLowerCase()).not.toContain("amount");
  });
});

describe("tryParseSettlementExpiredEvent / isSettlementExpiredEvent", () => {
  it("returns the event for matching events", () => {
    const result = tryParseSettlementExpiredEvent(makeValidEvent());
    expect(result).not.toBeNull();
    expect(result!.settlementId).toBe("settle_abc123");
  });

  it("returns null for non-matching event names", () => {
    const event = makeValidEvent();
    event.topics = [symbolScVal("unrelated_event")];
    expect(tryParseSettlementExpiredEvent(event)).toBeNull();
  });

  it("returns null for empty topics", () => {
    const event: RawContractEvent = { topics: [], data: xdr.ScVal.scvVoid() };
    expect(tryParseSettlementExpiredEvent(event)).toBeNull();
  });

  it("isSettlementExpiredEvent returns true/false accordingly", () => {
    expect(isSettlementExpiredEvent(makeValidEvent())).toBe(true);
    const other = makeValidEvent();
    other.topics = [symbolScVal("something_else")];
    expect(isSettlementExpiredEvent(other)).toBe(false);
  });
});

describe("parseSettlementExpiredEvents", () => {
  it("filters mixed event streams to only settlement_expired events", () => {
    const other: RawContractEvent = {
      topics: [symbolScVal("draft_updated")],
      data: makeEventScValMap({ draft_id: stringScVal("d1") }),
    };
    const events = [other, makeValidEvent(), other, makeValidEvent()];
    const parsed = parseSettlementExpiredEvents(events);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: { type: string }) => e.type === "settlement_expired")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(parseSettlementExpiredEvents([])).toEqual([]);
  });
});

describe("SettlementExpiryReasonCode registry", () => {
  it("has metadata for every defined code", () => {
    const codes = Object.values(SettlementExpiryReasonCode);
    for (const code of codes) {
      const meta = getSettlementExpiryReasonMetadata(code);
      expect(meta).toBeDefined();
      expect(meta!.code).toBe(code);
      expect(meta!.description.length).toBeGreaterThan(0);
      expect(meta!.suggestedAction.length).toBeGreaterThan(0);
    }
  });

  it("getSettlementExpiryReasonDescription returns a fallback for unknown codes", () => {
    const desc = getSettlementExpiryReasonDescription("NOT_A_REAL_CODE");
    expect(desc).toContain("unrecognized");
  });

  it("getSettlementExpiryReasonAction returns a fallback for unknown codes", () => {
    const action = getSettlementExpiryReasonAction("NOT_A_REAL_CODE");
    expect(action.length).toBeGreaterThan(0);
  });

  it("isKnownSettlementExpiryReason discriminates correctly", () => {
    expect(isKnownSettlementExpiryReason("BATCH_TIMEOUT")).toBe(true);
    expect(isKnownSettlementExpiryReason("nope")).toBe(false);
  });

  it("normalizeSettlementExpiryReason maps unknown and empty to UNKNOWN", () => {
    expect(normalizeSettlementExpiryReason(undefined)).toBe(SettlementExpiryReasonCode.UNKNOWN);
    expect(normalizeSettlementExpiryReason(null)).toBe(SettlementExpiryReasonCode.UNKNOWN);
    expect(normalizeSettlementExpiryReason("")).toBe(SettlementExpiryReasonCode.UNKNOWN);
    expect(normalizeSettlementExpiryReason("POLICY_EXPIRED")).toBe(
      SettlementExpiryReasonCode.POLICY_EXPIRED
    );
    expect(normalizeSettlementExpiryReason("garbage")).toBe(SettlementExpiryReasonCode.UNKNOWN);
  });

  it("registry covers all declared codes with no extras", () => {
    const declared = new Set<string>(Object.values(SettlementExpiryReasonCode));
    const registered = new Set<string>(Object.keys(SETTLEMENT_EXPIRY_REASON_REGISTRY));
    expect(registered.size).toBe(declared.size);
    for (const code of declared) {
      expect(registered.has(code)).toBe(true);
    }
  });
});
