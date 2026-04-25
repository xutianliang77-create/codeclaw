import { describe, it, expect } from "vitest";
import { updateUser, type State } from "../src/store";

const baseState = (): State => ({
  user: { id: "u1", name: "alice", email: "a@x.com" },
  count: 0,
});

describe("updateUser · immutability", () => {
  it("returns new state with patch applied", () => {
    const s1 = baseState();
    const s2 = updateUser(s1, { name: "bob" });
    expect(s2.user.name).toBe("bob");
  });

  it("does NOT mutate original state.user", () => {
    const s1 = baseState();
    updateUser(s1, { name: "bob" });
    expect(s1.user.name).toBe("alice");
  });

  it("returns new user reference", () => {
    const s1 = baseState();
    const s2 = updateUser(s1, { email: "new@x.com" });
    expect(s2.user).not.toBe(s1.user);
  });

  it("preserves untouched fields", () => {
    const s1 = baseState();
    const s2 = updateUser(s1, { name: "bob" });
    expect(s2.user.id).toBe("u1");
    expect(s2.user.email).toBe("a@x.com");
  });
});
