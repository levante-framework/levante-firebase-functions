import { describe, expect, it } from "vitest";
import {
  expectedIdHash,
  nextChildLabelIndex,
  resolveCaregiverLinks,
} from "./link-users.js";

describe("expectedIdHash", () => {
  it("hashes `${siteId}-${externalId}` with sha256", () => {
    expect(expectedIdHash("site1", "ext-1")).toBe(
      "02ddad1e7519ae166f47267df8d0a4c5274794c9598861f8991714afc9654b24"
    );
  });

  it("is deterministic", () => {
    expect(expectedIdHash("site1", "ext-1")).toBe(
      expectedIdHash("site1", "ext-1")
    );
  });

  it("changes when the site changes", () => {
    expect(expectedIdHash("site1", "ext-1")).not.toBe(
      expectedIdHash("site2", "ext-1")
    );
  });

  it("changes when the external id changes", () => {
    expect(expectedIdHash("site1", "ext-1")).not.toBe(
      expectedIdHash("site1", "ext-2")
    );
  });
});

describe("nextChildLabelIndex", () => {
  it("mints 0 when there is no existing label and no caregivers", () => {
    expect(nextChildLabelIndex(undefined, [])).toBe(0);
  });

  it("mints maxLast + 1 when there is no existing label", () => {
    expect(nextChildLabelIndex(undefined, [0, 2, 1])).toBe(3);
  });

  it("treats undefined caregiver indexes as unminted (-1)", () => {
    expect(nextChildLabelIndex(undefined, [undefined, undefined])).toBe(0);
    expect(nextChildLabelIndex(undefined, [undefined, 4])).toBe(5);
  });

  it("keeps the existing label when it exceeds every caregiver's last", () => {
    expect(nextChildLabelIndex(9, [0, 2, 1])).toBe(9);
  });

  it("keeps an existing label of 0 when all caregivers are unminted", () => {
    expect(nextChildLabelIndex(0, [undefined])).toBe(0);
  });

  it("mints maxLast + 1 when a caregiver's last equals the existing label", () => {
    expect(nextChildLabelIndex(2, [2])).toBe(3);
  });

  it("mints maxLast + 1 when a caregiver's last exceeds the existing label", () => {
    expect(nextChildLabelIndex(1, [5])).toBe(6);
  });
});

describe("resolveCaregiverLinks", () => {
  it("touches nothing for a teacher-only link (no requested caregivers)", () => {
    expect(resolveCaregiverLinks(["c1"], [])).toEqual({
      newCaregiverUids: [],
      caregiverUids: [],
    });
  });

  it("touches nothing when all requested caregivers are already linked", () => {
    expect(resolveCaregiverLinks(["c1", "c2"], ["c1", "c2"])).toEqual({
      newCaregiverUids: [],
      caregiverUids: [],
    });
  });

  it("loads the union of existing + new when a caregiver is added", () => {
    const { newCaregiverUids, caregiverUids } = resolveCaregiverLinks(
      ["c1"],
      ["c2"]
    );
    expect(newCaregiverUids).toEqual(["c2"]);
    expect([...caregiverUids].sort()).toEqual(["c1", "c2"]);
  });

  it("returns only the genuinely new caregivers from a mixed request", () => {
    const { newCaregiverUids, caregiverUids } = resolveCaregiverLinks(
      ["c1"],
      ["c1", "c2"]
    );
    expect(newCaregiverUids).toEqual(["c2"]);
    expect([...caregiverUids].sort()).toEqual(["c1", "c2"]);
  });

  it("dedupes repeated requested caregivers", () => {
    const { newCaregiverUids, caregiverUids } = resolveCaregiverLinks(
      [],
      ["c1", "c1"]
    );
    expect(newCaregiverUids).toEqual(["c1"]);
    expect(caregiverUids).toEqual(["c1"]);
  });

  it("links the first caregiver when the child has none", () => {
    expect(resolveCaregiverLinks([], ["c1"])).toEqual({
      newCaregiverUids: ["c1"],
      caregiverUids: ["c1"],
    });
  });
});
