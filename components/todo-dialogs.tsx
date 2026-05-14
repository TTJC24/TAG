"use client";

import { useState, useTransition, type FormEvent } from "react";
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
        className="rounded border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:bg-muted"
      >
        + add to-do
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
        className="rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:border-foreground/40 hover:bg-muted"
        title="edit to-do"
      >
        edit
      </button>
      <button
        type="button"
        onClick={() => setRemoving(true)}
        className="rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-100"
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
            className="rounded bg-rose-500/80 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition disabled:opacity-50"
          >
            {pending ? "…" : "drop"}
          </button>
        </FormActions>
      </Dialog>
    </span>
  );
}
