"use client";

import { updateIssueNotes } from "@/lib/server-actions/issues";
import { NotesEditor } from "./notes-editor";

export function IssueNotesEditor({
  issueId,
  value,
  readOnly,
}: {
  issueId: string;
  value: string | null;
  readOnly?: boolean;
}) {
  return (
    <NotesEditor
      entityId={issueId}
      value={value}
      readOnly={readOnly}
      placeholder="notes / root cause"
      onSave={(id, notes) => updateIssueNotes({ issueId: id, notes })}
    />
  );
}
