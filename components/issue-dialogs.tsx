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
import {
  createIssue,
  deleteIssue,
  updateIssue,
} from "@/lib/server-actions/issues";
import type { OrgMemberOption } from "@/lib/queries/org-members";

interface IssueInitial {
  title: string;
  ownerId: string;
  priority: "critical" | "high" | "medium" | "low";
  rootCause: string;
}

const EMPTY: IssueInitial = {
  title: "",
  ownerId: "",
  priority: "medium",
  rootCause: "",
};

const PRIORITY_OPTIONS: { value: IssueInitial["priority"]; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function IssueForm({
  members,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  members: OrgMemberOption[];
  initial: IssueInitial;
  onCancel: () => void;
  onSubmit: (next: IssueInitial) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<IssueInitial>(initial);
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
      <FormField label="Issue">
        <input
          autoFocus
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="describe the issue in one line"
          className={inputCls}
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
        <FormField label="Priority">
          <select
            value={draft.priority}
            onChange={(e) =>
              setDraft({ ...draft, priority: e.target.value as IssueInitial["priority"] })
            }
            disabled={pending}
            className={selectCls}
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Notes / root cause" hint="(optional)">
        <textarea
          value={draft.rootCause}
          onChange={(e) => setDraft({ ...draft, rootCause: e.target.value })}
          rows={3}
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

export function AddIssueButton({
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
        className="focus-ring rounded border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:border-foreground/30 hover:bg-surface-3"
      >
        + add issue
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New issue">
        <IssueForm
          members={members}
          initial={{ ...EMPTY, ownerId: defaultOwnerId ?? "" }}
          onCancel={() => setOpen(false)}
          submitLabel="create"
          onSubmit={(d) =>
            createIssue({
              title: d.title,
              ownerId: d.ownerId,
              priority: d.priority,
              rootCause: d.rootCause || null,
            })
          }
        />
      </Dialog>
    </>
  );
}

export function IssueRowControls({
  issueId,
  members,
  current,
  readOnly,
  canDelete,
}: {
  issueId: string;
  members: OrgMemberOption[];
  current: IssueInitial;
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
      const r = await deleteIssue(issueId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      setRemoving(false);
    });
  }

  return (
    <span className="inline-flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:border-foreground/30 hover:bg-surface-3"
        title="edit issue"
      >
        edit
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={() => setRemoving(true)}
          className="focus-ring rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-100"
          title="remove issue"
        >
          remove
        </button>
      )}
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit issue">
        <IssueForm
          members={members}
          initial={current}
          onCancel={() => setEditing(false)}
          submitLabel="save"
          onSubmit={(d) =>
            updateIssue({
              issueId,
              title: d.title,
              ownerId: d.ownerId,
              priority: d.priority,
              rootCause: d.rootCause || null,
            })
          }
        />
      </Dialog>
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove issue"
        size="sm"
      >
        <p className="text-sm">
          This issue will be permanently deleted. Any to-dos that linked to
          it via parent_issue_id will have that link cleared.
        </p>
        <FormError error={error} />
        <FormActions>
          <CancelButton onClick={() => setRemoving(false)} disabled={pending} />
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="focus-ring rounded bg-rose-500/80 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition hover:bg-rose-500 disabled:opacity-50"
          >
            {pending ? "…" : "delete"}
          </button>
        </FormActions>
      </Dialog>
    </span>
  );
}
