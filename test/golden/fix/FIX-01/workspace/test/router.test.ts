import { describe, it, expect } from "vitest";
import { match } from "../src/router";

describe("router · match", () => {
  it("extracts a single :id param", () => {
    const r = match("/users/:id", "/users/42");
    expect(r.matched).toBe(true);
    expect(r.params).toEqual({ id: "42" });
  });

  it("extracts two params without swapping", () => {
    const r = match("/users/:id/books/:bookId", "/users/42/books/7");
    expect(r.matched).toBe(true);
    expect(r.params).toEqual({ id: "42", bookId: "7" });
  });
});
