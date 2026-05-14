"use client";

import { updateRockNotes } from "@/lib/server-actions/rocks";
import { NotesEditor } from "./notes-editor";

export function RockNotesEditor({
  rockId,
  value,
  readOnly,
}: {
  rockId: string;
  value: string | null;
  readOnly?: boolean;
}) {
  return (
    <NotesEditor
      entityId={rockId}
      value={value}
      readOnly={readOnly}
      placeholder="rock notes"
      onSave={(id, notes) => updateRockNotes({ rockId: id, notes })}
    />
  );
}
