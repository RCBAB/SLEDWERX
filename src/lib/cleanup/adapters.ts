import type { SupabaseClient } from "@supabase/supabase-js";

import type { CleanupDb, CleanupStorage, RemovedObject } from "./run";

/**
 * Connects the cleanup run to a Supabase client created with the secret
 * (service-role) key. Only the cleanup_* database functions are called;
 * files are removed only through the Storage API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cleanupDeps(client: SupabaseClient<any, any, any>): { db: CleanupDb; storage: CleanupStorage } {
  return {
    db: {
      async rpc(fn, args) {
        if (!fn.startsWith("cleanup_")) throw new Error(`Not a cleanup function: ${fn}`);
        const { data, error } = await client.rpc(fn, args);
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
    },
    storage: {
      async remove(bucket, paths) {
        const { data, error } = await client.storage.from(bucket).remove(paths);
        return { data: (data ?? null) as RemovedObject[] | null, error: error ? { message: error.message } : null };
      },
    },
  };
}
