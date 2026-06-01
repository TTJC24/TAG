"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
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
import {
  DataTable,
  EmptyBlock,
  OwnerChip,
  SegmentedControl,
  StatusChip,
  Td,
  Th,
} from "@/components/ui/primitives";
import { RockNotesEditor } from "@/components/rock-notes-editor";
import { RockStatusSelect } from "@/components/rock-status-select";
import { cn } from "@/lib/utils";

type RockStatus = "on_track" | "off_track" | "still_going" | "completed";

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

// ── Rocks table — spine-led DataTable with client filter + keyboard nav ──────
// Pure presentation over server-fetched rows. Filtering and j/k/Enter focus are
// LOCAL UI state only; the server retains the off_track→on_track→still_going→
// completed sort and Liveblocks broadcast.

export interface RockRow {
  id: string;
  description: string;
  status: RockStatus;
  ownerName: string | null;
  quarter: string;
  dueDate: string | null;
  notes: string | null;
  readOnly: boolean;
  current: RockInitial;
}

const SPINE: Record<RockStatus, string> = {
  off_track: "spine-red",
  still_going: "spine-yellow",
  on_track: "spine-green",
  completed: "",
};

type RockFilter = "all" | "off_track" | "completed";

/** ISO date string is overdue when strictly before today and not completed. */
function isOverdue(dueDate: string | null, status: RockStatus): boolean {
  if (!dueDate || status === "completed") return false;
  const today = new Date().toISOString().slice(0, 10);
  return dueDate < today;
}

export function RocksTable({
  rows,
  members,
  canDelete,
}: {
  rows: RockRow[];
  members: OrgMemberOption[];
  canDelete: boolean;
}) {
  const [filter, setFilter] = useState<RockFilter>("all");
  const [focused, setFocused] = useState(0);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      off_track: rows.filter((r) => r.status === "off_track").length,
      completed: rows.filter((r) => r.status === "completed").length,
    }),
    [rows],
  );

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  // Clamp focus when the visible set shrinks (e.g. after filtering).
  useEffect(() => {
    setFocused((f) => (visible.length === 0 ? 0 : Math.min(f, visible.length - 1)));
  }, [visible.length]);

  const openNotes = useCallback((idx: number) => {
    const tr = rowRefs.current[idx];
    const btn = tr?.querySelector<HTMLButtonElement>("[data-notes-cell] button");
    btn?.focus();
    btn?.click();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
      // Don't hijack typing inside an open notes editor / inputs.
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((f) => {
          const n = Math.min(f + 1, visible.length - 1);
          rowRefs.current[n]?.focus();
          return n;
        });
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((f) => {
          const n = Math.max(f - 1, 0);
          rowRefs.current[n]?.focus();
          return n;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        openNotes(focused);
      }
    },
    [visible.length, focused, openNotes],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <SegmentedControl<RockFilter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "all", count: counts.all },
            { value: "off_track", label: "off-track", count: counts.off_track },
            { value: "completed", label: "completed", count: counts.completed },
          ]}
        />
        <span className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 sm:flex">
          <kbd className="rounded border border-border bg-surface-3 px-1">j</kbd>
          <kbd className="rounded border border-border bg-surface-3 px-1">k</kbd>
          move
          <kbd className="rounded border border-border bg-surface-3 px-1">⏎</kbd>
          notes
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyBlock>No rocks match this filter.</EmptyBlock>
      ) : (
        <div className="overflow-x-auto">
          <DataTable>
            <thead>
              <tr>
                <Th className="w-[1px] pl-4 pr-0" />
                <Th>Status</Th>
                <Th>Rock</Th>
                <Th>Owner</Th>
                <Th align="right">Quarter</Th>
                <Th align="right">Due</Th>
                <Th className="min-w-[16rem]">Notes</Th>
                <Th align="right" className="pr-4">
                  {" "}
                </Th>
              </tr>
            </thead>
            <tbody onKeyDown={onKeyDown}>
              {visible.map((r, i) => {
                const overdue = isOverdue(r.dueDate, r.status);
                return (
                  <tr
                    key={r.id}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    tabIndex={0}
                    onFocus={() => setFocused(i)}
                    aria-selected={i === focused}
                    className={cn(
                      "data-row group border-t border-border/60 outline-none transition-colors",
                      SPINE[r.status],
                      i === focused
                        ? "bg-surface-2"
                        : "hover:bg-surface-2/60",
                      "focus-visible:bg-surface-2",
                    )}
                  >
                    <Td className="pl-4 pr-0" />
                    <Td>
                      <RockStatusSelect
                        rockId={r.id}
                        status={r.status}
                        readOnly={r.readOnly}
                      />
                    </Td>
                    <Td className="max-w-[28rem] py-2 font-medium leading-snug text-foreground">
                      {r.description}
                    </Td>
                    <Td>
                      <OwnerChip name={r.ownerName} />
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {r.quarter}
                    </Td>
                    <Td
                      numeric
                      className={cn(
                        overdue ? "text-status-red" : "text-muted-foreground",
                      )}
                      title={overdue ? "overdue" : undefined}
                    >
                      {r.dueDate ?? "—"}
                    </Td>
                    <Td data-notes-cell className="min-w-[16rem] py-1.5">
                      <RockNotesEditor
                        rockId={r.id}
                        value={r.notes}
                        readOnly={r.readOnly}
                      />
                    </Td>
                    <Td align="right" className="pr-4">
                      <RockRowControls
                        rockId={r.id}
                        members={members}
                        current={r.current}
                        readOnly={r.readOnly}
                        canDelete={canDelete}
                      />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}
    </div>
  );
}

// Re-export status chips counts helper for the header summary bar.
export function RockStatusSummary({ rows }: { rows: RockRow[] }) {
  const counts = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc[r.status] += 1;
          return acc;
        },
        { off_track: 0, on_track: 0, still_going: 0, completed: 0 } as Record<
          RockStatus,
          number
        >,
      ),
    [rows],
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip tone="red">{counts.off_track} off-track</StatusChip>
      <StatusChip tone="green">{counts.on_track} on-track</StatusChip>
      <StatusChip tone="yellow">{counts.still_going} still going</StatusChip>
      <StatusChip tone="muted">{counts.completed} completed</StatusChip>
    </div>
  );
}
