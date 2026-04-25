import { describe, it, expect } from "vitest";
import { makeGetters } from "../src/handlers";

describe("makeGetters · closure capture", () => {
  it("returns the value at each index", () => {
    const items = ["a", "b", "c"];
    const getters = makeGetters(items);
    expect(getters[0]!()).toBe("a");
    expect(getters[1]!()).toBe("b");
    expect(getters[2]!()).toBe("c");
  });

  it("works with single element", () => {
    const items = ["only"];
    const getters = makeGetters(items);
    expect(getters[0]!()).toBe("only");
  });

  it("returns 4 getters for 4 items", () => {
    const items = ["w", "x", "y", "z"];
    const getters = makeGetters(items);
    expect(getters.length).toBe(4);
    expect(getters.map((g) => g())).toEqual(["w", "x", "y", "z"]);
  });
});
