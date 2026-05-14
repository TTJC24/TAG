"use client";

import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "sm" | "md";
}

/** Minimal modal — fixed-position overlay + centered panel. No portal,
 *  no animation library. Esc closes. Backdrop-click closes. The body
 *  scroll-lock is omitted intentionally (these dialogs are short enough
 *  to fit on screen; lock would conflict with Clerk's own modals). */
export function Dialog({ open, onClose, title, children, size = "md" }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const widthCls = size === "sm" ? "max-w-sm" : "max-w-lg";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "mt-12 w-full rounded border border-border bg-card shadow-2xl",
          widthCls,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="rounded px-2 py-0.5 font-mono text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            esc
          </button>
        </header>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

// ── Small form helpers used by every entity dialog ──────────────────────────

export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-ring focus:outline-none";
export const textareaCls = `${inputCls} resize-y min-h-[3rem]`;
export const selectCls = inputCls;

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex items-center justify-end gap-2">{children}</div>;
}

export function CancelButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-muted disabled:opacity-50"
    >
      cancel
    </button>
  );
}

export function SubmitButton({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-primary px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-primary-foreground transition disabled:opacity-50"
    >
      {pending ? "…" : children}
    </button>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-mono text-[11px] text-rose-100">
      {error}
    </p>
  );
}
