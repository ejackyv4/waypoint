/**
 * Sessions end without saying goodbye.
 *
 * A SCORM course is supposed to call Terminate when the learner leaves. On a
 * phone that almost never happens: the app is backgrounded and killed, or the
 * tab is closed, and the runtime session stays open forever. The registration
 * then shows "in progress" indefinitely and the completion webhook never
 * fires, even though the learner finished.
 *
 * So the server notices the silence itself. This is the backstop CLAUDE.md
 * calls for, and on mobile it is the common path rather than the edge case.
 *
 * It keeps whatever the last Commit gave us. Closing a session must never
 * change what the learner actually did — only record that it ended.
 */

import { idleRegistrations, now } from "./db/waypoint.mjs";
import { closeSession } from "./waypoint.mjs";
import { SESSION_IDLE_MS } from "./config.mjs";

let running = false;

export async function sweepIdleSessions(idleMs = SESSION_IDLE_MS) {
  // A slow webhook must not let two sweeps close the same session twice.
  if (running) return { closed: 0, skipped: true };
  running = true;
  try {
    const cutoff = new Date(Date.now() - idleMs).toISOString();
    const stale = idleRegistrations(cutoff);
    for (const reg of stale) {
      try {
        await closeSession(reg);
        console.log(`  [sweeper] closed registration ${reg.id} — silent since `
                  + `${reg.last_write_at || reg.started_at}`);
      } catch (e) {
        // One bad delivery must not stop the rest being closed.
        console.error(`  [sweeper] registration ${reg.id}:`, e.message);
      }
    }
    return { closed: stale.length };
  } finally { running = false; }
}
