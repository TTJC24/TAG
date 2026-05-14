"use client";

import { updateTodoNotes } from "@/lib/server-actions/todos";
import { NotesEditor } from "./notes-editor";

export function TodoNotesEditor({
  todoId,
  value,
  readOnly,
}: {
  todoId: string;
  value: string | null;
  readOnly?: boolean;
}) {
  return (
    <NotesEditor
      entityId={todoId}
      value={value}
      readOnly={readOnly}
      placeholder="to-do notes"
      onSave={(id, notes) => updateTodoNotes({ todoId: id, notes })}
    />
  );
}
