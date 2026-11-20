import { describe, expect, it } from "vitest";
import { defineOnce } from "../src/define";

class Free extends HTMLElement {}
class First extends HTMLElement {}
class Second extends HTMLElement {}

describe("defineOnce", () => {
  it("registers an element under a free tag", () => {
    defineOnce("define-once-free", Free);

    expect(customElements.get("define-once-free")).toBe(Free);
    expect(document.createElement("define-once-free")).toBeInstanceOf(Free);
  });

  it("keeps the first element when the tag is defined again", () => {
    defineOnce("define-once-taken", First);

    expect(() => {
      defineOnce("define-once-taken", Second);
    }).not.toThrow();
    expect(customElements.get("define-once-taken")).toBe(First);
  });
});
