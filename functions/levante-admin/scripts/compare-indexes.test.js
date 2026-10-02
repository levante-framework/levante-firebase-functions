import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexSpecsEqual } from "./compare-indexes.js";

const spec = {
  indexes: [
    {
      collectionGroup: "administrations",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "siteId", order: "ASCENDING" },
        { fieldPath: "dateClosed", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
      density: "SPARSE_ALL",
    },
    {
      collectionGroup: "administrations",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "testData", order: "ASCENDING" },
        { fieldPath: "name", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
      density: "SPARSE_ALL",
    },
  ],
  fieldOverrides: [
    {
      collectionGroup: "assignments",
      fieldPath: "id",
      ttl: false,
      indexes: [
        { order: "ASCENDING", queryScope: "COLLECTION" },
        { arrayConfig: "CONTAINS", queryScope: "COLLECTION" },
      ],
    },
  ],
};

// Same indexes, reversed array order, and object keys inserted in a different order.
const reordered = {
  fieldOverrides: [
    {
      ttl: false,
      indexes: [
        { queryScope: "COLLECTION", arrayConfig: "CONTAINS" },
        { queryScope: "COLLECTION", order: "ASCENDING" },
      ],
      fieldPath: "id",
      collectionGroup: "assignments",
    },
  ],
  indexes: [
    {
      density: "SPARSE_ALL",
      fields: [
        { order: "ASCENDING", fieldPath: "testData" },
        { order: "ASCENDING", fieldPath: "name" },
        { order: "ASCENDING", fieldPath: "__name__" },
      ],
      queryScope: "COLLECTION",
      collectionGroup: "administrations",
    },
    {
      density: "SPARSE_ALL",
      fields: [
        { order: "ASCENDING", fieldPath: "siteId" },
        { order: "ASCENDING", fieldPath: "dateClosed" },
        { order: "ASCENDING", fieldPath: "__name__" },
      ],
      queryScope: "COLLECTION",
      collectionGroup: "administrations",
    },
  ],
};

const swappedFields = structuredClone(spec);
const fields = swappedFields.indexes[0].fields;
[fields[0], fields[1]] = [fields[1], fields[0]];

describe("indexSpecsEqual", () => {
  it("treats index order and object key order as insignificant", () => {
    assert.equal(indexSpecsEqual(spec, reordered), true);
  });

  it("treats a reversed composite field order as a different index", () => {
    assert.equal(indexSpecsEqual(spec, swappedFields), false);
  });
});
