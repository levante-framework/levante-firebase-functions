import { describe, expect, it } from "vitest";
import { validateUserQueryInput } from "../functions/levante-admin/src/queries/user-queries.js";
import { validateOrgQueryInput } from "../functions/levante-admin/src/queries/org-queries.js";

describe("query migration validators", () => {
  it("requires orgType and orgId for user queries", () => {
    expect(() => validateUserQueryInput({ orgType: "", orgId: "" })).toThrow();
    expect(() =>
      validateUserQueryInput({ orgType: "districts", orgId: "" })
    ).toThrow();
  });

  it("requires orgType for org queries", () => {
    expect(() => validateOrgQueryInput({ orgType: "" })).toThrow();
  });
});
