"use client";

import { ArrowBigUp, ArrowBigUpDash, CornerDownLeft, Delete, Keyboard, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/components/ui/cn";
import {
  afterChar,
  allowsNegative,
  applyKey,
  keyboardModeFor,
  nextShift,
  type KeyAction,
  type KeyboardMode,
  type ShiftState,
} from "@/lib/keyboard/edit";

/**
 * SledWerx's on-screen keyboard for the Garage Board Wall Display only.
 *
 * - It is mounted only while the Wall Display is on (and the user's keyboard
 *   setting is on), and only reacts to fields inside the Garage Board.
 * - Keys never take focus (pointerdown is cancelled), so the field keeps its
 *   cursor; each key edits the field and fires a normal "input" event, so
 *   forms, validation and Save behave exactly as with typing.
 * - While it shows, the field's inputmode is "none" so the system touch
 *   keyboard (Windows, iPad) stays closed; the original is put back after.
 * - A physical key press hides it; tapping a field shows it again.
 * - Inside a dialog it is drawn in that dialog (the rest of the page is inert
 *   while a dialog is open), and the dialog shrinks above it.
 */

type Editable = HTMLInputElement | HTMLTextAreaElement;

const ROOT_SELECTOR = '[data-testid="garage-board"]';
const SAVED_INPUTMODE = "wallKeyboardInputmode"; // data-wall-keyboard-inputmode

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOLS = ["1234567890", "-/:;()&@\"'", "#$%+=*!?,."];

function isEditable(el: Element | null): el is Editable {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function modeOf(el: Editable): KeyboardMode | null {
  return keyboardModeFor({
    tagName: el.tagName,
    type: el instanceof HTMLInputElement ? el.type : undefined,
    inputMode: el.inputMode,
    readOnly: el.readOnly,
    disabled: el.disabled,
    dataset: el.dataset,
  });
}

function suppressSystemKeyboard(el: Editable) {
  if (el.dataset[SAVED_INPUTMODE] === undefined) {
    el.dataset[SAVED_INPUTMODE] = el.getAttribute("inputmode") ?? "";
    el.setAttribute("inputmode", "none");
  }
}

function restoreSystemKeyboard(el: Editable) {
  const saved = el.dataset[SAVED_INPUTMODE];
  if (saved === undefined) return;
  if (saved) el.setAttribute("inputmode", saved);
  else el.removeAttribute("inputmode");
  delete el.dataset[SAVED_INPUTMODE];
}

/** Sets a field's text the way typing does, so React and the form see a normal input. */
function setFieldValue(el: Editable, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // Some input types have no selection; the value is still set.
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function selection(el: Editable) {
  try {
    return { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  } catch {
    return { start: el.value.length, end: el.value.length };
  }
}

/** Keeps the field, its hint/error and the dialog's Save row in view above the keyboard. */
function reveal(el: Editable) {
  const field = (el.closest("label")?.parentElement as HTMLElement | null) ?? el;
  field.scrollIntoView({ block: "nearest" });
  const dialog = el.closest("dialog");
  const actions = dialog?.querySelector<HTMLElement>("[data-form-actions]");
  if (dialog && actions) {
    const overlap = field.getBoundingClientRect().bottom - actions.getBoundingClientRect().top;
    if (overlap > 0) dialog.scrollTop += overlap + 12;
  }
}

export function WallKeyboard() {
  const [target, setTarget] = useState<Editable | null>(null);
  const [mode, setMode] = useState<KeyboardMode>("text");
  /** The number pad shows ± only for fields that take negative values (suspension settings). */
  const [signed, setSigned] = useState(false);
  const [page, setPage] = useState<"letters" | "symbols">("letters");
  const [shift, setShift] = useState<ShiftState>("off");
  const lastShiftTap = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Editable | null>(null);
  const physical = useRef(false);

  const hide = useCallback(() => {
    if (targetRef.current) restoreSystemKeyboard(targetRef.current);
    targetRef.current = null;
    setTarget(null);
  }, []);

  const show = useCallback((el: Editable, nextMode: KeyboardMode) => {
    if (targetRef.current && targetRef.current !== el) restoreSystemKeyboard(targetRef.current);
    suppressSystemKeyboard(el);
    targetRef.current = el;
    setTarget(el);
    setMode(nextMode);
    setSigned(allowsNegative(el));
    setPage("letters");
    setShift("off");
  }, []);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as Element | null;
      if (!isEditable(el) || !el.closest(ROOT_SELECTOR)) return;
      const nextMode = modeOf(el);
      if (!nextMode || physical.current) return;
      show(el, nextMode);
    };
    const onFocusOut = () => {
      // Wait for focus to land: a key press never moves it, anything else hides the keyboard.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (targetRef.current && active !== targetRef.current) {
          if (isEditable(active) && active.closest(ROOT_SELECTOR) && modeOf(active) && !physical.current) return; // focusin handles it
          hide();
        }
      }, 0);
    };
    // A real key press means a physical keyboard is in use: get out of the way
    // and let it type normally. Esc closes the keyboard first (a second Esc
    // closes the dialog as usual).
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") {
        if (!targetRef.current) return;
        event.preventDefault();
        hide();
        return;
      }
      if (["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      const el = event.target as Element | null;
      if (!isEditable(el) || !el.closest(ROOT_SELECTOR)) return;
      physical.current = true;
      if (targetRef.current) hide();
    };
    // Tapping a field (touch or pen) brings the keyboard back after physical typing.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      const el = event.target as Element | null;
      if (!isEditable(el) || !el.closest(ROOT_SELECTOR)) return;
      physical.current = false;
      const nextMode = modeOf(el);
      if (nextMode && document.activeElement === el) show(el, nextMode);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    // A field already focused when the keyboard is switched on gets it too.
    const initial = window.setTimeout(() => {
      const active = document.activeElement;
      if (isEditable(active) && active.closest(ROOT_SELECTOR)) {
        const nextMode = modeOf(active);
        if (nextMode) show(active, nextMode);
      }
    }, 0);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      hide();
    };
  }, [hide, show]);

  // Make room: dialogs shrink above the keyboard, the page gets bottom space,
  // and the field (with its message and the Save row) is kept in view.
  // The field can disappear without a blur (its dialog closes after Save):
  // then there is nothing to show.
  const container = target?.isConnected ? (target.closest("dialog") ?? target.closest(ROOT_SELECTOR)) : null;
  const live = Boolean(target && container);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = panel.current;
    if (!live || !el) {
      delete root.dataset.wallKeyboard;
      root.style.removeProperty("--wall-keyboard-height");
      return;
    }
    const update = () => {
      root.style.setProperty("--wall-keyboard-height", `${el.offsetHeight}px`);
      root.dataset.wallKeyboard = "open";
      if (targetRef.current) reveal(targetRef.current);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      delete root.dataset.wallKeyboard;
      root.style.removeProperty("--wall-keyboard-height");
    };
  }, [target, mode, live]);

  if (!target || !container) return null;

  const press = (action: KeyAction) => {
    const el = targetRef.current;
    if (!el) return;
    const sel = selection(el);
    const maxLength = el.maxLength > 0 ? el.maxLength : undefined;
    const next = applyKey({ value: el.value, ...sel }, action, mode, maxLength);
    if (next.value !== el.value) setFieldValue(el, next.value, next.start);
    else el.setSelectionRange?.(next.start, next.end);
    reveal(el);
  };
  const type = (char: string) => {
    press({ kind: "char", char: shift === "off" ? char : char.toUpperCase() });
    setShift(afterChar);
  };
  const done = () => {
    const el = targetRef.current;
    hide();
    el?.blur();
  };
  const tapShift = () => {
    const now = Date.now();
    setShift((s) => nextShift(s, now - lastShiftTap.current < 400));
    lastShiftTap.current = now;
  };

  const numeric = mode !== "text";

  return createPortal(
    <div
      ref={panel}
      role="group"
      aria-label="On-screen keyboard"
      data-testid="wall-keyboard"
      data-mode={mode}
      data-signed={signed ? "true" : undefined}
      // Keys never take focus, so the field keeps its cursor and nothing blurs.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      className="fixed inset-x-0 bottom-0 z-[100] select-none border-t border-white/15 bg-[#14171c] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-12px_30px_rgba(0,0,0,0.5)]"
    >
      <div className={cn("mx-auto", numeric ? "max-w-xl" : "max-w-5xl")}>
        {numeric ? (
          <div className="grid grid-cols-4 gap-2">
            {["7", "8", "9"].map((k) => (
              <Key key={k} label={k} onPress={() => press({ kind: "char", char: k })} />
            ))}
            <Key label="Backspace" onPress={() => press({ kind: "backspace" })} tone="muted">
              <Delete aria-hidden className="size-7" />
            </Key>
            {["4", "5", "6"].map((k) => (
              <Key key={k} label={k} onPress={() => press({ kind: "char", char: k })} />
            ))}
            <Key label="Clear" onPress={() => press({ kind: "clear" })} tone="muted">
              Clear
            </Key>
            {["1", "2", "3"].map((k) => (
              <Key key={k} label={k} onPress={() => press({ kind: "char", char: k })} />
            ))}
            <Key label="Done" onPress={done} tone="accent" className="row-span-2 h-auto">
              Done
            </Key>
            {signed ? (
              <Key label="Plus or minus" onPress={() => press({ kind: "negate" })} tone="muted" className="text-2xl">
                ±
              </Key>
            ) : null}
            <Key label="Decimal point" onPress={() => press({ kind: "char", char: "." })} disabled={mode !== "decimal"}>
              .
            </Key>
            <Key label="0" onPress={() => press({ kind: "char", char: "0" })} className={signed ? undefined : "col-span-2"} />
          </div>
        ) : (
          <div className="space-y-2">
            {(page === "letters" ? LETTERS : SYMBOLS).map((row, i) => (
              <div key={row} className="flex justify-center gap-1.5 sm:gap-2">
                {i === 2 && page === "letters" ? (
                  <Key
                    label={shift === "lock" ? "Caps lock on" : "Shift"}
                    pressed={shift !== "off"}
                    onPress={tapShift}
                    tone="muted"
                    className="flex-[1.5]"
                  >
                    {shift === "lock" ? <ArrowBigUpDash aria-hidden className="size-7" /> : <ArrowBigUp aria-hidden className="size-7" />}
                  </Key>
                ) : null}
                {row.split("").map((k) => {
                  const shown = page === "letters" && shift !== "off" ? k.toUpperCase() : k;
                  return (
                    <Key
                      key={k}
                      label={shown}
                      onPress={() => (page === "letters" ? type(k) : press({ kind: "char", char: k }))}
                      className="flex-1"
                    />
                  );
                })}
                {i === 2 ? (
                  <Key label="Backspace" onPress={() => press({ kind: "backspace" })} tone="muted" className="flex-[1.5]">
                    <Delete aria-hidden className="size-7" />
                  </Key>
                ) : null}
              </div>
            ))}
            <div className="flex gap-1.5 sm:gap-2">
              <Key
                label={page === "letters" ? "Numbers and symbols" : "Letters"}
                onPress={() => setPage((p) => (p === "letters" ? "symbols" : "letters"))}
                tone="muted"
                className="flex-[1.5]"
              >
                {page === "letters" ? "123" : "ABC"}
              </Key>
              <Key label="," onPress={() => press({ kind: "char", char: "," })} className="flex-1" />
              <Key label="Space" onPress={() => press({ kind: "char", char: " " })} className="flex-[5]">
                Space
              </Key>
              <Key label="." onPress={() => press({ kind: "char", char: "." })} className="flex-1" />
              {target instanceof HTMLTextAreaElement ? (
                <Key label="New line" onPress={() => press({ kind: "char", char: "\n" })} tone="muted" className="flex-[1.5]">
                  <CornerDownLeft aria-hidden className="size-7" />
                </Key>
              ) : null}
              <Key label="Done" onPress={done} tone="accent" className="flex-[2]">
                Done
              </Key>
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Keyboard aria-hidden className="size-4" />
            SledWerx keyboard
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close keyboard"
            onClick={done}
            className="inline-flex h-10 items-center gap-1 rounded-md px-3 text-sm font-semibold text-muted hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
            Close
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}

function Key({
  label,
  onPress,
  children,
  className,
  tone = "plain",
  pressed,
  disabled,
}: {
  label: string;
  onPress: () => void;
  children?: ReactNode;
  className?: string;
  tone?: "plain" | "muted" | "accent";
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // Not in the tab order: the keyboard is for touch; physical keyboards type directly.
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "flex h-16 min-w-0 items-center justify-center rounded-lg text-2xl font-semibold transition-colors active:scale-[0.97] disabled:opacity-30",
        tone === "plain" && "bg-white/10 text-foreground active:bg-white/20",
        tone === "muted" && "bg-white/5 text-base text-foreground/90 active:bg-white/15",
        tone === "accent" && "bg-accent text-lg text-white active:bg-accent-hot",
        pressed && "ring-2 ring-accent",
        className,
      )}
    >
      {children ?? label}
    </button>
  );
}
