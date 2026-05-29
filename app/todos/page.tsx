import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgTodos } from "@/lib/queries/org-lists";
import {
  AddTodoButton,
  TodosTable,
  type TodoTableRow,
} from "@/components/todo-dialogs";
import {
  Eyebrow,
  MetricStat,
  SummaryBar,
} from "@/components/ui/primitives";

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
    getOrgTodos(ctx.orgId),
    getOrgMembers(ctx.orgId),
  ]);
  const canCreate = ctx.role !== "viewer";
  const today = new Date().toISOString().slice(0, 10);

  // Map to a serializable, presentation-ready shape. Order is preserved
  // exactly as getOrgTodos returns it (dueDate asc, rolloverCount desc).
  const tableRows: TodoTableRow[] = rows.map(({ todo, owner }) => {
    const isOwner = todo.ownerId === ctx.personId;
    const readOnly =
      ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
    return {
      id: todo.id,
      description: todo.description,
      ownerId: todo.ownerId,
      ownerName: owner?.name ?? null,
      dueDate: todo.dueDate ?? null,
      notes: todo.notes,
      rolloverCount: todo.rolloverCount,
      done: todo.status === "done",
      isOverdue: !!(todo.dueDate && todo.dueDate < today),
      readOnly,
    };
  });

  const overdue = tableRows.filter((r) => r.isOverdue).length;
  const rolled = tableRows.filter((r) => r.rolloverCount > 0).length;

  return (
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <Eyebrow>{ctx.orgName} · To-Do&apos;s</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">
            Open commitments
          </h1>
          <SummaryBar>
            <MetricStat
              label="open"
              value={tableRows.length}
              tone="neutral"
            />
            <MetricStat
              label="overdue"
              value={overdue}
              tone={overdue > 0 ? "red" : "muted"}
            />
            <MetricStat
              label="rolled"
              value={rolled}
              tone={rolled > 0 ? "yellow" : "muted"}
            />
          </SummaryBar>
        </div>
        {canCreate && (
          <AddTodoButton members={members} defaultOwnerId={ctx.personId} />
        )}
      </header>

      <TodosTable rows={tableRows} members={members} />
    </main>
  );
}
