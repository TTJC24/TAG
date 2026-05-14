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
import { createRock, deleteRock, updateRock } from "@/lib/server-actions/rocks";
import type { OrgMemberOption } from "@/lib/queries/org-members";

interface RockInitial {
  description: string;
  ownerId: string;
  quarter: string;
  dueDate: string;
  notes: string;
}

const EMPTY: RockInitial = {
  description: "",
  ownerId: "",
  quarter: defaultQuarter(),
  dueDate: "",
  notes: "",
};

function defaultQuarter(): string {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${d.getFullYear()}`;
}

function RockForm({
  members,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  members: OrgMemberOption[];
  initial: RockInitial;
  onCancel: () => void;
  onSubmit: (next: RockInitial) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<RockInitial>(initial);
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
      <FormField label="Rock description">
        <textarea
          autoFocus
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="quarterly priority"
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
        <FormField label="Quarter">
          <input
            value={draft.quarter}
            onChange={(e) => setDraft({ ...draft, quarter: e.target.value })}
            placeholder="Q2 2026"
            className={inputCls}
            disabled={pending}
          />
        </FormField>
      </div>
      <FormField label="Due date" hint="(optional)">
        <input
          type="date"
          value={draft.dueDate}
          onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
          className={inputCls}
          disabled={pending}
        />
      </FormField>
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

export function AddRockButton({ members }: { members: OrgMemberOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:bg-muted"
      >
        + add rock
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New rock">
        <RockForm
          members={members}
          initial={EMPTY}
          onCancel={() => setOpen(false)}
          submitLabel="create"
          onSubmit={(d) =>
            createRock({
              description: d.description,
              ownerId: d.ownerId,
              quarter: d.quarter,
              dueDate: d.dueDate || null,
              notes: d.notes || null,
            })
          }
        />
      </Dialog>
    </>
  );
}

export function RockRowControls({
  rockId,
  members,
  current,
  readOnly,
  canDelete,
}: {
  rockId: string;
  members: OrgMemberOption[];
  current: RockInitial;
  readOnly?: boolean;
  canDelete?: boolean;
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
      const r = await deleteRock(rockId);
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
        title="edit rock"
      >
        edit
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={() => setRemoving(true)}
          className="rounded border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-100"
          title="remove rock"
        >
          remove
        </button>
      )}
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit rock">
        <RockForm
          members={members}
          initial={current}
          onCancel={() => setEditing(false)}
          submitLabel="save"
          onSubmit={(d) =>
            updateRock({
              rockId,
              description: d.description,
              ownerId: d.ownerId,
              quarter: d.quarter,
              dueDate: d.dueDate || null,
              notes: d.notes || null,
            })
          }
        />
      </Dialog>
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove rock"
        size="sm"
      >
        <p className="text-sm">
          This rock will be permanently deleted. Status history goes with it.
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
            {pending ? "…" : "delete"}
          </button>
        </FormActions>
      </Dialog>
    </span>
  );
}
