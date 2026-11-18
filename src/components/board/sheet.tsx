"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** A bottom sheet on phones, a centered dialog on larger screens. */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Set while the app closes the dialog itself (open became false), so that
  // close isn't reported back as the user closing it. Otherwise switching
  // from one sheet to another (details -> Edit) would cancel the new one.
  const closingFromProp = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) {
      closingFromProp.current = true;
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (closingFromProp.current) {
          closingFromProp.current = false;
          return;
        }
        onClose();
      }}
      aria-label={title}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border border-white/10 bg-surface p-0 text-foreground backdrop:bg-black/70 sm:m-auto sm:max-w-lg sm:rounded-2xl"
    >
      {open ? (
        <div className="space-y-5 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-bold uppercase italic">{title}</h2>
              {description ? <p className="text-sm text-muted">{description}</p> : null}
            </div>
            <button type="button" onClick={onClose} className="p-2 text-muted hover:text-foreground" aria-label="Close">
              <X aria-hidden className="size-5" />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
