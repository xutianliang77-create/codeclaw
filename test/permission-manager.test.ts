import { describe, expect, it } from "vitest";
import { PermissionManager } from "../src/permissions/manager";

describe("permission manager", () => {
  it("allows low-risk bash in plan mode", () => {
    const permissions = new PermissionManager("plan");
    const decision = permissions.evaluate({
      tool: "bash",
      command: "pwd"
    });

    expect(decision.behavior).toBe("allow");
    expect(decision.risk).toBe("low");
  });

  it("denies high-risk bash in auto mode", () => {
    const permissions = new PermissionManager("auto");
    const decision = permissions.evaluate({
      tool: "bash",
      command: "rm -rf tmp"
    });

    expect(decision.behavior).toBe("deny");
    expect(decision.risk).toBe("high");
  });

  it("requests approval for medium-risk bash in plan mode", () => {
    const permissions = new PermissionManager("plan");
    const decision = permissions.evaluate({
      tool: "bash",
      command: "npm test"
    });

    expect(decision.behavior).toBe("ask");
    expect(decision.risk).toBe("medium");
  });

  it("denies write tools in plan mode", () => {
    const permissions = new PermissionManager("plan");
    const decision = permissions.evaluate({
      tool: "write",
      target: "notes.txt"
    });

    expect(decision.behavior).toBe("ask");
    expect(decision.risk).toBe("medium");
  });

  it("allows replace in acceptEdits mode", () => {
    const permissions = new PermissionManager("acceptEdits");
    const decision = permissions.evaluate({
      tool: "replace",
      target: "notes.txt"
    });

    expect(decision.behavior).toBe("allow");
    expect(decision.risk).toBe("medium");
  });
});
