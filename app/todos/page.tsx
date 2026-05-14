import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgTodos } from "@/lib/queries/org-lists";
import { TodoCheckbox } from "@/components/todo-checkbox";
import { TodoNotesEditor } from "@/components/todo-notes-editor";
import { TodoRolloverButton } from "@/components/todo-rollover-button";
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

  const rows = await getOrgTodos(ctx.orgId);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = rows.filter((r) => r.todo.dueDate && r.todo.dueDate < today).length;
  const rolled = rows.filter((r) => r.todo.rolloverCount > 0).length;

  return (
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgName} · To-Do&apos;s
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Open to-do&apos;s
        </h1>
        <p className="text-sm text-muted-foreground">
          Tick to mark done. &quot;Carry forward&quot; rolls a to-do into next week.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-card px-4 py-3 text-sm">
        <Pill color="red" label={`${overdue} overdue`} />
        <Pill color="amber" label={`${rolled} rolled over`} />
        <Pill color="muted" label={`${rows.length} total open`} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No open to-do&apos;s for this org.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Done</th>
                <th className="px-3 py-2 font-medium">To-Do</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium tabular">Due</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2 font-medium tabular">Rollover</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ todo, owner }) => {
                const isOwner = todo.ownerId === ctx.personId;
                const readOnly =
                  ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
                const isOverdue = !!(todo.dueDate && todo.dueDate < today);
                return (
                  <tr key={todo.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <TodoCheckbox
                        todoId={todo.id}
                        done={todo.status === "done"}
                        readOnly={readOnly}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{todo.description}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {owner?.name ?? "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 font-mono text-xs tabular",
                        isOverdue ? "text-rose-300" : "text-muted-foreground",
                      )}
                    >
                      {todo.dueDate ?? ""}
                      {isOverdue ? " · overdue" : ""}
                    </td>
                    <td className="px-3 py-2 min-w-[16rem]">
                      <TodoNotesEditor
                        todoId={todo.id}
                        value={todo.notes}
                        readOnly={readOnly}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular">
                      {todo.rolloverCount > 0 ? `${todo.rolloverCount}×` : ""}
                    </td>
                    <td className="px-3 py-2">
                      <TodoRolloverButton todoId={todo.id} readOnly={readOnly} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const DOT_STYLES: Record<"red" | "amber" | "muted", string> = {
  red: "bg-rose-400",
  amber: "bg-amber-400",
  muted: "bg-muted-foreground/40",
};

function Pill({
  color,
  label,
}: {
  color: "red" | "amber" | "muted";
  label: string;
}) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
      <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])} aria-hidden />
      {label}
    </span>
  );
}
