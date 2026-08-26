/**
 * SCORM semantics that both the server and the player must agree on.
 * Every rule here came from watching a real course misbehave — see the
 * findings list in docs/REQUIREMENTS.md.
 */

/**
 * Derive Waypoint's two columns from a SCORM 1.2 lesson_status write.
 *
 * 1.2 packs completion AND pass/fail into one field, so a course that
 * writes "completed" and then "passed" destroys the first fact. The fix
 * is that a status carrying only completion news must leave success
 * ALONE — that is the whole trick, and it is easy to implement
 * almost-right.
 */
export function applyStatus(raw, current = { completion: "not attempted", success: "unknown" }) {
  const out = { ...current };
  switch (String(raw)) {
    /* carries BOTH facts */
    case "passed":        out.completion = "completed";     out.success = "passed"; break;
    case "failed":        out.completion = "completed";     out.success = "failed"; break;
    /* carries completion only — must NOT touch success */
    case "completed":     out.completion = "completed";     break;
    case "incomplete":    out.completion = "incomplete";    break;
    case "browsed":       out.completion = "incomplete";    break;
    case "not attempted": out.completion = "not attempted"; break;
  }
  return out;
}

/**
 * Both time formats to seconds. Only seconds ever reach the database.
 *
 * SCORM 1.2 uses HHHH:MM:SS.SS — and the fractional part is OPTIONAL.
 * Rustici's own sample omits it, so a parser that requires .SS records
 * zero duration for every such course.
 * SCORM 2004 uses ISO 8601 durations (PT1H30M5S).
 */
export function toSeconds(s) {
  s = String(s || "").trim();
  if (!s) return 0;

  let m = s.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +("0." + m[4]) : 0);

  m = s.match(/^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/i);
  if (m) return (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0);

  return NaN;
}

export function fromSeconds(total, is2004 = false) {
  total = Math.max(0, Number(total) || 0);
  if (is2004)
    return `PT${Math.floor(total / 3600)}H${Math.floor((total % 3600) / 60)}M${(total % 60).toFixed(2)}S`;
  const pad = (n, w) => String(Math.floor(n)).padStart(w, "0");
  return `${pad(total / 3600, 4)}:${pad((total % 3600) / 60, 2)}:${pad(total % 60, 2)}`
       + `.${String(Math.round((total % 1) * 100)).padStart(2, "0")}`;
}

/** SCORM 1.2 caps suspend_data at 4096 chars; 2004 at 64000. Overflow
 *  silently breaks resume, so it must be detected and surfaced, never
 *  truncated. */
export const suspendCap = is2004 => (is2004 ? 64000 : 4096);
