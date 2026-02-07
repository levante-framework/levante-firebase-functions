import { describe, expect, it } from "vitest";
import { validateUserQueryInput } from "../functions/levante-admin/src/queries/user-queries.js";
import { validateOrgQueryInput } from "../functions/levante-admin/src/queries/org-queries.js";
import { validateTaskQueryInput } from "../functions/levante-admin/src/queries/task-queries.js";
import { validateRunQueryInput } from "../functions/levante-admin/src/queries/run-queries.js";
import { validateAssignmentQueryInput } from "../functions/levante-admin/src/queries/assignment-queries.js";

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

  it("validates task query input", () => {
    expect(() => validateTaskQueryInput({ taskIds: "bad" as any })).toThrow();
  });

  it("requires administrationId for run queries", () => {
    expect(() => validateRunQueryInput({ administrationId: "" })).toThrow();
  });

  it("requires adminId for assignment queries", () => {
    expect(() => validateAssignmentQueryInput({ adminId: "" })).toThrow();
  });
});
