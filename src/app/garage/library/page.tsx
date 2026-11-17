import type { Metadata } from "next";
import { Suspense } from "react";

import { createPackage, createTask } from "@/app/garage/library/actions";
import { AddNameForm, NamedRow, PackageCard } from "@/components/service/library";
import { FormSkeleton } from "@/components/sleds/skeletons";
import { requireUser } from "@/lib/auth/session";
import { listLibraryTasks, listPackages, listSledTasks, sledRoles } from "@/lib/service/queries";
import { sledName } from "@/lib/sleds/format";
import { listSleds } from "@/lib/sleds/queries";

export const metadata: Metadata = { title: "Tasks & packages" };

const h2 = "font-display text-2xl font-bold uppercase tracking-wide";

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">Tasks &amp; packages</h1>
      <p className="mt-2 text-muted">
        Your own maintenance tasks, ready to tick off when you log a service. Packages group tasks you do together.
      </p>
      <Suspense fallback={<div className="mt-8"><FormSkeleton /></div>}>
        <Library />
      </Suspense>
    </div>
  );
}

async function Library() {
  const user = await requireUser("/garage/library");
  const [tasks, packages, sleds, roles] = await Promise.all([
    listLibraryTasks(user.id),
    listPackages(user.id),
    listSleds(),
    sledRoles(user.id),
  ]);
  const manageable = sleds
    .map((s) => ({ id: s.id, name: sledName(s), role: s.ownerId === user.id ? ("owner" as const) : (roles.get(s.id) ?? "viewer") }))
    .filter((s) => s.role === "owner" || s.role === "editor");
  const sledTasks = await listSledTasks(manageable);

  return (
    <div className="mt-8 space-y-12">
      <section aria-labelledby="my-tasks">
        <h2 id="my-tasks" className={h2}>
          My tasks
        </h2>
        <p className="mt-1 text-sm text-muted">Reusable on all your snowmobiles.</p>
        <div className="mt-4 rounded-2xl border border-white/10 bg-surface/70 p-4">
          {tasks.length ? (
            <ul className="mb-4 divide-y divide-white/10" data-testid="library-tasks">
              {tasks.map((task) => (
                <li key={task.id} className="py-1.5">
                  <NamedRow id={task.id} name={task.name} version={task.version} kind="task" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-muted">No tasks yet.</p>
          )}
          <AddNameForm action={createTask} label="New task" button="Add task" placeholder="e.g. Change chaincase oil" />
        </div>
      </section>

      <section aria-labelledby="packages">
        <h2 id="packages" className={h2}>
          Packages
        </h2>
        <p className="mt-1 text-sm text-muted">For example a preseason service. Apply one to a service to add all its tasks.</p>
        {packages.length ? (
          <ul className="mt-4 space-y-4">
            {packages.map((pkg) => (
              <PackageCard key={pkg.id} pkg={pkg} libraryTasks={tasks} />
            ))}
          </ul>
        ) : null}
        <div className="mt-4">
          <AddNameForm action={createPackage} label="New package" button="Add package" placeholder="e.g. Preseason service" />
        </div>
      </section>

      {sledTasks.length ? (
        <section aria-labelledby="sled-tasks">
          <h2 id="sled-tasks" className={h2}>
            Snowmobile tasks
          </h2>
          <p className="mt-1 text-sm text-muted">Tasks that only apply to one snowmobile.</p>
          <div className="mt-4 space-y-4">
            {sledTasks.map((group) => (
              <div key={group.sledId} className="rounded-2xl border border-white/10 bg-surface/70 p-4" data-testid="sled-task-group">
                <h3 className="font-semibold">{group.sledName}</h3>
                {group.tasks.length ? (
                  <ul className="my-3 divide-y divide-white/10">
                    {group.tasks.map((task) => (
                      <li key={task.id} className="py-1.5">
                        <NamedRow id={task.id} name={task.name} version={task.version} kind="task" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="my-3 text-sm text-muted">No tasks for this snowmobile yet.</p>
                )}
                <AddNameForm action={createTask} sledId={group.sledId} label={`New task for ${group.sledName}`} button="Add" />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
