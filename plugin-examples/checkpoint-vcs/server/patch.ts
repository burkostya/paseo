import { filename } from "./store.js";

function lines(text: string | null) {
  if (!text) return [];
  const values = text.split("\n");
  if (text.endsWith("\n")) values.pop();
  return values;
}
function body(text: string | null, prefix: string) {
  const result = lines(text)
    .map((line) => `${prefix}${line}\n`)
    .join("");
  return text && !text.endsWith("\n") ? `${result}\\ No newline at end of file\n` : result;
}
/** Whole-file replacement keeps this teaching example independent of a diff executable. */
export function patch(before: string | null, after: string | null) {
  if (before === after) return "";
  const removed = lines(before).length;
  const added = lines(after).length;
  let mode = "";
  if (before === null) mode = "new file mode 100644\n";
  else if (after === null) mode = "deleted file mode 100644\n";
  const header = `diff --git a/${filename} b/${filename}\n${mode}--- ${before === null ? "/dev/null" : `a/${filename}`}\n+++ ${after === null ? "/dev/null" : `b/${filename}`}\n`;
  if (!removed && !added) return header;
  return `${header}@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n${body(before, "-")}${body(after, "+")}`;
}
