// Shared between the service forms (client) and the server actions.

import { randomUuid } from "@/lib/uuid";

/** A task line as submitted: an existing item (id), a task-list task (taskId) or free text. */
export type ServiceTaskInput = { id?: string; taskId?: string; name: string };

/** Editable rows in the form. `key` is only for React. */
export type TaskRow = ServiceTaskInput & { key: string };
export type PartRow = {
  key: string;
  id?: string;
  name: string;
  partNumber: string;
  brand: string;
  supplier: string;
  quantity: string;
  unitCost: string;
};

export function newTaskRow(task: Omit<ServiceTaskInput, "id">): TaskRow {
  return { key: randomUuid(), ...task };
}

export function newPartRow(): PartRow {
  return { key: randomUuid(), name: "", partNumber: "", brand: "", supplier: "", quantity: "1", unitCost: "" };
}

/** The tasks list as JSON for the hidden form field. */
export function tasksPayload(rows: TaskRow[]): string {
  return JSON.stringify(
    rows
      .filter((r) => r.taskId || r.name.trim())
      .map(({ id, taskId, name }) => ({ ...(id ? { id } : {}), ...(taskId ? { taskId } : {}), name: name.trim() })),
  );
}

/** The parts list as JSON for the hidden form field. Empty rows are left out. */
export function partsPayload(rows: PartRow[]): string {
  return JSON.stringify(
    rows
      .filter((r) => r.name.trim() || r.unitCost.trim() || r.partNumber.trim())
      .map(({ id, name, partNumber, brand, supplier, quantity, unitCost }) => ({
        ...(id ? { id } : {}),
        name,
        partNumber,
        brand,
        supplier,
        quantity,
        unitCost,
      })),
  );
}

/** Parses a number typed in a form ("1,234.5"), or null. */
export function parseAmount(value: string): number | null {
  const normalized = value.replace(/[,\s$]/g, "");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
