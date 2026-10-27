// QA-C373-RU-1 (S3, X-10): owner-visible text must be readable text. A writer REFUSES a Unicode control (Cc) or format (Cf)
// character in a title, description, reason, draft text or note: U+202E (right-to-left override) makes a refusal read like an
// allow, U+200D (zero-width joiner) and U+FEFF make two different words look the same, U+0007 (bell) is noise. A single-line
// field allows none of them; a multi-line field (draft text and note, rule description) allows TAB and LF only.
// `escapeControls` is the readable form for a stored legacy value (the UI has its own copy, `safeText` in src/ui/api.ts; a test
// pins both to one answer).
import type { RuleSpec } from "./engine.ts";

const BAD = /[\p{Cc}\p{Cf}]/u;

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** The text with every Cc/Cf character written out as ⟨U+202E⟩ (TAB and LF stay when `multiline`). */
export function escapeControls(s: string, multiline = false): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += BAD.test(ch) && !(multiline && (cp === 9 || cp === 10)) ? `⟨${hex(cp)}⟩` : ch;
  }
  return out;
}

/** "" when `value` is fine, else a plain sentence that names the field and the first bad character. */
export function controlProblem(field: string, value: string, multiline = false): string {
  let at = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (BAD.test(ch) && !(multiline && (cp === 9 || cp === 10))) {
      return `${field} contains a control or invisible character (${hex(cp)}) at position ${at + 1}. Remove it and try again${multiline ? " (only a tab and a line break are allowed here)" : ""}.`;
    }
    at += ch.length;
  }
  return "";
}

/** Writer check of a rule's own text: title and reason are single-line, the description may use tab and line break. "" = fine. */
export function textProblem(spec: Pick<RuleSpec, "title" | "outcome"> & { description?: string }): string {
  return controlProblem("The title", spec.title) || controlProblem("The reason", spec.outcome.reason) || controlProblem("The description", spec.description ?? "", true);
}
