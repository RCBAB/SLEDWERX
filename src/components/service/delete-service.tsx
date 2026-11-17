"use client";

import { Trash2 } from "lucide-react";
import { useActionState } from "react";

import { deleteService, type ServiceActionState } from "@/app/garage/service-actions";

/** Deletes a service record (soft delete, recoverable for 30 days). Owners and editors. */
export function DeleteServiceButton({ sledId, entryId, version, title }: { sledId: string; entryId: string; version: number; title: string }) {
  const [state, action, pending] = useActionState<ServiceActionState, FormData>(deleteService, {});
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Delete “${title}”? It can be recovered for 30 days.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="sledId" value={sledId} />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="version" value={version} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-muted hover:bg-white/5 hover:text-accent-hot disabled:opacity-60"
      >
        <Trash2 aria-hidden className="size-4" />
        {pending ? "Deleting…" : "Delete"}
      </button>
      {state.error ? <p className="text-sm text-accent-hot">{state.error}</p> : null}
    </form>
  );
}
