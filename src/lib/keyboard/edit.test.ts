import { describe, expect, it } from "vitest";

import { afterChar, allowedChar, allowsNegative, applyKey, keyboardModeFor, nextShift, type EditState } from "./edit";

const s = (value: string, start = value.length, end = start): EditState => ({ value, start, end });
const char = (c: string) => ({ kind: "char" as const, char: c });

describe("which keyboard a field gets", () => {
  it("uses the number pad for mileage, hours and money fields", () => {
    expect(keyboardModeFor({ tagName: "INPUT", type: "text", inputMode: "decimal" })).toBe("decimal");
    expect(keyboardModeFor({ tagName: "INPUT", type: "text", inputMode: "numeric" })).toBe("numeric");
    expect(keyboardModeFor({ tagName: "INPUT", type: "number" })).toBe("numeric");
    // While the keyboard shows, inputmode is "none"; the original decides.
    expect(keyboardModeFor({ tagName: "INPUT", type: "text", inputMode: "none", dataset: { wallKeyboardInputmode: "decimal" } })).toBe(
      "decimal",
    );
  });

  it("uses the full keyboard for text and notes", () => {
    expect(keyboardModeFor({ tagName: "INPUT", type: "text" })).toBe("text");
    expect(keyboardModeFor({ tagName: "TEXTAREA" })).toBe("text");
  });

  it("leaves dates, checkboxes, selects and read-only fields alone", () => {
    expect(keyboardModeFor({ tagName: "INPUT", type: "date" })).toBeNull();
    expect(keyboardModeFor({ tagName: "INPUT", type: "checkbox" })).toBeNull();
    expect(keyboardModeFor({ tagName: "SELECT" })).toBeNull();
    expect(keyboardModeFor({ tagName: "INPUT", type: "text", disabled: true })).toBeNull();
    expect(keyboardModeFor({ tagName: "INPUT", type: "text", readOnly: true })).toBeNull();
  });
});

describe("typing", () => {
  it("inserts at the cursor and replaces a selection", () => {
    expect(applyKey(s("2100", 2), char("5"), "decimal")).toEqual(s("21500", 3));
    expect(applyKey(s("2100", 0, 4), char("9"), "decimal")).toEqual(s("9", 1));
    expect(applyKey(s("Oil"), char(" "), "text")).toEqual(s("Oil "));
  });

  it("allows one decimal point, only on decimal fields", () => {
    expect(applyKey(s("12"), char("."), "decimal")).toEqual(s("12."));
    expect(applyKey(s("12.5"), char("."), "decimal")).toEqual(s("12.5"));
    expect(applyKey(s("12"), char("."), "numeric")).toEqual(s("12"));
    // Replacing the selected point with a new one is fine.
    expect(applyKey(s("1.5", 1, 2), char("."), "decimal")).toEqual(s("1.5", 2));
    expect(allowedChar("decimal", "a", "")).toBe(false);
    expect(allowedChar("text", "a", "")).toBe(true);
  });

  it("respects the field's maximum length", () => {
    expect(applyKey(s("abc"), char("d"), "text", 3)).toEqual(s("abc"));
  });

  it("backspace deletes before the cursor, or the selection; clear empties", () => {
    expect(applyKey(s("2100", 2), { kind: "backspace" }, "decimal")).toEqual(s("200", 1));
    expect(applyKey(s("2100", 0), { kind: "backspace" }, "decimal")).toEqual(s("2100", 0));
    expect(applyKey(s("2100", 1, 3), { kind: "backspace" }, "decimal")).toEqual(s("20", 1));
    expect(applyKey(s("2100", 2), { kind: "clear" }, "decimal")).toEqual(s("", 0));
  });
});

describe("shift", () => {
  it("one tap for one capital, double tap locks", () => {
    expect(nextShift("off", false)).toBe("once");
    expect(afterChar("once")).toBe("off");
    expect(nextShift("once", true)).toBe("lock");
    expect(afterChar("lock")).toBe("lock");
    expect(nextShift("lock", false)).toBe("off");
    expect(nextShift("once", false)).toBe("off");
  });
});

describe("± (suspension number fields only)", () => {
  const at = (value: string, start = value.length, end = start) => ({ value, start, end });

  it("is offered only to fields that opt in", () => {
    expect(allowsNegative({ dataset: { allowNegative: "true" } })).toBe(true);
    expect(allowsNegative({ dataset: {} })).toBe(false);
    expect(allowsNegative({})).toBe(false);
  });

  it("flips the sign and keeps the cursor on the same digit", () => {
    expect(applyKey(at("12"), { kind: "negate" }, "decimal")).toEqual({ value: "-12", start: 3, end: 3 });
    expect(applyKey(at("-12"), { kind: "negate" }, "decimal")).toEqual({ value: "12", start: 2, end: 2 });
    expect(applyKey(at("2.5", 1), { kind: "negate" }, "decimal")).toEqual({ value: "-2.5", start: 2, end: 2 });
    expect(applyKey(at("-2.5", 0), { kind: "negate" }, "decimal")).toEqual({ value: "2.5", start: 0, end: 0 });
  });

  it("starts a negative number in an empty field, then digits follow", () => {
    let state = applyKey(at(""), { kind: "negate" }, "decimal");
    expect(state).toEqual({ value: "-", start: 1, end: 1 });
    state = applyKey(state, { kind: "char", char: "1" }, "decimal");
    state = applyKey(state, { kind: "char", char: "." }, "decimal");
    state = applyKey(state, { kind: "char", char: "5" }, "decimal");
    expect(state.value).toBe("-1.5");
  });

  it("respects the field's length limit and does nothing in text fields", () => {
    expect(applyKey(at("123"), { kind: "negate" }, "decimal", 3).value).toBe("123");
    expect(applyKey(at("abc"), { kind: "negate" }, "text").value).toBe("abc");
  });

  it("never lets a minus be typed as a character on the number pad", () => {
    expect(applyKey(at("12"), { kind: "char", char: "-" }, "decimal").value).toBe("12");
  });
});
