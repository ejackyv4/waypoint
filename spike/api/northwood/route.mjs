/**
 * Ordering a day's stops by distance.
 *
 * The list an officer reads stays in appointment order — that is the schedule.
 * This answers a different question: given these places, what is the shortest
 * way round them all?
 *
 * Three honest limitations, stated here and on the screen:
 *
 * 1. **Straight-line distance.** No road network, so a river or a freeway
 *    between two points is invisible. Good enough to beat an arbitrary order
 *    across a metro area; not driving time, and never presented as such.
 *
 * 2. **Geocoding is an outbound call carrying a home address.** For a PoC it
 *    goes to OpenStreetMap's Nominatim, which needs no key. A real deployment
 *    should point this at the agency's own GIS or a contracted geocoder —
 *    that is a procurement decision, not a code change, and the one function
 *    below is where it would be made.
 *
 * 3. **Cached forever, keyed by the address it came from.** Each address is
 *    looked up once. Change the address and it is looked up again; nothing
 *    else re-fetches.
 */

import { one, run } from "../db/connect.mjs";
import { subjectByKey, officerBase, officerSchedule, visit } from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile } from "./shared.mjs";

/* Nominatim's usage policy asks for an identifying User-Agent and no more
   than one request a second. Both are honoured; a PoC that hammers a free
   public service is a PoC that gets blocked mid-demo. */
const GEOCODER = "https://nominatim.openstreetmap.org/search";
const UA = "Waypoint-PoC/1.0 (corrections supervision proof of concept)";
const MIN_GAP_MS = 1100;
let lastCall = 0;

const cityLine = p => [[p.city, p.state].filter(Boolean).join(", "), p.postal_code]
  .filter(Boolean).join(" ");

/**
 * Progressively coarser ways of asking where somebody lives.
 *
 * A geocoder given "412 Ridgeway Ave, Apt 3B" frequently returns nothing: a
 * unit number is not a place, and a street it has never heard of fails the
 * whole lookup. Falling back to the city and postcode still puts the stop
 * within a mile or two, which is more than enough to order a day — and a
 * route built from approximate points beats no route at all.
 *
 * Precision is recorded, so a screen can say "approximate" rather than imply
 * a doorstep-accurate pin.
 */
const addressLadder = p => [
  // Deliberately never with address_line2: the unit number helps the officer
  // find the door and actively hinders the geocoder.
  ["exact",       [p.address_line1, cityLine(p)].filter(Boolean).join(", ")],
  ["street",      [p.address_line1, p.city, p.state].filter(Boolean).join(", ")],
  ["approximate", cityLine(p)]
].filter(([, q]) => q);

/**
 * An address to a point, or null.
 *
 * Never throws: a route that cannot be optimised should fall back to the
 * schedule order, not fail. A geocoder being down is not a reason an officer
 * cannot see their day.
 */
export async function geocode(address) {
  if (!address) return null;
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  try {
    const url = `${GEOCODER}?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA },
                                 signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const [hit] = await r.json();
    if (!hit) return null;
    return { lat: Number(hit.lat), lon: Number(hit.lon) };
  } catch { return null; }
}

/** The subject's cached point, geocoding it once if the address has changed. */
export async function pointFor(subject_id) {
  const row = subjectByKey(subject_id);
  if (!row) return null;
  const ladder = addressLadder(row);
  if (!ladder.length) return null;

  // Keyed on the finest address, so any change re-runs the whole ladder.
  const key = ladder[0][1];
  if (row.latitude != null && row.geocoded_from === key)
    return { lat: row.latitude, lon: row.longitude,
             precision: row.geocode_precision || "exact" };

  for (const [precision, q] of ladder) {
    const hit = await geocode(q);
    if (!hit) continue;
    run(`UPDATE subjects SET latitude = ?, longitude = ?, geocoded_at = ?,
           geocoded_from = ?, geocode_precision = ? WHERE subject_id = ?`,
        hit.lat, hit.lon, new Date().toISOString(), key, precision, subject_id);
    return { ...hit, precision };
  }
  return null;
}

/* ---------------- the ordering ---------------- */

/** Great-circle miles. Straight line, and the screen says so. */
export function milesBetween(a, b) {
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const legs = (start, order) => order.reduce(
  (a, p, i) => a + milesBetween(i === 0 ? start : order[i - 1], p), 0);

/**
 * The shortest way round every stop, starting from one point.
 *
 * Exact below nine stops — 8! is 40,320 permutations, which is nothing, and
 * an exact answer beats a heuristic anybody would have to reason about.
 * Above that, nearest-neighbour then 2-opt until it stops improving, which
 * lands within a few percent and terminates.
 *
 * Deliberately not a round trip: an officer's last visit is where their day
 * ends, and adding a leg home would reorder the day around a destination
 * nobody asked for.
 */
export function shortestOrder(start, stops) {
  if (stops.length <= 1) return stops.map((_, i) => i);
  const idx = stops.map((_, i) => i);

  if (stops.length <= 8) {
    let best = null, bestMiles = Infinity;
    const permute = (rest, acc) => {
      if (!rest.length) {
        const d = legs(start, acc.map(i => stops[i]));
        if (d < bestMiles) { bestMiles = d; best = [...acc]; }
        return;
      }
      for (let i = 0; i < rest.length; i++)
        permute(rest.filter((_, j) => j !== i), [...acc, rest[i]]);
    };
    permute(idx, []);
    return best;
  }

  // Nearest neighbour…
  const left = new Set(idx);
  const order = [];
  let at = start;
  while (left.size) {
    let pick = null, near = Infinity;
    for (const i of left) {
      const d = milesBetween(at, stops[i]);
      if (d < near) { near = d; pick = i; }
    }
    order.push(pick); left.delete(pick); at = stops[pick];
  }
  // …then 2-opt: repeatedly reverse a span if doing so shortens the whole run.
  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++)
      for (let j = i + 1; j < order.length; j++) {
        const trial = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(),
                       ...order.slice(j + 1)];
        if (legs(start, trial.map(k => stops[k]))
            < legs(start, order.map(k => stops[k]))) {
          order.splice(0, order.length, ...trial); improved = true;
        }
      }
  }
  return order;
}

/**
 * Slot the flexible stops around the firm ones.
 *
 * The firm visits are anchors: somebody has been told a time and the route
 * does not get to move them. Each flexible stop is then dropped into whichever
 * gap adds the least driving — cheapest insertion, which is the obvious answer
 * and, more usefully, the one an officer can follow when they ask why a stop
 * ended up where it did.
 *
 * With no anchors this reduces to a plain shortest-route problem, and
 * `shortestOrder` does it exactly. With no flexible stops there is nothing to
 * decide, which is the whole point of the rule.
 */
export function orderAround(start, anchors, flexible) {
  if (!flexible.length) return anchors.map(a => a.i);
  if (!anchors.length)
    return shortestOrder(start, flexible.map(f => f.p)).map(k => flexible[k].i);

  const seq = anchors.map(a => ({ ...a }));          // fixed, in time order
  for (const f of flexible) {
    let bestAt = 0, bestCost = Infinity;
    for (let at = 0; at <= seq.length; at++) {
      const before = at === 0 ? start : seq[at - 1].p;
      const after = at === seq.length ? null : seq[at].p;
      // What this insertion adds: the detour out and back, less the leg it
      // replaces. A stop appended at the end only ever adds one leg.
      const cost = milesBetween(before, f.p)
                 + (after ? milesBetween(f.p, after) - milesBetween(before, after) : 0);
      if (cost < bestCost) { bestCost = cost; bestAt = at; }
    }
    seq.splice(bestAt, 0, { ...f });
  }
  return seq.map(x => x.i);
}

export const routes = {

  /**
   * Order a day's stops for the shortest drive.
   *
   * POST rather than GET because it may geocode, which is a write to the
   * cache and an outbound call — not something a page refresh should do
   * silently.
   */
  "POST /api/officer/route": async (req, res, ctx) => {
    const b = await readJson(req);

    /* Visits, not subjects: a route is a list of stops, and only the visit
       knows whether its time is a commitment. Times come from the record and
       never from the client — a route that trusted a caller's idea of when a
       visit is could be told anything. */
    const ids = [...new Set((b.visit_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return saasJson(res, 400, { error: "visit_ids required" });
    if (ids.length > 12)
      return saasJson(res, 400, {
        error: "A day of more than twelve stops is not a route, it is a week." });

    const mine = new Set(officerSchedule(ctx.session.officer_id).map(v => v.id));
    const stops = ids.map(visit).filter(v => v && mine.has(v.id));
    if (!stops.length)
      return saasJson(res, 404, { error: "no such visits on your schedule" });

    /* ---- where the day starts ---- */
    let startPoint = null, startLabel = null, startFrom = null;
    if (Number.isFinite(b.start_lat) && Number.isFinite(b.start_lon)) {
      startPoint = { lat: b.start_lat, lon: b.start_lon };
      startLabel = "your current location"; startFrom = "device";
    } else if (String(b.start || "").trim()) {
      startPoint = await geocode(String(b.start).trim());
      startLabel = String(b.start).trim();
      startFrom = startPoint ? "address" : null;
    }
    if (!startPoint) {
      const base = officerBase(ctx.session.officer_id);
      if (base?.address) {
        startPoint = await geocode(base.address);
        if (startPoint) { startLabel = base.name || base.address; startFrom = "office"; }
      }
    }

    const located = [], unlocated = [];
    for (const v of stops) {
      const p = await pointFor(v.subject_id);
      const s = asProfile(subjectByKey(v.subject_id));
      const row = { visit_id: v.id, subject_id: v.subject_id, name: s?.name,
                    address: s?.address, scheduled_at: v.scheduled_at,
                    time_fixed: !!v.time_fixed };
      if (p) located.push({ ...row, ...p }); else unlocated.push(row);
    }

    /* The rule, stated once: if every visit has a set time the order is
       already decided; if none does, the shortest drive is all that matters;
       and a mixed day anchors the firm ones and fits the rest around them. */
    const fixedCount = located.filter(x => x.time_fixed).length;
    const mode = fixedCount === located.length ? "scheduled"
               : fixedCount === 0 ? "optimised" : "anchored";

    const byTime = (a, b) =>
      String(a.scheduled_at || "").localeCompare(String(b.scheduled_at || ""));

    if (located.length < 2)
      return saasJson(res, 200, {
        mode, optimised: false, fixed_count: fixedCount,
        ordered: located.map(x => x.visit_id),
        stops: located, unlocated, miles: 0,
        note: located.length
          ? "Only one stop could be located, so there is nothing to reorder."
          : "None of these addresses could be located." });

    const origin = startPoint || located[0];
    const scheduleOrder = [...located].sort(byTime);

    let ordered;
    if (mode === "scheduled") {
      ordered = scheduleOrder;
    } else {
      const anchors = located.map((p, i) => ({ p, i })).filter(x => x.p.time_fixed)
                             .sort((a, c) => byTime(a.p, c.p));
      const flexible = located.map((p, i) => ({ p, i })).filter(x => !x.p.time_fixed);
      ordered = orderAround(origin, anchors, flexible).map(i => located[i]);
    }

    const before = legs(origin, scheduleOrder);
    const after = legs(origin, ordered);

    /* Two visits to the same person, or two people at one address, is not a
       route — and presenting a "shortest way round" between a place and
       itself is the sort of thing that makes somebody stop trusting the rest
       of the answer. */
    const places = new Set(located.map(x => `${x.lat.toFixed(4)},${x.lon.toFixed(4)}`));

    return saasJson(res, 200, {
      mode,
      optimised: mode !== "scheduled",
      fixed_count: fixedCount,
      ordered: ordered.map(x => x.visit_id),
      stops: ordered.map(x => ({ visit_id: x.visit_id, subject_id: x.subject_id,
                                 name: x.name, address: x.address,
                                 time_fixed: x.time_fixed,
                                 scheduled_at: x.scheduled_at,
                                 precision: x.precision })),
      unlocated,
      miles: Math.round(after * 10) / 10,
      miles_before: Math.round(before * 10) / 10,
      saved: Math.round((before - after) * 10) / 10,
      start_located: !!startPoint,
      start_label: startLabel,
      start_from: startFrom,
      approximate: ordered.some(x => x.precision !== "exact"),
      distinct_places: places.size,
      note: mode === "scheduled"
        ? "Every visit has a set time, so the order is already decided. This "
        + "opens them in schedule order."
        : mode === "anchored"
        ? (fixedCount === 1
            ? "One visit has a set time and holds its place; the rest are fitted "
            : `${fixedCount} visits have set times and hold their places; the rest are fitted `)
          + "around them. Straight-line distance, not driving distance."
        : "None of these has a set time, so they are ordered for the shortest "
        + "drive. Straight-line distance, not driving distance."
    });
  }
};
