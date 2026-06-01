import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgTodos } from "@/lib/queries/org-lists";
import { AddTodoButton, TodoRowControls } from "@/components/todo-dialogs";
import { TodoCheckbox } from "@/components/todo-checkbox";
import { TodoRolloverButton } from "@/components/todo-rollover-button";
import { TodoNotesEditor } from "@/components/todo-notes-editor";
import { KeyHint, OwnerChip } from "@/components/ui/primitives";
import { SurfaceBlock, type BlockStatus } from "@/components/ui/surface-block";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function TodosPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  const [rows, members] = await Promise.all([
    getOrgTodos(ctx.orgId, { includeDone: true }),
    getOrgMembers(ctx.orgId),
  ]);
  const canCreate = ctx.role !== "viewer";
  const today = new Date().toISOString().slice(0, 10);

  const items = rows.map(({ todo, owner }) => {
    const done = todo.status === "done";
    const isOwner = todo.ownerId === ctx.personId;
    return {
      id: todo.id,
      description: todo.description,
      ownerId: todo.ownerId,
      ownerName: owner?.name ?? null,
      dueDate: todo.dueDate ?? null,
      notes: todo.notes,
      rolloverCount: todo.rolloverCount,
      done,
      isOverdue: !!(todo.dueDate && todo.dueDate < today && !done),
      readOnly: ctx.role === "viewer" || (ctx.role === "member" && !isOwner),
    };
  });

  const openCount = items.filter((i) => !i.done).length;
  const overdue = items.filter((i) => i.isOverdue).length;
  const rolled = items.filter((i) => i.rolloverCount > 0 && !i.done).length;
  const doneCount = items.filter((i) => i.done).length;

  return (
    <main className="container space-y-7 py-7">
      <SurfaceHeader eyebrow={`${ctx.orgName} · 7-day commitments`} title="To-Do's">
        <StatNumber value={openCount} label="open" hero />
        <StatNumber value={overdue} label="overdue" tone={overdue > 0 ? "red" : "muted"} />
        <StatNumber value={rolled} label="rolled" tone={rolled > 0 ? "yellow" : "muted"} />
        <StatNumber value={doneCount} label="done" tone="muted" />
        {canCreate && (
          <div className="self-center pl-1">
            <AddTodoButton members={members} defaultOwnerId={ctx.personId} />
          </div>
        )}
      </SurfaceHeader>

      {items.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No open to-do&apos;s for this org.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((i) => {
            const status: BlockStatus = i.done
              ? "muted"
              : i.isOverdue
                ? "red"
                : i.rolloverCount > 0
                  ? "yellow"
                  : "neutral";
            return (
              <SurfaceBlock
                key={i.id}
                status={status}
                className={cn(i.done && "opacity-60")}
              >
                <div className="flex items-start gap-4">
                  <div className="pt-1">
                    <TodoCheckbox todoId={i.id} done={i.done} readOnly={i.readOnly} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-base font-medium leading-snug tracking-tight text-foreground sm:text-lg",
                        i.done && "text-muted-foreground line-through",
                      )}
                    >
                      {i.description}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                      <OwnerChip name={i.ownerName} />
                      <span
                        className={cn(
                          "font-mono uppercase tracking-[0.14em]",
                          i.isOverdue ? "text-status-red" : "text-muted-foreground",
                        )}
                      >
                        {i.dueDate ? `due ${i.dueDate}` : "no due date"}
                      </span>
                      {i.rolloverCount > 0 && (
                        <KeyHint className="border-status-yellow/40 bg-status-yellow/10 text-status-yellow">
                          {i.rolloverCount}× carried
                        </KeyHint>
                      )}
                    </div>

                    <div className="mt-2">
                      <TodoNotesEditor
                        todoId={i.id}
                        value={i.notes}
                        readOnly={i.readOnly}
                      />
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <TodoRolloverButton todoId={i.id} readOnly={i.readOnly} />
                    <TodoRowControls
                      todoId={i.id}
                      members={members}
                      current={{
                        description: i.description,
                        ownerId: i.ownerId,
                        dueDate: i.dueDate ?? "",
                        notes: i.notes ?? "",
                      }}
                      readOnly={i.readOnly}
                    />
                  </div>
                </div>
              </SurfaceBlock>
            );
          })}
        </div>
      )}
    </main>
  );
}
