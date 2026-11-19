/**
 * The Wall Display keyboard's editing rules, kept free of the DOM so they can
 * be unit tested. A key edits the field's text at the cursor (or replaces the
 * selection), exactly like typing would.
 */

export type KeyboardMode = "decimal" | "numeric" | "text";

export type EditState = { value: string; start: number; end: number };

export type KeyAction = { kind: "char"; char: string } | { kind: "backspace" } | { kind: "clear" } | { kind: "negate" };

/**
 * Whether a number field takes negative values, so the number pad offers a
 * ± key. Opt-in per field (data-allow-negative="true"): only suspension
 * values use it; mileage, hours and other numbers never get it.
 */
export function allowsNegative(el: { dataset?: Record<string, string | undefined> }): boolean {
  return el.dataset?.allowNegative === "true";
}

/** Which keyboard a field gets, or null for fields with their own touch controls. */
export function keyboardModeFor(el: {
  tagName: string;
  type?: string;
  inputMode?: string;
  readOnly?: boolean;
  disabled?: boolean;
  dataset?: Record<string, string | undefined>;
}): KeyboardMode | null {
  if (el.readOnly || el.disabled) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return "text";
  if (tag !== "input") return null;
  const type = (el.type || "text").toLowerCase();
  if (!["text", "search", "email", "url", "tel", "number"].includes(type)) return null;
  // While the keyboard is showing, the field's inputmode is "none"; the original is kept here.
  const inputMode = (el.dataset?.wallKeyboardInputmode ?? el.inputMode ?? "").toLowerCase();
  if (inputMode === "decimal") return "decimal";
  if (inputMode === "numeric" || type === "number" || type === "tel") return "numeric";
  return "text";
}

/** Whether a character may be typed in this mode, given the text it would go into. */
export function allowedChar(mode: KeyboardMode, char: string, valueWithoutSelection: string): boolean {
  if (mode === "text") return true;
  if (/^[0-9]$/.test(char)) return true;
  if (mode === "decimal" && char === ".") return !valueWithoutSelection.includes(".");
  return false;
}

export function applyKey(state: EditState, action: KeyAction, mode: KeyboardMode, maxLength?: number): EditState {
  const start = Math.max(0, Math.min(state.start, state.value.length));
  const end = Math.max(start, Math.min(state.end, state.value.length));
  const before = state.value.slice(0, start);
  const after = state.value.slice(end);

  if (action.kind === "clear") return { value: "", start: 0, end: 0 };
  // ± flips the sign of the whole number, wherever the cursor is; the cursor stays on the same digit.
  if (action.kind === "negate") {
    if (mode === "text") return { value: state.value, start, end };
    if (state.value.startsWith("-")) return { value: state.value.slice(1), start: Math.max(0, start - 1), end: Math.max(0, end - 1) };
    if (maxLength != null && maxLength >= 0 && state.value.length + 1 > maxLength) return { value: state.value, start, end };
    return { value: `-${state.value}`, start: start + 1, end: end + 1 };
  }
  if (action.kind === "backspace") {
    if (start !== end) return { value: before + after, start, end: start };
    if (start === 0) return { value: state.value, start: 0, end: 0 };
    return { value: before.slice(0, -1) + after, start: start - 1, end: start - 1 };
  }
  if (!allowedChar(mode, action.char, before + after)) return { value: state.value, start, end };
  if (maxLength != null && maxLength >= 0 && (before + action.char + after).length > maxLength) return { value: state.value, start, end };
  const value = before + action.char + after;
  const caret = start + action.char.length;
  return { value, start: caret, end: caret };
}

export type ShiftState = "off" | "once" | "lock";

/** Shift: one tap for one capital, a second quick tap locks caps, a tap when locked turns it off. */
export function nextShift(current: ShiftState, doubleTap: boolean): ShiftState {
  if (current === "lock") return "off";
  if (current === "once") return doubleTap ? "lock" : "off";
  return "once";
}

/** After typing a letter, a one-time shift is used up. */
export function afterChar(current: ShiftState): ShiftState {
  return current === "once" ? "off" : current;
}
