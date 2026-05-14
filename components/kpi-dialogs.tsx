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
  archiveMeasurable,
  createMeasurable,
  updateMeasurable,
} from "@/lib/server-actions/measurables";
import type { OrgMemberOption } from "@/lib/queries/org-members";
import { cn } from "@/lib/utils";

const FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: "currency_usd", label: "Currency (USD)" },
  { value: "percent", label: "Percent" },
  { value: "days", label: "Days" },
  { value: "turns", label: "Turns (×)" },
  { value: "count", label: "Count" },
  { value: "currency_usd_trend", label: "Currency trend" },
];
const DIRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: "gte", label: "≥ (higher is better)" },
  { value: "lte", label: "≤ (lower is better)" },
  { value: "eq", label: "= exact" },
  { value: "between", label: "between (range)" },
  { value: "trend_down", label: "trending down" },
  { value: "trend_up", label: "trending up" },
];
const CADENCE_OPTIONS: { value: string; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

interface KPIInitial {
  measurableId?: string;
  name: string;
  ownerId: string;
  unit: string;
  formatHint: string;
  goalDirection: string;
  goalValue: string; // form-friendly string
  goalSecondary: string;
  cadence: string;
  formula: string;
}

const EMPTY: KPIInitial = {
  name: "",
  ownerId: "",
  unit: "",
  formatHint: "currency_usd",
  goalDirection: "gte",
  goalValue: "",
  goalSecondary: "",
  cadence: "weekly",
  formula: "",
};

function KPIForm({
  members,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  members: OrgMemberOption[];
  initial: KPIInitial;
  onCancel: () => void;
  onSubmit: (next: KPIInitial) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<KPIInitial>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function set<K extends keyof KPIInitial>(k: K, v: KPIInitial[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

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
      <FormField label="KPI name">
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Revenue (Weekly)"
          className={inputCls}
          disabled={pending}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Owner">
          <select
            value={draft.ownerId}
            onChange={(e) => set("ownerId", e.target.value)}
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
        <FormField label="Cadence">
          <select
            value={draft.cadence}
            onChange={(e) => set("cadence", e.target.value)}
            disabled={pending}
            className={selectCls}
          >
            {CADENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Format">
          <select
            value={draft.formatHint}
            onChange={(e) => set("formatHint", e.target.value)}
            disabled={pending}
            className={selectCls}
          >
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Direction">
          <select
            value={draft.goalDirection}
            onChange={(e) => set("goalDirection", e.target.value)}
            disabled={pending}
            className={selectCls}
          >
            {DIRECTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Goal" hint={draft.formatHint === "percent" ? "(decimal: 0.50 = 50%)" : ""}>
          <input
            value={draft.goalValue}
            onChange={(e) => set("goalValue", e.target.value)}
            placeholder="e.g. 250000"
            inputMode="decimal"
            className={cn(inputCls, "tabular font-mono")}
            disabled={pending}
          />
        </FormField>
        <FormField label="Goal secondary" hint="(only for between)">
          <input
            value={draft.goalSecondary}
            onChange={(e) => set("goalSecondary", e.target.value)}
            placeholder=""
            inputMode="decimal"
            className={cn(inputCls, "tabular font-mono")}
            disabled={pending || draft.goalDirection !== "between"}
          />
        </FormField>
      </div>
      <FormField label="Unit" hint="(optional, free-form: USD, days, %)">
        <input
          value={draft.unit}
          onChange={(e) => set("unit", e.target.value)}
          className={inputCls}
          disabled={pending}
        />
      </FormField>
      <FormField label="Formula / definition" hint="(optional, plain text)">
        <textarea
          value={draft.formula}
          onChange={(e) => set("formula", e.target.value)}
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

// ── Add ─────────────────────────────────────────────────────────────────────

export function AddKPIButton({ members }: { members: OrgMemberOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:bg-muted"
      >
        + add KPI
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New KPI">
        <KPIForm
          members={members}
          initial={EMPTY}
          onCancel={() => setOpen(false)}
          submitLabel="create"
          onSubmit={(d) =>
            createMeasurable({
              name: d.name,
              ownerId: d.ownerId,
              unit: d.unit || null,
              formatHint: d.formatHint,
              goalDirection: d.goalDirection as
                | "gte" | "lte" | "eq" | "between" | "trend_down" | "trend_up",
              goalValue: d.goalValue || null,
              goalSecondary: d.goalSecondary || null,
              cadence: d.cadence as "weekly" | "monthly",
              formula: d.formula || null,
            })
          }
        />
      </Dialog>
    </>
  );
}

// ── Edit + Archive ──────────────────────────────────────────────────────────

export function KPIRowControls({
  measurableId,
  members,
  current,
  readOnly,
  canArchive,
}: {
  measurableId: string;
  members: OrgMemberOption[];
  current: KPIInitial;
  readOnly?: boolean;
  canArchive?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) return null;

  function archive() {
    setError(null);
    startTransition(async () => {
      const r = await archiveMeasurable(measurableId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      setArchiving(false);
    });
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-muted hover:text-foreground"
        title="edit KPI"
      >
        edit
      </button>
      {canArchive && (
        <button
          type="button"
          onClick={() => setArchiving(true)}
          className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-rose-500/15 hover:text-rose-200"
          title="archive KPI"
        >
          archive
        </button>
      )}
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit KPI"
      >
        <KPIForm
          members={members}
          initial={current}
          onCancel={() => setEditing(false)}
          submitLabel="save"
          onSubmit={(d) =>
            updateMeasurable({
              measurableId,
              name: d.name,
              ownerId: d.ownerId,
              unit: d.unit || null,
              formatHint: d.formatHint,
              goalDirection: d.goalDirection as
                | "gte" | "lte" | "eq" | "between" | "trend_down" | "trend_up",
              goalValue: d.goalValue || null,
              goalSecondary: d.goalSecondary || null,
              cadence: d.cadence as "weekly" | "monthly",
              formula: d.formula || null,
            })
          }
        />
      </Dialog>
      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title="Archive KPI"
        size="sm"
      >
        <p className="text-sm">
          This KPI will be hidden from the active scorecard. Historical
          weekly entries are preserved.
        </p>
        <FormError error={error} />
        <FormActions>
          <CancelButton onClick={() => setArchiving(false)} disabled={pending} />
          <button
            type="button"
            onClick={archive}
            disabled={pending}
            className="rounded bg-rose-500/80 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition disabled:opacity-50"
          >
            {pending ? "…" : "archive"}
          </button>
        </FormActions>
      </Dialog>
    </span>
  );
}
