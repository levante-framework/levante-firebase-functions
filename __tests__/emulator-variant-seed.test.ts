import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { serializeFirestoreValue } from "../functions/local/src/variants/write-registered-variants-json.ts";

const require = createRequire(import.meta.url);
const {
  loadVariantSeedRows,
  materializeFirestoreValues,
  isTimestampSentinel,
  FIRESTORE_TIMESTAMP_SENTINEL_KEY,
} = require("../emulator_scripts/seeders/tasks.js");
const { splitTaskIdsIntoNBuckets } = require("../emulator_scripts/seeders/administrations.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSeedPath = path.join(
  repoRoot,
  "emulator_scripts/seeders/default-variant-seed.json",
);

describe("loadVariantSeedRows", () => {
  it("loads and validates default-variant-seed.json", () => {
    const rows = loadVariantSeedRows(defaultSeedPath);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      taskId: expect.any(String),
      taskData: expect.any(Object),
      variants: expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), data: expect.any(Object) }),
      ]),
    });
  });

  it("rejects a seed file with an empty rows array", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-seed-"));
    const badPath = path.join(tmpDir, "empty-rows.json");
    fs.writeFileSync(badPath, JSON.stringify({ rows: [] }), "utf8");
    expect(() => loadVariantSeedRows(badPath)).toThrow(/empty "rows" array/);
  });

  it("rejects a row missing taskId", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-seed-"));
    const badPath = path.join(tmpDir, "bad-row.json");
    fs.writeFileSync(
      badPath,
      JSON.stringify({
        rows: [{ taskData: { name: "x" }, variants: [{ id: "v1", data: {} }] }],
      }),
      "utf8",
    );
    expect(() => loadVariantSeedRows(badPath)).toThrow(/Invalid row/);
  });
});

describe("serializeFirestoreValue", () => {
  it("replaces Timestamp with __firestoreTimestamp sentinel", () => {
    const ts = Timestamp.fromDate(new Date("2024-06-01T12:00:00.000Z"));
    expect(serializeFirestoreValue(ts)).toEqual({
      __firestoreTimestamp: "2024-06-01T12:00:00.000Z",
    });
  });

  it("preserves array indices when a Timestamp appears in the middle", () => {
    const ts = Timestamp.fromDate(new Date("2024-06-01T12:00:00.000Z"));
    const input = ["a", ts, "c"];
    const out = serializeFirestoreValue(input) as unknown[];
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("a");
    expect(out[1]).toEqual({ __firestoreTimestamp: "2024-06-01T12:00:00.000Z" });
    expect(out[2]).toBe("c");
  });

  it("walks nested objects", () => {
    const ts = Timestamp.fromDate(new Date("2024-01-15T00:00:00.000Z"));
    const out = serializeFirestoreValue({ meta: { lastUpdated: ts }, count: 2 }) as Record<
      string,
      unknown
    >;
    expect(out.count).toBe(2);
    const meta = out.meta as Record<string, unknown>;
    expect((meta.lastUpdated as Record<string, string>).__firestoreTimestamp).toBe(
      "2024-01-15T00:00:00.000Z",
    );
  });
});

describe("materializeFirestoreValues", () => {
  it("replaces timestamp sentinels with FieldValue.serverTimestamp()", () => {
    const input = { lastUpdated: { [FIRESTORE_TIMESTAMP_SENTINEL_KEY]: "2024-01-01T00:00:00.000Z" } };
    const out = materializeFirestoreValues(input) as { lastUpdated: { constructor: { name: string } } };
    expect(isTimestampSentinel(input.lastUpdated)).toBe(true);
    expect(isTimestampSentinel(out.lastUpdated)).toBe(false);
    expect(out.lastUpdated.constructor.name).toBe("ServerTimestampTransform");
  });

  it("leaves non-sentinel values unchanged", () => {
    const input = { name: "en", params: { language: "en" } };
    expect(materializeFirestoreValues(input)).toEqual(input);
  });
});

describe("splitTaskIdsIntoNBuckets", () => {
  it("returns empty array when taskIds is empty", () => {
    expect(splitTaskIdsIntoNBuckets([], 3)).toEqual([]);
  });

  it("splits task ids into n roughly-even buckets", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const chunks = splitTaskIdsIntoNBuckets(ids, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks[0]).toEqual(["a", "b"]);
    expect(chunks[1]).toEqual(["c", "d"]);
    expect(chunks[2]).toEqual(["e"]);
  });

  it("caps bucket count at taskIds.length", () => {
    expect(splitTaskIdsIntoNBuckets(["only"], 5)).toEqual([["only"]]);
  });
});
