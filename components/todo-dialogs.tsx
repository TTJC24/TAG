"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  FormField,
  FormActions,
  FormError,
  CancelButton,
  SubmitButton,
  inputCls,
  selectCls,
  textareaCls,
} from "@/components/ui/dialog";
import { createTodo, deleteTodo, updateTodo } from "@/lib/server-actions/todos";
import type { OrgMemberOption } from "@/lib/queries/org-members";
import { TodoCheckbox } from "@/components/todo-checkbox";
import { TodoNotesEditor } from "@/components/todo-notes-editor";
import { TodoRolloverButton } from "@/components/todo-rollover-button";
import {
  DataTable,
  EmptyBlock,
  KeyHint,
  OwnerChip,
  Panel,
  PanelHeader,
  SegmentedControl,
  StatusDot,
  Td,
  Th,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface TodoInitial {
  description: string;
  ownerId: string;
  dueDate: string;
  notes: string;
}

const EMPTY: TodoInitial = {
  description: "",
  ownerId: "",
  dueDate: defaultDueDate(),
  notes: "",
};

function defaultDueDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function TodoForm({
  members,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  members: OrgMemberOption[];
  initial: TodoInitial;
  onCancel: () => void;
  onSubmit: (next: TodoInitial) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<TodoInitial>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!draft.ownerId) {
      setError("owner required");
      return;
    }
    startTransition(async () => {
      const r = await onSubmit(draft);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      onCancel();
    });
  }

  return (
    <form onSubmit={handle} className="space-y-3">
      <FormField label="To-Do">
        <textarea
          autoFocus
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="action item"
          rows={2}
          className={textareaCls}
          disabled={pending}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Owner">
          <select
            value={draft.ownerId}
            onChange={(e) => setDraft({ ...draft, ownerId: e.target.value })}
            disabled={pending}
            className={selectCls}
          >
            <option value="">— select —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Due date">
          <input
            type="date"
            value={draft.dueDate}
            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
            className={inputCls}
            disabled={pending}
          />
        </FormField>
      </div>
      <FormField label="Notes" hint="(optional)">
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={2}
          className={textareaCls}
          disabled={pending}
        />
      </FormField>
      <FormError error={error} />
      <FormActions>
        <CancelButton onClick={onCancel} disabled={pending} />
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
      </FormActions>
    </form>
  );
}

export function AddTodoButton({
  members,
  defaultOwnerId,
}: {
  members: OrgMemberOption[];
  defaultOwnerId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex items-center gap-1.5 rounded border border-border bg-surface-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:border-foreground/40 hover:bg-surface-3"
      >
        <span aria-hidden className="text-sm leading-none">
          +
        </span>
        add to-do
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New to-do">
        <TodoForm
          members={members}
          initial={{ ...EMPTY, ownerId: defaultOwnerId ?? "" }}
          onCancel={() => setOpen(false)}
          submitLabel="create"
          onSubmit={(d) =>
            createTodo({
              description: d.description,
              ownerId: d.ownerId,
              dueDate: d.dueDate || null,
              notes: d.notes || null,
            })
          }
        />
      </Dialog>
    </>
  );
}

export function TodoRowControls({
  todoId,
  members,
  current,
  readOnly,
}: {
  todoId: string;
  members: OrgMemberOption[];
  current: TodoInitial;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) return null;

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await deleteTodo(todoId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      setRemoving(false);
    });
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:border-foreground/40 hover:bg-surface-3"
        title="edit to-do"
      >
        edit
      </button>
      <button
        type="button"
        onClick={() => setRemoving(true)}
        className="focus-ring rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-status-red/50 hover:bg-status-red/10 hover:text-status-red"
        title="drop (soft close)"
      >
        drop
      </button>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit to-do">
        <TodoForm
          members={members}
          initial={current}
          onCancel={() => setEditing(false)}
          submitLabel="save"
          onSubmit={(d) =>
            updateTodo({
              todoId,
              description: d.description,
              ownerId: d.ownerId,
              dueDate: d.dueDate || null,
              notes: d.notes || null,
            })
          }
        />
      </Dialog>
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Drop to-do"
        size="sm"
      >
        <p className="text-sm">
          This to-do is marked dropped. It disappears from the open list but
          stays in the audit trail.
        </p>
        <FormError error={error} />
        <FormActions>
          <CancelButton onClick={() => setRemoving(false)} disabled={pending} />
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="focus-ring rounded bg-status-red/80 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition disabled:opacity-50"
          >
            {pending ? "…" : "drop"}
          </button>
        </FormActions>
      </Dialog>
    </span>
  );
}

// ── Client table — spine-led DataTable with SegmentedControl filter ─────────
// Pure presentation/UI state. Data arrives pre-sorted (dueDate asc, rollover
// desc) from getOrgTodos and is NEVER reordered here — only filtered.

export interface TodoTableRow {
  id: string;
  description: string;
  ownerId: string;
  ownerName: string | null;
  dueDate: string | null;
  notes: string | null;
  rolloverCount: number;
  done: boolean;
  /** Precomputed on the server against the org "today". */
  isOverdue: boolean;
  readOnly: boolean;
}

type TodoFilter = "all" | "overdue" | "rolled";

export function TodosTable({
  rows,
  members,
}: {
  rows: TodoTableRow[];
  members: OrgMemberOption[];
}) {
  const [filter, setFilter] = useState<TodoFilter>("all");

  const counts = useMemo(
    () => ({
      all: rows.length,
      overdue: rows.filter((r) => r.isOverdue).length,
      rolled: rows.filter((r) => r.rolloverCount > 0).length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    if (filter === "overdue") return rows.filter((r) => r.isOverdue);
    if (filter === "rolled") return rows.filter((r) => r.rolloverCount > 0);
    return rows;
  }, [rows, filter]);

  return (
    <Panel>
      <PanelHeader
        title="To-Do"
        count={visible.length}
        hint="overdue first"
        right={
          <SegmentedControl<TodoFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "all", count: counts.all },
              { value: "overdue", label: "overdue", count: counts.overdue },
              { value: "rolled", label: "rolled", count: counts.rolled },
            ]}
          />
        }
      />
      {visible.length === 0 ? (
        <EmptyBlock>
          {filter === "overdue"
            ? "No overdue to-do's. Clear runway."
            : filter === "rolled"
              ? "Nothing rolled over. Commitments are landing on time."
              : "No open to-do's for this org."}
        </EmptyBlock>
      ) : (
        <div className="overflow-x-auto">
          <DataTable sticky>
            <thead>
              <tr>
                <Th className="w-10 pl-4" align="center">
                  <span className="sr-only">Done</span>
                </Th>
                <Th>To-Do</Th>
                <Th>Owner</Th>
                <Th align="right">Due</Th>
                <Th align="center">Carry</Th>
                <Th>Notes</Th>
                <Th align="right" className="pr-4">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const spine = r.isOverdue
                  ? "spine-red"
                  : r.rolloverCount > 0
                    ? "spine-yellow"
                    : "";
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      "data-row group h-9 border-t border-border/60 align-middle transition-colors hover:bg-surface-2/60",
                      spine,
                    )}
                  >
                    <Td align="center" className="pl-4">
                      <TodoCheckbox
                        todoId={r.id}
                        done={r.done}
                        readOnly={r.readOnly}
                      />
                    </Td>
                    <Td className="max-w-[28rem] py-2">
                      <span
                        className={cn(
                          "text-sm leading-snug",
                          r.done && "text-muted-foreground line-through",
                        )}
                      >
                        {r.description}
                      </span>
                    </Td>
                    <Td className="py-2">
                      <OwnerChip name={r.ownerName} />
                    </Td>
                    <Td numeric className="py-2">
                      {r.dueDate ? (
                        <span
                          className={cn(
                            "inline-flex items-center justify-end gap-1.5",
                            r.isOverdue
                              ? "text-status-red"
                              : "text-muted-foreground",
                          )}
                        >
                          {r.isOverdue && (
                            <StatusDot status="red" className="h-1 w-1" />
                          )}
                          {r.dueDate}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </Td>
                    <Td align="center" className="py-2">
                      {r.rolloverCount > 0 ? (
                        <span title={`carried forward ${r.rolloverCount}×`}>
                          <KeyHint className="border-status-yellow/40 bg-status-yellow/10 text-status-yellow">
                            {r.rolloverCount}×
                          </KeyHint>
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-muted-foreground/30">
                          —
                        </span>
                      )}
                    </Td>
                    <Td className="min-w-[16rem] py-2">
                      <TodoNotesEditor
                        todoId={r.id}
                        value={r.notes}
                        readOnly={r.readOnly}
                      />
                    </Td>
                    <Td align="right" className="py-2 pr-4">
                      <div className="flex items-center justify-end gap-1.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <TodoRolloverButton
                          todoId={r.id}
                          readOnly={r.readOnly}
                        />
                        <TodoRowControls
                          todoId={r.id}
                          members={members}
                          current={{
                            description: r.description,
                            ownerId: r.ownerId,
                            dueDate: r.dueDate ?? "",
                            notes: r.notes ?? "",
                          }}
                          readOnly={r.readOnly}
                        />
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}
    </Panel>
  );
}
