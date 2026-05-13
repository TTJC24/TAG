// One-shot inspector for reference/TRACTION_MEETING_TEMPLATE.xlsx.
// Prints sheet names + first ~10 non-empty rows of each so we can design
// the importer against the real shape of the workbook. No DB writes.

import * as path from "node:path";
import * as XLSX from "xlsx";

const FILE = path.resolve(
  process.cwd(),
  "reference/TRACTION_MEETING_TEMPLATE.xlsx",
);

function main() {
  const wb = XLSX.readFile(FILE, { cellDates: true });
  console.log(`File: ${FILE}`);
  console.log(`Sheets (${wb.SheetNames.length}):`);
  for (const name of wb.SheetNames) {
    console.log(`  - ${name}`);
  }

  for (const name of wb.SheetNames) {
    console.log("");
    console.log("=".repeat(80));
    console.log(`SHEET: ${name}`);
    console.log("=".repeat(80));
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const ref = ws["!ref"];
    if (!ref) {
      console.log("(empty)");
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    console.log(
      `range: ${ref}  (${range.e.r - range.s.r + 1} rows × ${range.e.c - range.s.c + 1} cols)`,
    );
    // Pull as 2D array; truncate cells to keep output manageable.
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: true,
      blankrows: false,
    });
    for (let i = 0; i < aoa.length; i++) {
      const row = aoa[i] ?? [];
      const cells = row.map((c) => {
        if (c === null || c === undefined) return "";
        const s = typeof c === "string" ? c : String(c);
        return s.length > 60 ? s.slice(0, 60) + "…" : s;
      });
      console.log(`  r${String(i).padStart(3)}: [${cells.join(" | ")}]`);
    }
  }
}

main();
