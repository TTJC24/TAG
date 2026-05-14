import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgTodos } from "@/lib/queries/org-lists";
import { TodoCheckbox } from "@/components/todo-checkbox";
import { AddTodoButton, TodoRowControls } from "@/components/todo-dialogs";
import { TodoNotesEditor } from "@/components/todo-notes-editor";
import { TodoRolloverButton } from "@/components/todo-rollover-button";
import {
  Eyebrow,
  OwnerChip,
  Panel,
  PanelHeader,
} from "@/components/ui/primitives";
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
    getOrgTodos(ctx.orgId),
    getOrgMembers(ctx.orgId),
  ]);
  const canCreate = ctx.role !== "viewer";
  const today = new Date().toISOString().slice(0, 10);
  const overdue = rows.filter((r) => r.todo.dueDate && r.todo.dueDate < today).length;
  const rolled = rows.filter((r) => r.todo.rolloverCount > 0).length;

  return (
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · To-Do&apos;s</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">
            Open commitments
          </h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <Pill tone="red" label={`${overdue} overdue`} />
          <Pill tone="amber" label={`${rolled} rolled`} />
          <Pill tone="muted" label={`${rows.length} open`} />
          {canCreate && (
            <AddTodoButton members={members} defaultOwnerId={ctx.personId} />
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No open to-do&apos;s for this org.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="To-Do" count={rows.length} hint="overdue first" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <Th className="pl-4 w-12">Done</Th>
                  <Th>To-Do</Th>
                  <Th>Owner</Th>
                  <Th className="tabular">Due</Th>
                  <Th>Notes</Th>
                  <Th className="tabular">Rollover</Th>
                  <Th> </Th>
                  <Th className="pr-4"> </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ todo, owner }) => {
                  const isOwner = todo.ownerId === ctx.personId;
                  const readOnly =
                    ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
                  const isOverdue = !!(todo.dueDate && todo.dueDate < today);
                  return (
                    <tr
                      key={todo.id}
                      className="border-t border-border/70 align-top"
                    >
                      <Td className="pl-4">
                        <TodoCheckbox
                          todoId={todo.id}
                          done={todo.status === "done"}
                          readOnly={readOnly}
                        />
                      </Td>
                      <Td className="font-medium">{todo.description}</Td>
                      <Td>
                        <OwnerChip name={owner?.name ?? null} />
                      </Td>
                      <Td
                        className={cn(
                          "font-mono text-xs tabular",
                          isOverdue ? "text-rose-300" : "text-muted-foreground",
                        )}
                      >
                        {todo.dueDate ?? <span className="text-muted-foreground/50">—</span>}
                        {isOverdue ? <span className="ml-1 uppercase tracking-[0.16em] text-[10px]">overdue</span> : null}
                      </Td>
                      <Td className="min-w-[16rem]">
                        <TodoNotesEditor
                          todoId={todo.id}
                          value={todo.notes}
                          readOnly={readOnly}
                        />
                      </Td>
                      <Td className="font-mono text-xs text-muted-foreground tabular">
                        {todo.rolloverCount > 0 ? `${todo.rolloverCount}×` : ""}
                      </Td>
                      <Td>
                        <TodoRolloverButton todoId={todo.id} readOnly={readOnly} />
                      </Td>
                      <Td className="pr-4 text-right">
                        <TodoRowControls
                          todoId={todo.id}
                          members={members}
                          current={{
                            description: todo.description,
                            ownerId: todo.ownerId,
                            dueDate: todo.dueDate ?? "",
                            notes: todo.notes ?? "",
                          }}
                          readOnly={readOnly}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-border/70 bg-card/40 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 text-sm", className)}>{children}</td>;
}

function Pill({
  tone,
  label,
}: {
  tone: "red" | "amber" | "muted";
  label: string;
}) {
  const dot =
    tone === "red"
      ? "bg-rose-400"
      : tone === "amber"
        ? "bg-amber-400"
        : "bg-muted-foreground/40";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}
