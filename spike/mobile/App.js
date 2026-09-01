/**
 * Waypoint — mobile shell.
 *
 * The course plays INSIDE this app. No hand-off to a browser, which is
 * the behavior the whole project exists to replace.
 *
 * The native side owns everything the course cannot be trusted with:
 *   · a header and a working exit, outside the frame
 *   · flushing progress when the OS backgrounds us — Terminate usually
 *     never arrives on a phone
 *   · Android's hardware back, which must exit rather than unmount and
 *     discard state
 *   · a WebView configured so uploaded course code cannot reach the
 *     filesystem, our cookies, or anywhere off the content origin
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, AppState, BackHandler, Image,
  KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View
} from "react-native";
import { WebView } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import {
  useAudioRecorder, useAudioRecorderState, useAudioPlayer, useAudioPlayerStatus,
  requestRecordingPermissionsAsync, setAudioModeAsync,
  IOSOutputFormat, AudioQuality
} from "expo-audio";
import { File } from "expo-file-system";
import DateTimePicker from "@react-native-community/datetimepicker";
import { API_BASE, SAAS_BASE, HOST, HOST_SOURCE, IS_DEV, DOOR_URL,
         SERVER_LABEL } from "./config";

const fmtDur = t => {
  t = Math.max(0, Math.round(Number(t) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${t % 60}s` : `${t}s`;
};

const C = {
  brand: "#2563eb", brandDark: "#1d4ed8", brandSoft: "#eff6ff",
  ink: "#0f172a", ink2: "#334155", muted: "#64748b", faint: "#94a3b8",
  line: "#e2e8f0", bg: "#eef2f6", surface: "#ffffff",
  ok: "#059669", okSoft: "#ecfdf5", err: "#dc2626", errSoft: "#fef2f2",
  amber: "#b45309", amberSoft: "#fffbeb", amberLine: "#fde68a"
};

/* ================================================================
   Sign in

   The learner authenticates against Waypoint with credentials the SaaS
   provisioned. The token that comes back is person-scoped: it lists
   their programs and asks for launch tickets. It cannot write to a
   registration — that still requires redeeming a ticket.
================================================================ */
function SignIn({ onSignedIn, notice }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /* One sign-in for two kinds of user. Staff live in Northwood, subjects in
     Waypoint, so both are tried. The person typing does not need to know
     which system holds their account.

     Each is attempted independently: a subject must still be able to sign in
     when Northwood is down, and staff when Waypoint is. Only if BOTH are
     unreachable is this a connection problem — treating the first failure as
     fatal locked subjects out for a reason that had nothing to do with them. */
  const submit = async () => {
    if (!identifier.trim() || !password) return setError("Enter your email and password.");
    setBusy(true); setError(null);
    const email = identifier.trim();

    /* no-confirm: signing in navigates to the signed-in screen, and both
       failure modes are reported through setError below. */
    const attempt = async (url, body) => {
      try {
        const r = await fetch(url, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        /* The status travels too. A 403 from the gate is not "wrong password"
           and not "server down" — it is a third thing with its own fix, and
           without the code there is no way to tell them apart. */
        return { reached: true, status: r.status, ok: r.ok,
                 body: await r.json().catch(() => ({})) };
      } catch {
        return { reached: false, status: 0, ok: false, body: {} };  // never reached
      }
    };

    try {
      const staff = await attempt(`${SAAS_BASE}/auth/login`, { email, password });
      if (staff.ok) {
        return onSignedIn({ kind: "officer", token: staff.body.token, user: staff.body.user });
      }

      const learner = await attempt(`${API_BASE}/api/auth/login`,
                                    { identifier: email, password });
      if (learner.ok) {
        return onSignedIn({ kind: "subject", token: learner.body.token,
                            person: learner.body.person });
      }

      if (staff.status === 403 || learner.status === 403) {
        /* The deployed server only answers addresses that have been allowed
           through. On a network it has not seen before that is a 403, which
           without this message reads as "the server is broken" — and the fix
           is a web page this app cannot show. So it says so, and hands over
           the address to visit. */
        setError(`This network has not been allowed through yet. Open `
               + `${DOOR_URL.replace(/^https?:\/\//, "")} in a browser, enter `
               + `the passphrase, then sign in here.`);
      } else if (!staff.reached && !learner.reached) {
        /* Name the address AND where it came from. "Can't reach the server"
           on its own sends people to check the server, when the usual cause
           is the laptop having moved network and the app holding an address
           that stopped existing at the last coffee shop. */
        setError(IS_DEV
          ? `Can't reach the server at ${HOST}. `
            + (HOST_SOURCE === "detected"
               ? "That is the machine serving this app, so the demo is "
               + "probably not running — try ./spike/demo start."
               : "This build has a fixed address; if the laptop has changed "
               + "network, restart the app so it can find the new one.")
          : `Can't reach ${SERVER_LABEL}. Check the connection — and if this `
            + `network is new, it may need allowing through at `
            + `${DOOR_URL.replace(/^https?:\/\//, "")}.`);
      } else {
        // One of them answered and said no. Don't reveal which system holds
        // the account — that is an enumeration hint.
        setError(learner.body.error || staff.body.error || "Incorrect email or password.");
      }
    } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}
                           style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.signInWrap} keyboardShouldPersistTaps="handled">
          <View style={s.signInMark}><Text style={s.signInMarkText}>W</Text></View>
          <Text style={s.signInTitle}>Waypoint</Text>
          <Text style={s.signInSub}>Sign in</Text>

          {/* An expired session is not a failed sign-in — it explains why the
              app returned here, and it clears the moment they type. */}
          {(error || notice) && (
            <View style={[s.signInError, !error && s.signInNotice]}>
              <Text style={[s.signInErrorText, !error && s.signInNoticeText]}>
                {error || notice}</Text>
            </View>
          )}

          <Text style={s.label}>Email</Text>
          <TextInput
            style={s.input} value={identifier} onChangeText={setIdentifier}
            autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            textContentType="username" placeholder="you@example.com"
            placeholderTextColor={C.faint} returnKeyType="next" />

          <Text style={s.label}>Password</Text>
          <TextInput
            style={s.input} value={password} onChangeText={setPassword}
            secureTextEntry autoCapitalize="none" textContentType="password"
            placeholder="••••••••" placeholderTextColor={C.faint}
            returnKeyType="go" onSubmitEditing={submit} />

          <Pressable style={({ pressed }) => [s.primaryBtn, pressed && { backgroundColor: C.brandDark },
                                              busy && { opacity: 0.6 }]}
                     onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" />
                  : <Text style={s.primaryBtnText}>Sign in</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ================================================================
   Program list
================================================================ */
/* Initials avatar, colored deterministically so it is recognizable. A ring
   means the subject has a Waypoint login — the same signal the console uses,
   so an officer reads one thing in both places. RN has no outer box-shadow,
   so the ring is a padded wrapper rather than a border on the circle: a border
   would eat into the size and shift the row. */
function Avatar({ name, size = 46, hasLogin = false, onBrand = false }) {
  const initials = String(name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  const circle = (
    <View style={{ width: size, height: size, borderRadius: size / 2,
                   /* A name-derived hue lands on blue often enough to vanish
                      into a blue header, so on brand it gets a ring. */
                   backgroundColor: `hsl(${h}, 42%, 42%)`,
                   borderWidth: onBrand ? 2 : 0, borderColor: "rgba(255,255,255,0.85)",
                   alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
  if (!hasLogin) return circle;
  const pad = Math.max(3, Math.round(size * 0.075));
  return (
    <View accessibilityLabel={`${name} — has a Waypoint login`}
          style={{ padding: pad, borderRadius: (size + pad * 2) / 2,
                   backgroundColor: C.brand }}>
      <View style={{ padding: 2, borderRadius: (size + 4) / 2, backgroundColor: C.surface }}>
        {circle}
      </View>
    </View>
  );
}

/* Stored 24-hour, shown 12-hour. */
function to12h(hhmm) {
  if (!hhmm) return "";
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m ?? 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
const CS_LABEL = { todo: "To do", in_progress: "In progress", complete: "Complete" };
const EMPLOY_LABEL = { employed: "Employed", self_employed: "Self-employed",
                       not_employed: "Not employed" };

/** One line describing where someone works. Employer details only exist for
 *  status 'employed', so the other two never try to show them. */
function employmentSummary(e) {
  if (!e || e.status === "not_employed") return "Not currently employed";
  if (e.status === "self_employed") return "Self-employed";
  return [e.company_name || "Employed",
          e.supervisor ? `Supervisor ${e.supervisor}` : ""].filter(Boolean).join(" · ");
}

const TRAVEL_LABEL = { none: "None", local: "Local only",
                       interstate: "Interstate", international: "International" };
const asDate = d => d ? new Date(d + "T00:00:00")
  .toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" }) : "";
/* A full timestamp, for things that are a matter of record. */
const asDateTime = t => t ? new Date(t).toLocaleString(undefined,
  { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const isExpired = t => !!(t?.expires_on && new Date(t.expires_on + "T23:59:59") < new Date());

/* Amounts travel as integer cents and become a string exactly here, so a
   balance cannot be formatted two ways on two screens. */
const money = c => (c < 0 ? "-" : "") + "$" +
  (Math.abs(c || 0) / 100).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DATE_STATE = { assigned: "Assigned", viewed: "Viewed", accepted: "Accepted",
  completed: "Completed", missed: "Missed", cancelled: "Cancelled" };

/* Red while they have not agreed to be there, or the day has passed with
   nothing reported. Amber once everything outstanding is confirmed. */
/* One colour rule for an appointment's state, used by the subject's card and
   the officer's case file, so the two never disagree about what red means. */
const datePill = (st, late) => late || ["assigned", "viewed", "missed"].includes(st)
  ? s.pillErr : st === "accepted" || st === "completed" ? s.pillOk : s.pillMuted;
const dateInk = (st, late) => late || ["assigned", "viewed", "missed"].includes(st)
  ? C.err : st === "accepted" || st === "completed" ? C.ok : C.muted;

function dateBadge(dates) {
  const open = (dates || []).filter(d => d.status === "scheduled");
  if (!open.length) return null;
  const urgent = open.some(d => d.state === "assigned" || d.state === "viewed"
                             || d.awaiting_outcome);
  return { n: open.length, colour: urgent ? C.err : C.amber };
}

const FIN_KIND = { fine: "Fine", restitution: "Restitution",
  court_costs: "Court costs", supervision_fee: "Supervision fee",
  program_fee: "Program fee", testing_fee: "Drug testing fee", other: "Other" };
const FIN_STATE = { outstanding: "Outstanding", part_paid: "Part paid",
  overdue: "Overdue", paid: "Paid", waived: "Waived" };

/* A date of birth is only useful next to the age it implies — an officer is
   working out whether the person at the door is the person on the file.
   Same wording as the console, so the two never read differently. */
const ageFrom = d => {
  if (!d) return null;
  const b = new Date(d + "T00:00:00"), now = new Date();
  if (isNaN(b)) return null;
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
};

const longDate = d => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined,
  { month: "long", day: "numeric", year: "numeric" }) : "";

const dobLine = d => {
  if (!d) return "";
  const a = ageFrom(d);
  return longDate(d) + (a === null ? "" : ` (${a})`);
};

function fmtVisit(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short",
                                       hour: "2-digit", minute: "2-digit" });
}

/**
 * Pull to refresh, the same on every screen that shows server state.
 *
 * Its own hook because there were four hand-rolled versions and five screens
 * without one at all — including the subject's main tab, which is exactly
 * where somebody waiting on their officer would pull.
 *
 * Not every scrolling view gets one: a sign-in form, a modal sheet, a
 * dropdown and the course player all scroll, and none of them has anything
 * to re-read.
 *
 * It tracks its own `refreshing` rather than borrowing a screen's `busy`
 * flag. Those are different states: `busy` means a save is in flight, and
 * wiring it here made saving a note spin the pull-to-refresh indicator.
 */
function usePullToRefresh(load) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);
  return (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />
  );
}

/* ================================================================
   Officer — Schedule and Caseload
================================================================ */
/* The whole address, including line 2. Dropping the unit number sends an
   officer to a building rather than a door, and it is the half of an address
   that is easiest to omit and most expensive to be missing. */
const addressOf = v => [v.address_line1, v.address_line2,
                        [[v.city, v.state].filter(Boolean).join(", "), v.postal_code]
                          .filter(Boolean).join(" ")]
  .filter(Boolean).join("\n");

/** One line, for somewhere there is no room for two. */
const addressLine = v => addressOf(v).replace(/\n/g, ", ");

/**
 * The whole day as one trip.
 *
 * The origin is left off deliberately: with no origin, Google Maps starts from
 * wherever the phone is, which is what an officer in a car wants and is one
 * fewer thing to type. Nine waypoints plus a destination is the URL API's
 * ceiling, so a long day opens as far as it can rather than failing.
 *
 * No address is geocoded and nothing is sent to us — the link is built here
 * and opened by the map app on the officer's own device.
 */
function openRoute(addresses, origin) {
  const stops = addresses.map(a => String(a || "").replace(/\n/g, ", ")).filter(Boolean);
  if (!stops.length) return;
  if (stops.length === 1) return openMaps(stops[0]);

  const take = stops.slice(0, 10);
  const e = encodeURIComponent;
  const url = `https://www.google.com/maps/dir/?api=1`
            + (origin ? `&origin=${e(String(origin).replace(/\n/g, ", "))}` : "")
            + `&destination=${e(take[take.length - 1])}`
            + `&waypoints=${take.slice(0, -1).map(e).join("%7C")}`
            + `&travelmode=driving`;
  Linking.openURL(url).catch(() => toast("Couldn't open a map application", "err"));
}

/** Hand the address to whatever map app the platform prefers. */
function openMaps(address) {
  address = String(address || "").replace(/\n/g, ", ");
  if (!address) return;
  const q = encodeURIComponent(address);
  const url = Platform.select({
    ios: `maps://?q=${q}`,
    android: `geo:0,0?q=${q}`,
    default: `https://www.google.com/maps/search/?api=1&query=${q}`
  });
  Linking.openURL(url).catch(() =>
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`));
}

const dayLabel = t => {
  const d = new Date(t), today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today.getTime() + 864e5);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};
const timeLabel = t => new Date(t)
  .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function OfficerHome({ auth, onSignOut }) {
  const [tab, setTab] = useState("schedule");
  const [data, setData] = useState(null);
  const [caseload, setCaseload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null);   // { mode, visit?, subject? }
  const [openVisitId, setOpenVisitId] = useState(null);   // a visit being conducted
  const [viewing, setViewing] = useState(null);   // a subject's file

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [a, b] = await Promise.all([
        authed(`${SAAS_BASE}/api/officer/schedule`, auth.token),
        authed(`${SAAS_BASE}/api/officer/caseload`, auth.token)
      ]);
      setData(await a.json());
      setCaseload((await b.json()).subjects || []);
    } catch {} finally { setBusy(false); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  /* A caseload changes at the desk, not only in this app: a subject is
     transferred, a visit is scheduled, a request comes in. Coming back to the
     foreground is when an officer looks — so that is when we re-read, rather
     than showing them whatever was true when the app last started. */
  useEffect(() => {
    const sub = AppState.addEventListener("change", st => { if (st === "active") load(); });
    return () => sub.remove();
  }, [load]);

  /* Both of these call the SAME endpoints the web console uses. There is one
     API and two clients — the subject still has to accept a visit scheduled
     from a doorstep exactly as if it came from a desk. */
  /* One write path, so none of these can go quiet. A failed save used to look
     exactly like a successful one: the sheet closed either way. */
  const write = async (path, body, okMsg) => {
    try {
      const r = await authed(`${SAAS_BASE}${path}`, auth.token, {
        method: "POST", body: JSON.stringify(body) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast(d.error || "Couldn't save — please try again", "err");
        return false;
      }
      toast(okMsg);
      setSheet(null); load();
      return true;
    } catch {
      toast("No connection — nothing was saved", "err");
      return false;
    }
  };

  /* The officer has arrived. The start time is stamped server-side at this
     moment — a time typed in afterwards is a recollection, and this record may
     end up supporting a revocation. */
  /* Starting a visit OPENS it. The officer is now standing at a door, and
     what they see next belongs in the record — not in their memory until
     they get back to the car. */
  const startVisit = async v => {
    const ok = await write("/api/visits/start", { id: v.id, officer: auth.user?.name },
                           `Visit started — ${v.subject_name}`);
    if (ok) setOpenVisitId(v.id);
  };

  const addVisitNote = (id, body) =>
    write("/api/visits/note", { id, body, officer: auth.user?.name }, "Note added");

  const coverAgenda = (item, covered) =>
    write("/api/visits/agenda/item/cover", { id: item.id, covered },
          covered ? "Marked discussed" : "Marked not discussed");

  const addVisitPhoto = async (id, { data, mime_type }) => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/visits/photo`, auth.token, {
        method: "POST",
        body: JSON.stringify({ id, data, mime_type, officer: auth.user?.name })
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast(d.error || "Couldn't save that photo", "err");
        return;
      }
      toast("Photo added");
      await load();
    } catch { toast("No connection — the photo was not saved", "err"); }
    finally { setBusy(false); }
  };

  /* Audio from the visit. Same shape as a photograph — sent as base64, named
     and sized by the server — because the same rules apply to both. */
  const addVisitRecording = async (id, { data, mime_type, duration_ms }) => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/visits/recording`, auth.token, {
        method: "POST",
        body: JSON.stringify({ id, data, mime_type, duration_ms,
                               officer: auth.user?.name })
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast(d.error || "Couldn't save that recording", "err");
        return;
      }
      toast("Recording saved");
      await load();
    } catch { toast("No connection — the recording was not saved", "err"); }
    finally { setBusy(false); }
  };

  const completeVisit = (v, note, observations) =>
    write("/api/visits/complete",
          { id: v.id, officer: auth.user?.name, note: note || null, observations },
          "Visit recorded");

  /**
   * @param id  the requested visit being answered, when there is one.
   *
   * Two endpoints, deliberately, and the console uses both the same way:
   *
   *   /api/visits           books a NEW visit
   *   /api/visits/schedule  answers an EXISTING request
   *
   * The second is not a convenience wrapper. Answering a request turns that
   * row into the scheduled visit — status and all — so the subject stops being
   * told their request is pending. Booking a new visit instead would leave
   * their request open beside an appointment they were never told was for it.
   *
   * It also refuses a request that has already been given a date, which is the
   * guard against two officers answering the same one.
   */
  const scheduleVisit = (subject_id, when, note, id) =>
    id
      ? write("/api/visits/schedule",
              { id, scheduled_at: when.toISOString(), officer: auth.user?.name,
                notes: note || undefined },
              `Request answered — visit set for ${fmtVisit(when.toISOString())}`)
      : write("/api/visits",
              { subject_id, scheduled_at: when.toISOString(),
                officer: auth.user?.name, notes: note || null },
              `Visit scheduled for ${fmtVisit(when.toISOString())}`);

  const pending = data?.requests?.length || 0;

  if (viewing) return (
    <OfficerSubject auth={auth} subject={viewing} onBack={() => { setViewing(null); load(); }} />
  );

  /* While a visit is open it owns the screen. Anything else is a distraction
     from the thing the officer is actually doing. */
  const openVisit = openVisitId &&
    (data?.upcoming || []).find(v => v.id === openVisitId);
  if (openVisit) return (
    <>
      <VisitInProgress
        auth={auth} visit={openVisit} busy={busy}
        onAddNote={body => addVisitNote(openVisit.id, body)}
        onAddPhoto={photo => addVisitPhoto(openVisit.id, photo)}
        onAddRecording={rec => addVisitRecording(openVisit.id, rec)}
        onCoverAgenda={coverAgenda}
        onRefresh={load}
        onClose={() => setOpenVisitId(null)}
        onEnd={() => setSheet({ mode: "complete", visit: openVisit })} />
      {sheet?.mode === "complete" && (
        <CompleteSheet visit={sheet.visit} onCancel={() => setSheet(null)}
          onSave={(note, obs) => {
            setOpenVisitId(null);
            return completeVisit(sheet.visit, note, obs);
          }} />
      )}
    </>
  );

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.profileBar}>
        <Avatar name={auth.user?.name} />
        <View style={{ flex: 1 }}>
          <Text style={s.profileName}>{auth.user?.name}</Text>
          <Text style={s.profileMeta}>Northwood Corrections · {auth.user?.role}</Text>
        </View>
        <Pressable onPress={onSignOut} hitSlop={10}>
          <Text style={s.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <View style={s.tabs}>
        <Pressable style={[s.tab, tab === "schedule" && s.tabOn]} onPress={() => setTab("schedule")}>
          <Text style={[s.tabText, tab === "schedule" && s.tabTextOn]}>Schedule</Text>
          {pending > 0 && <View style={s.badge}><Text style={s.badgeText}>{pending}</Text></View>}
        </Pressable>
        <Pressable style={[s.tab, tab === "caseload" && s.tabOn]} onPress={() => setTab("caseload")}>
          <Text style={[s.tabText, tab === "caseload" && s.tabTextOn]}>Caseload</Text>
        </Pressable>
      </View>

      {tab === "schedule"
        ? <OfficerSchedule auth={auth} data={data} busy={busy} onRefresh={load}
            onStart={v => (v.started_at ? setOpenVisitId(v.id) : startVisit(v))}
            onComplete={v => setSheet({ mode: "complete", visit: v })}
            onSchedule={v => setSheet({ mode: "schedule",
              subject: { subject_id: v.subject_id, name: v.subject_name } })}
            /* A request carries its own visit id and the reason they gave. Both
               travel to the sheet: the id so the request is answered rather
               than duplicated, the reason so the officer picks a date knowing
               what it is for. */
            onScheduleRequest={r => setSheet({ mode: "schedule",
              subject: { subject_id: r.subject_id, name: r.subject_name },
              visitId: r.id, askedFor: r.request_note || "" })} />
        : <OfficerCaseload subjects={caseload} busy={busy} onRefresh={load}
            onOpen={setViewing}
            onSchedule={sub => setSheet({ mode: "schedule", subject: sub })} />}

      {sheet?.mode === "complete" && (
        <CompleteSheet visit={sheet.visit} onCancel={() => setSheet(null)}
                       onSave={(note, obs) => completeVisit(sheet.visit, note, obs)} />
      )}
      {sheet?.mode === "schedule" && (
        <ScheduleSheet subject={sheet.subject} askedFor={sheet.askedFor}
                       onCancel={() => setSheet(null)}
                       onSave={(when, note) =>
                         scheduleVisit(sheet.subject.subject_id, when, note, sheet.visitId)} />
      )}
    </SafeAreaView>
  );
}

/* A sheet rather than a screen: the officer is mid-task and should land back
   where they were. */
function Sheet({ title, subtitle, children, onCancel, onSave, saveLabel, disabled }) {
  return (
    <View style={s.sheetWrap}>
      <Pressable style={s.sheetScrim} onPress={onCancel} />
      <View style={s.sheet}>
        <Text style={s.sheetTitle}>{title}</Text>
        {subtitle ? <Text style={s.sheetSub}>{subtitle}</Text> : null}
        {children}
        <View style={s.rowBtns}>
          <Pressable style={s.btnGhost} onPress={onCancel}>
            <Text style={s.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable style={[s.btnSolid, disabled && { opacity: 0.5 }]}
                     onPress={onSave} disabled={disabled}>
            <Text style={s.btnSolidText}>{saveLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/* What an officer records at the end of a visit.

   Kept short on purpose. A long form on a doorstep gets filled in from memory
   in the car, and a record written from memory is worth less than one written
   where it happened. Everything here is one tap except the two text fields. */
const OBSERVATIONS = [
  { key: "subject_present", label: "Subject present",
    options: [["yes", "Present"], ["no_contact", "No contact"]] },
  { key: "location_safe", label: "Location",
    options: [["yes", "Safe"], ["concerns", "Concerns"], ["not_assessed", "Not assessed"]] },
  { key: "contraband", label: "Contraband",
    options: [["none_seen", "None seen"], ["observed", "Observed"],
              ["not_assessed", "Not assessed"]] },
  { key: "demeanour", label: "Demeanour",
    options: [["cooperative", "Cooperative"], ["guarded", "Guarded"],
              ["agitated", "Agitated"], ["distressed", "Distressed"],
              ["impaired", "Appeared impaired"]] }
];

/* ================================================================
   A visit in progress.

   The notes start when the officer arrives, not when they leave. Writing it
   up afterwards means writing it from memory in the car, and this record may
   end up supporting a revocation — so notes and photographs are captured
   where the thing happened, as it happens.

   Everything here is append-only. There is no edit and no delete, by design.
================================================================ */
const AG_SOURCE = { financial: "Money", date: "Appointment", goal: "Goal",
                    program: "Training", custom: "Added" };

/**
 * Speech, not music.
 *
 * The stock LOW_QUALITY preset records AMR in a .3gp container on Android and
 * AAC in .m4a on iOS — two different formats from one setting, which is how a
 * player that works on one phone fails on the other. These options pin both
 * platforms to AAC in .m4a.
 *
 * Mono at 32 kbps is around 14 MB an hour: legible speech, and small enough to
 * finish uploading from a doorstep on a bad connection, which is the network
 * this actually runs on.
 */
const SPEECH_RECORDING = {
  /* Metering costs nothing and is the only way to tell a recording of a quiet
     room from a recording of nothing at all. Both produce a valid file of the
     right length; only one of them has a signal in it. */
  isMeteringEnabled: true,
  extension: ".m4a",
  sampleRate: 22050,
  numberOfChannels: 1,
  bitRate: 32000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.LOW,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false
  },
  web: { mimeType: "audio/mp4", bitsPerSecond: 32000 }
};

/* Below this, in dBFS, nothing reached the microphone. A quiet room still
   floats around -45; digital silence pins to -160. */
const SILENT_DBFS = -55;

/** mm:ss, because a recording is minutes long and "2m 5s" reads worse ticking. */
const clock = ms => {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

function VisitInProgress({ auth, visit, onAddNote, onAddPhoto, onAddRecording,
                          onEnd, onClose, onRefresh, onCoverAgenda, busy }) {
  const pull = usePullToRefresh(onRefresh);
  const [note, setNote] = useState("");
  const notes = visit.notes_log || [];
  const photos = visit.photos || [];
  const recordings = visit.recordings || [];

  /* ---- audio ----
     Announced, not discreet. Whether a conversation may be recorded without
     telling the other person is a question of where you are standing — Utah
     is one-party consent, its neighbours are not — and that is not a judgment
     to bury in a preference. So the button says what it does, the card turns
     red while it is running, and the hint says out loud that everyone present
     should know. */
  const recorder = useAudioRecorder(SPEECH_RECORDING);
  const recState = useAudioRecorderState(recorder, 250);
  const [savingAudio, setSavingAudio] = useState(false);
  const recording = recState.isRecording;

  /* The loudest thing heard while it ran. A microphone that is muted, blocked,
     or — the case that produced this — simulated, still yields a file of the
     right length full of silence. Without this the officer finds out weeks
     later, playing back the visit that mattered. */
  const peak = useRef(-160);
  useEffect(() => {
    if (recState.isRecording && typeof recState.metering === "number")
      peak.current = Math.max(peak.current, recState.metering);
  }, [recState.isRecording, recState.metering]);

  const startRecording = async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Microphone access is off",
        "Waypoint needs the microphone to record this visit. You can turn it on "
        + "in Settings.");
      return;
    }
    try {
      // iOS routes recording through the audio session, and will not record at
      // all unless the app has asked for it first.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      peak.current = -160;
      recorder.record();
    } catch (e) {
      Alert.alert("Couldn't start recording", String(e?.message || e));
    }
  };

  /** Stops and uploads. Resolves once the audio is either saved or reported. */
  const stopRecording = async () => {
    if (!recorder.isRecording) return;
    /* Read the length BEFORE stopping: the polled state drops to zero the
       moment it stops, and a recording filed as zero seconds long is a
       recording nobody trusts. */
    const duration_ms = Math.round((recorder.currentTime || 0) * 1000);
    setSavingAudio(true);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) {
        Alert.alert("Nothing was recorded",
          "The microphone produced no audio. Try again.");
        return;
      }
      await onAddRecording({
        data: await new File(uri).base64(),
        mime_type: "audio/m4a",
        duration_ms
      });

      /* Saved either way — it is evidence and this app does not throw evidence
         away — but the officer is told now rather than on playback. */
      if (peak.current < SILENT_DBFS)
        Alert.alert("That recording has no sound in it",
          "It has been saved, but nothing reached the microphone for the whole "
          + (duration_ms ? `${clock(duration_ms)}` : "recording")
          + ". Check that the microphone is not muted or covered, and that "
          + "Waypoint has microphone access. On the iOS Simulator this is "
          + "normal — the Simulator does not capture audio.");
    } catch (e) {
      Alert.alert("Couldn't save that recording", String(e?.message || e));
    } finally { setSavingAudio(false); }
  };

  /* Leaving the screen with the microphone still running would throw the audio
     away, so it is stopped and saved first rather than the button refusing to
     work. An exit that always works, and never at the cost of the recording. */
  const stopThen = fn => async () => { await stopRecording(); fn(); };

  /* One player for the whole list: two recordings playing at once is never
     what anybody meant. */
  const player = useAudioPlayer(null);
  const playStatus = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState(null);

  const togglePlay = async rec => {
    try {
      /* Silent-switch on means a phone plays nothing at all, and the officer
         concludes the recording is empty. Asked for every time rather than once
         at mount, because stopping a recording puts the session back. */
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });

      if (playingId === rec.id) {
        if (playStatus.playing) { player.pause(); return; }
        /* A finished player sits at the end, and play() on it does nothing —
           so the second press of a recording you have already heard through
           looks exactly like a dead button. Rewind first. */
        const atEnd = playStatus.didJustFinish
          || (playStatus.duration > 0 && playStatus.currentTime >= playStatus.duration - 0.25);
        if (atEnd) await player.seekTo(0);
        player.play();
        return;
      }
      player.replace({ uri: `${SAAS_BASE}/visit-recordings/${rec.id}`,
                       headers: { Authorization: `Bearer ${auth.token}` } });
      setPlayingId(rec.id);
      player.play();
    } catch (e) {
      /* Playback that fails without saying so is indistinguishable from a
         recording with nothing in it, and the officer cannot tell which. */
      setPlayingId(null);
      Alert.alert("Couldn't play that recording", String(e?.message || e));
    }
  };

  const shoot = async (fromLibrary) => {
    const perm = fromLibrary
      ? await ImagePicker.requestMediaLibraryPermissionsAsync()
      : await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(fromLibrary ? "Photo access is off" : "Camera access is off",
        "Waypoint needs it to attach a photograph to this visit. You can turn it "
        + "on in Settings.");
      return;
    }
    const pick = fromLibrary ? ImagePicker.launchImageLibraryAsync
                             : ImagePicker.launchCameraAsync;
    const r = await pick({
      mediaTypes: ["images"],
      // Compressed on the device: a doorstep connection has to finish the
      // upload, and a legible photograph does not need a full sensor frame.
      quality: 0.55,
      base64: true
    });
    if (r.canceled || !r.assets?.length) return;
    const a = r.assets[0];
    onAddPhoto({ data: a.base64, mime_type: a.mimeType || "image/jpeg" });
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.agHeader}>
        <View style={{ flex: 1 }}>
          <Text style={s.agHeaderTitle} numberOfLines={1}>{visit.subject_name}</Text>
          <Text style={s.cardMeta}>In progress · started {timeLabel(visit.started_at)}</Text>
          {addressOf(visit) ? (
            <Pressable onPress={() => openMaps(addressOf(visit))}>
              <Text style={[s.cardAddr, { color: C.brand }]}>{addressLine(visit)}</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={stopThen(onClose)} hitSlop={12}>
          <Text style={s.agClose}>Close</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.listBody} refreshControl={pull}
                  keyboardShouldPersistTaps="handled">

        {/* The recorder sits first, because it is the one thing that has to be
            started at the beginning rather than remembered at the end. */}
        <View style={[s.card, recording && s.recCardOn]}>
          <View style={s.cardTop}>
            <Text style={s.cardTitle}>Audio</Text>
            {recording ? (
              <View style={s.recLive}>
                <View style={s.recDot} />
                <Text style={s.recClock}>{clock(recState.durationMillis)}</Text>
              </View>
            ) : recordings.length ? (
              <View style={[s.pill, s.pillMuted]}>
                <Text style={[s.pillText, { color: C.muted }]}>{recordings.length}</Text>
              </View>
            ) : null}
          </View>

          <Pressable
            style={({ pressed }) => [s.recBtn, recording ? s.recBtnStop : s.recBtnStart,
                                     (pressed || savingAudio) && { opacity: .7 }]}
            disabled={savingAudio}
            onPress={() => (recording ? stopRecording() : startRecording())}>
            <Text style={s.recBtnText}>
              {savingAudio ? "Saving the recording…"
               : recording ? "Stop recording"
               : "Record this visit"}
            </Text>
          </Pressable>

          <Text style={s.sheetHint}>
            {recording
              ? "Recording audio. Everyone present should know this conversation "
                + "is being recorded."
              : "Audio only. A recording is saved to this visit and, like a note "
                + "or a photograph, cannot be edited or deleted afterwards."}
          </Text>

          {recordings.map((r, i) => {
            const live = playingId === r.id;
            const loading = live && !playStatus.isLoaded;
            return (
              <Pressable key={r.id} disabled={recording}
                         style={({ pressed }) => [s.detailRow,
                                                  pressed && { opacity: .5 }]}
                         onPress={() => togglePlay(r)}>
                <View style={[s.recPlay, recording && { opacity: .4 },
                              live && s.recPlayOn]}>
                  {loading
                    ? <ActivityIndicator size="small" color={C.brand} />
                    : <Text style={[s.recPlayIcon, live && s.recPlayIconOn]}>
                        {live && playStatus.playing ? "❚❚" : "▶"}
                      </Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.detailTitle}>
                    Recording {i + 1}
                    {r.duration_ms ? ` · ${clock(r.duration_ms)}` : ""}
                  </Text>
                  <Text style={s.cardMeta}>
                    {live && playStatus.playing
                      ? `Playing · ${clock(playStatus.currentTime * 1000)}`
                      : `${r.author || "—"} · ${fmtVisit(r.created_at)}`}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* What this visit is for, first — an officer standing at a door has
            about ten seconds to remember why they came. */}
        {(visit.agenda || []).length ? (
          <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>Agenda</Text>
              <View style={[s.pill, s.pillMuted]}>
                <Text style={[s.pillText, { color: C.muted }]}>
                  {(visit.agenda || []).filter(a => a.covered_at).length} of{" "}
                  {(visit.agenda || []).length} discussed</Text>
              </View>
            </View>
            {(visit.agenda || []).map(a => (
              <Pressable key={a.id} style={s.agRow}
                         disabled={busy}
                         onPress={() => onCoverAgenda(a, !a.covered_at)}>
                <View style={[s.goalTick, a.covered_at && s.goalTickOn]}>
                  {a.covered_at ? <Text style={s.goalTickMark}>✓</Text> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.agBody, a.covered_at && s.agBodyDone]}>{a.body}</Text>
                  {a.detail ? <Text style={s.cardMeta}>{a.detail}</Text> : null}
                  {a.note ? <Text style={s.agNote}>{a.note}</Text> : null}
                </View>
                <Text style={s.agSrc}>{AG_SOURCE[a.source_kind] || ""}</Text>
              </Pressable>
            ))}
            <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
              Tap an item once you have covered it. Anything you want on the
              record goes in a note below.
            </Text>
          </View>
        ) : null}

        <View style={s.card}>
          <Text style={s.label}>Add a note</Text>
          <TextInput style={[s.input, s.textarea]} value={note} onChangeText={setNote}
                     multiline placeholder="What you are seeing, hearing, being told"
                     placeholderTextColor={C.faint} textAlignVertical="top" />
          <View style={s.rowBtns}>
            <Pressable style={({ pressed }) => [s.btnGhost, pressed && { opacity: .6 }]}
                       onPress={() => shoot(false)} disabled={busy}>
              <Text style={s.btnGhostText}>Take photo</Text>
            </Pressable>
            <Pressable style={[s.btnSolid, (!note.trim() || busy) && { opacity: .5 }]}
                       disabled={!note.trim() || busy}
                       onPress={() => { onAddNote(note.trim()); setNote(""); }}>
              <Text style={s.btnSolidText}>{busy ? "Saving…" : "Add note"}</Text>
            </Pressable>
          </View>
          <Text style={s.sheetHint}>
            Notes and photographs are saved as you add them, and cannot be edited
            afterwards — a correction is a new note.
          </Text>
        </View>

        {photos.length > 0 && (
          <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>Photographs</Text>
              <View style={[s.pill, s.pillMuted]}>
                <Text style={[s.pillText, { color: C.muted }]}>{photos.length}</Text>
              </View>
            </View>
            <View style={s.photoGrid}>
              {photos.map(p => (
                <Image key={p.id} style={s.photoThumb}
                       source={{ uri: `${SAAS_BASE}/visit-photos/${p.id}`,
                                 headers: { Authorization: `Bearer ${auth.token}` } }} />
              ))}
            </View>
          </View>
        )}

        <View style={s.card}>
          <View style={s.cardTop}>
            <Text style={s.cardTitle}>Notes</Text>
            <View style={[s.pill, s.pillMuted]}>
              <Text style={[s.pillText, { color: C.muted }]}>{notes.length}</Text>
            </View>
          </View>
          {notes.length ? [...notes].reverse().map(n => (
            <View key={n.id} style={s.detailRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.detailTitle}>{n.body}</Text>
                <Text style={s.cardMeta}>{n.author || "—"} · {fmtVisit(n.created_at)}</Text>
              </View>
            </View>
          )) : <Text style={s.cardMeta}>Nothing recorded yet.</Text>}
        </View>

        <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark },
                                           savingAudio && s.ctaOff]}
                   disabled={savingAudio}
                   onPress={stopThen(onEnd)}>
          <Text style={s.ctaText}>
            {recording ? "Stop recording and end visit"
             : savingAudio ? "Saving the recording…" : "End visit"}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function CompleteSheet({ visit, onCancel, onSave }) {
  const [obs, setObs] = useState({});
  const [others, setOthers] = useState("");
  const [concerns, setConcerns] = useState("");
  const [detail, setDetail] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setObs(p => ({ ...p, [k]: p[k] === v ? undefined : v }));
  const noContact = obs.subject_present === "no_contact";

  const submit = () => {
    setSaving(true);
    onSave(note.trim(), {
      ...obs,
      contraband_detail: obs.contraband === "observed" ? detail.trim() : null,
      others_present: others.trim() || null,
      concerns: concerns.trim() || null
    });
  };

  return (
    <Sheet title="End visit"
           subtitle={`${visit.subject_name} · started ${timeLabel(visit.started_at)}`}
           onCancel={onCancel} saveLabel={saving ? "Saving…" : "Record visit"}
           disabled={saving} onSave={submit}>
      <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">

        {OBSERVATIONS.map(f => {
          /* If nobody answered the door, the rest is not assessable. */
          if (noContact && f.key !== "subject_present") return null;
          return (
            <View key={f.key}>
              <Text style={s.label}>{f.label}</Text>
              <Choice options={f.options} value={obs[f.key]}
                      onChange={v => set(f.key, v)} />
            </View>
          );
        })}

        {obs.contraband === "observed" && (
          <>
            <Text style={s.label}>What was seen</Text>
            <TextInput style={s.input} value={detail} onChangeText={setDetail}
                       placeholder="Describe what was observed"
                       placeholderTextColor={C.faint} />
          </>
        )}

        {!noContact && (
          <>
            <Text style={s.label}>Others present</Text>
            <TextInput style={s.input} value={others} onChangeText={setOthers}
                       placeholder="Anyone else at the location"
                       placeholderTextColor={C.faint} />
          </>
        )}

        <Text style={s.label}>Concerns</Text>
        <TextInput style={s.input} value={concerns} onChangeText={setConcerns}
                   placeholder="Anything the answers above do not cover"
                   placeholderTextColor={C.faint} />

        <Text style={s.label}>Visit notes</Text>
        <TextInput style={[s.input, s.textarea]} value={note} onChangeText={setNote}
                   multiline placeholder="What happened during the visit?"
                   placeholderTextColor={C.faint} textAlignVertical="top" />

        <Text style={s.sheetHint}>
          The end time is recorded now. Notes are added to this visit's record and
          cannot be edited afterwards — a correction is a new note.
        </Text>
      </ScrollView>
    </Sheet>
  );
}

/**
 * @param askedFor  what the subject said when they asked for this, when the
 *                  visit is being scheduled in answer to a request. Shown
 *                  rather than pre-filled into the note: their reason for
 *                  wanting to be seen is not the officer's instruction to them,
 *                  and quietly turning one into the other would put words in
 *                  somebody's mouth on a supervision record.
 */
function ScheduleSheet({ subject, askedFor, onCancel, onSave }) {
  const initial = new Date(Date.now() + 7 * 864e5);
  initial.setHours(10, 0, 0, 0);
  const [when, setWhen] = useState(initial);
  const [note, setNote] = useState("");
  const [show, setShow] = useState(Platform.OS === "ios" ? "datetime" : null);
  const [saving, setSaving] = useState(false);

  return (
    <Sheet title={askedFor !== undefined ? "Schedule a requested visit" : "Schedule a visit"}
           subtitle={[subject.name, addressLine(subject)].filter(Boolean).join(" · ")}
           onCancel={onCancel} saveLabel={saving ? "Saving…" : "Schedule"}
           disabled={saving}
           onSave={() => { setSaving(true); onSave(when, note.trim()); }}>
      {askedFor !== undefined && (
        <View style={s.askedFor}>
          <Text style={s.askedForLabel}>They asked to be seen</Text>
          <Text style={s.askedForBody}>{askedFor || "No reason given"}</Text>
        </View>
      )}

      <Text style={s.label}>Date and time</Text>

      {Platform.OS === "ios" ? (
        <DateTimePicker value={when} mode="datetime" display="compact" minimumDate={new Date()}
                        onChange={(_, d) => d && setWhen(d)} style={{ alignSelf: "flex-start" }} />
      ) : (
        <>
          <Pressable style={s.input} onPress={() => setShow("date")}>
            <Text style={{ fontSize: 16, color: C.ink }}>{fmtVisit(when)}</Text>
          </Pressable>
          {show === "date" && (
            <DateTimePicker value={when} mode="date" minimumDate={new Date()}
              onChange={(e, d) => { setShow(null);
                if (e.type === "set" && d) { const n = new Date(when);
                  n.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                  setWhen(n); setShow("time"); } }} />
          )}
          {show === "time" && (
            <DateTimePicker value={when} mode="time"
              onChange={(e, d) => { setShow(null);
                if (e.type === "set" && d) { const n = new Date(when);
                  n.setHours(d.getHours(), d.getMinutes()); setWhen(n); } }} />
          )}
        </>
      )}

      <Text style={s.label}>Instructions for the subject (optional)</Text>
      <TextInput style={s.input} value={note} onChangeText={setNote}
                 placeholder="e.g. bring proof of employment"
                 placeholderTextColor={C.faint} />
      <Text style={s.sheetHint}>
        They will be asked to confirm, exactly as with a visit booked from the console.
      </Text>
    </Sheet>
  );
}

function OfficerSchedule({ auth, data, busy, onRefresh, onStart, onComplete, onSchedule,
                           onScheduleRequest }) {
  const pull = usePullToRefresh(onRefresh);

  /* Today's stops, in appointment order. The order is not ours to optimise —
     these are times somebody has been told, and arriving at 9 for a 2 o'clock
     is not efficient, it is wrong. */
  const today = new Date().toDateString();
  const todayStops = (data?.upcoming || [])
    .filter(v => v.scheduled_at && new Date(v.scheduled_at).toDateString() === today)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const routable = todayStops.filter(v => addressOf(v));

  /* Ask the server for the shortest way round, then hand that order to the
     map. The list above stays in appointment order — that is the schedule;
     this is the other question. */
  const [planning, setPlanning] = useState(false);
  const [startFrom, setStartFrom] = useState("device");   // device | office | typed
  const [typedStart, setTypedStart] = useState("");

  /**
   * Where the day starts. Asked for only when the officer plans a route —
   * nothing is watched in the background and no position is ever stored.
   *
   * Declining is not a failure: the server falls back to the officer's office,
   * so a refused permission costs a slightly different origin, not the route.
   */
  const currentPoint = async () => {
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return null;
      const pos = await Location.getCurrentPositionAsync(
        { accuracy: Location.Accuracy.Balanced });
      return { start_lat: pos.coords.latitude, start_lon: pos.coords.longitude };
    } catch { return null; }
  };

  const chooseStart = () => Alert.alert(
    "Where are you starting from?", "The stops are ordered from there.",
    [{ text: "Cancel", style: "cancel" },
     { text: "My location", onPress: () => { setStartFrom("device"); planRoute("device"); } },
     { text: data?.base?.name || "My office",
       onPress: () => { setStartFrom("office"); planRoute("office"); } },
     { text: "Somewhere else", onPress: () => setStartFrom("typed") }]);

  const planRoute = async (from = startFrom) => {
    if (routable.length === 1) return openMaps(addressOf(routable[0]));
    setPlanning(true);
    try {
      /* Three ways in, and the server treats them in the same order of trust:
         coordinates it need not geocode, an address it must, then the office. */
      let origin = {};
      if (from === "device") {
        origin = await currentPoint() || {};
        if (!origin.start_lat)
          toast("Location unavailable — starting from your office", "err");
      } else if (from === "typed" && typedStart.trim()) {
        origin = { start: typedStart.trim() };
      }

      const r = await authed(`${SAAS_BASE}/api/officer/route`, auth.token, {
        method: "POST",
        body: JSON.stringify({ ...origin,
                               visit_ids: routable.map(v => v.id) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't work out the route");

      /* Confirm the moment we know it worked, before doing anything with the
         answer. A save whose confirmation waits on later processing is a save
         that goes quiet if that processing throws. */
      toast(d.mode === "scheduled"
        ? "Every visit has a set time — opening in schedule order"
        : d.saved > 0.1
          ? `${d.miles} mi from ${d.start_label} — ${d.saved} shorter`
          : `${d.miles} mi from ${d.start_label}`);

      const byId = Object.fromEntries(routable.map(v => [v.id, v]));
      const ordered = (d.ordered || []).map(id => byId[id]).filter(Boolean);
      if (!ordered.length) throw new Error(d.note || "No addresses could be placed");
      /* A device fix is left off the map link so Maps starts from where the
         officer actually is; an address is passed through. */
      openRoute(ordered.map(addressOf),
                d.start_from === "device" ? null : d.start_label);
    } catch (e) {
      /* A geocoder being down is not a reason an officer cannot drive their
         day. Fall back to the schedule order and say so. */
      toast(`${String(e.message || e)} — opening in appointment order`, "err");
      openRoute(routable.map(addressOf));
    } finally { setPlanning(false); }
  };
  const upcoming = data?.upcoming || [];
  const requests = data?.requests || [];

  /* Group by day so the list reads like a diary rather than a table.
     Everything scheduled is here, not just today — an officer plans a week,
     not an afternoon.

     Anything from a previous day that was never closed out is pulled to the
     top under its own heading. It used to sit in date order under an ordinary
     day label, which put a stale visit from last Tuesday ABOVE today's work
     and made it look like an appointment rather than something owed. */
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const stale = upcoming.filter(v => new Date(v.scheduled_at) < startOfToday);
  const ahead = upcoming.filter(v => new Date(v.scheduled_at) >= startOfToday);

  const days = [];
  if (stale.length) days.push({ label: "Not closed out", items: stale, stale: true });
  ahead.forEach(v => {
    const label = dayLabel(v.scheduled_at);
    const last = days[days.length - 1];
    if (last && last.label === label && !last.stale) last.items.push(v);
    else days.push({ label, items: [v] });
  });

  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={pull}>

      {routable.length > 1 && (
        <Pressable style={({ pressed }) => [s.routeBar, pressed && { opacity: .8 },
                          planning && { opacity: .6 }]}
                   disabled={planning} onPress={chooseStart}>
          <Text style={s.routeIcon}>◈</Text>
          <Text style={s.routeText}>
            {planning
              ? "Working out the shortest way round…"
              : `${todayStops.length} visits today — plan the route`}
          </Text>
          <Text style={s.routeGo}>Maps</Text>
        </Pressable>
      )}

      {startFrom === "typed" && routable.length > 1 && (
        <View style={s.card}>
          <Text style={s.label}>Starting from</Text>
          <TextInput style={s.input} value={typedStart} onChangeText={setTypedStart}
                     placeholder="An address to start from"
                     placeholderTextColor={C.faint} autoCapitalize="words" />
          <View style={s.rowBtns}>
            <Pressable style={s.btnGhost} onPress={() => setStartFrom("device")}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable style={[s.btnSolid, (!typedStart.trim() || planning) && { opacity: .5 }]}
                       disabled={!typedStart.trim() || planning}
                       onPress={() => planRoute("typed")}>
              <Text style={s.btnSolidText}>Plan from here</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Somebody on this caseload has asked to be seen.
        *
        * This used to list them and then say "Set a date from the web console"
        * — a notification on the device the officer is holding, pointing at a
        * laptop they are not sitting at. The console has answered these since
        * they existed; the app showed the badge and stopped.
        *
        * Each row schedules directly now, and carries the requested visit's OWN
        * id, so the request BECOMES that visit. Posting without it creates a
        * second visit beside a request that stays open forever — the officer
        * would answer it and the subject would still be waiting. */}
      {requests.length > 0 && (
        <View style={[s.card, { borderColor: "#fde68a", backgroundColor: "#fffbeb" }]}>
          <Text style={{ fontWeight: "700", color: "#b45309", fontSize: 15 }}>
            {requests.length} appointment {requests.length === 1 ? "request" : "requests"}
          </Text>
          {requests.map(r => (
            <Pressable key={r.id}
                       onPress={() => onScheduleRequest(r)}
                       style={({ pressed }) => [s.reqRow, pressed && { opacity: 0.6 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.reqName}>{r.subject_name}</Text>
                <Text style={s.reqNote}>{r.request_note || "No reason given"}</Text>
                {r.requested_at ? (
                  <Text style={s.reqWhen}>Asked {fmtVisit(r.requested_at)}</Text>
                ) : null}
              </View>
              <Text style={s.reqGo}>Schedule ›</Text>
            </Pressable>
          ))}
        </View>
      )}

      {!data && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}
      {data && upcoming.length === 0 && (
        <View style={s.center}><Text style={s.muted}>No visits scheduled.</Text></View>
      )}

      {days.map(day => (
        <View key={day.label}>
          <Text style={[s.dayHeading, day.stale && { color: C.err }]}>
            {day.label}
            {day.stale ? ` · ${day.items.length}` : ""}
          </Text>
          {day.items.map(v => {
            const address = addressOf(v);
            return (
              <View key={v.id} style={s.card}>
                <View style={s.cardTop}>
                  <Text style={s.visitTime}>
                    {v.time_fixed ? timeLabel(v.scheduled_at) : "Any time"}</Text>
                  {/* Acceptance is an ACKNOWLEDGMENT, not permission. The
                      officer goes either way; this tells them what to expect
                      when they knock, so "Not confirmed" is the honest label —
                      "Scheduled" read as though everything was in order. */}
                  <View style={[s.pill, v.accepted_at ? s.pillOk
                               : v.seen_at ? s.pillNeutral : s.pillWarn]}>
                    <Text style={[s.pillText, { color: v.accepted_at ? C.ok
                                  : v.seen_at ? C.brand : C.amber }]}>
                      {v.accepted_at ? "Confirmed" : v.seen_at ? "Seen, not confirmed"
                                     : "Not confirmed"}
                    </Text>
                  </View>
                </View>
                <Text style={s.cardTitle}>{v.subject_name}</Text>
                <Text style={s.cardMeta}>{v.case_number}{v.phone ? `  ·  ${v.phone}` : ""}</Text>
                {address ? <Text style={s.cardAddr}>{address}</Text> : null}
                {v.notes ? <Text style={s.noteLine}>{v.notes}</Text> : null}
                {(v.agenda || []).length ? (
                  <Text style={s.cardMeta}>
                    {(v.agenda || []).filter(a => !a.covered_at).length} on the agenda
                  </Text>
                ) : null}
                {v.started_at ? (
                  <Text style={[s.cardMeta, { color: C.brand, fontWeight: "700" }]}>
                    In progress — started {timeLabel(v.started_at)}
                    {(v.notes_log || []).length || (v.photos || []).length
                      ? ` · ${(v.notes_log || []).length} notes, ${(v.photos || []).length} photos`
                      : ""}
                  </Text>
                ) : null}

                <View style={s.rowBtns}>
                  {address ? (
                    <Pressable style={({ pressed }) => [s.btnGhost, pressed && { backgroundColor: C.line }]}
                               onPress={() => openMaps(address)}>
                      <Text style={s.btnGhostText}>Directions</Text>
                    </Pressable>
                  ) : null}
                  {v.phone ? (
                    <Pressable style={({ pressed }) => [s.btnGhost, pressed && { backgroundColor: C.line }]}
                               onPress={() => Linking.openURL(`tel:${v.phone.replace(/[^0-9+]/g, "")}`)}>
                      <Text style={s.btnGhostText}>Call</Text>
                    </Pressable>
                  ) : null}
                  <Pressable style={({ pressed }) => [s.btnGhost, pressed && { backgroundColor: C.line }]}
                             onPress={() => onSchedule(v)}>
                    <Text style={s.btnGhostText}>Schedule next</Text>
                  </Pressable>
                  <Pressable style={({ pressed }) => [s.btnSolid, pressed && { backgroundColor: C.brandDark }]}
                             onPress={() => onStart(v)}>
                    <Text style={s.btnSolidText}>
                      {v.started_at ? "Continue visit" : "Start visit"}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ))}

      {(data?.recent || []).length > 0 && (
        <>
          <Text style={s.dayHeading}>Recently completed</Text>
          {data.recent.map(v => (
            <View key={v.id} style={[s.card, { opacity: 0.85 }]}>
              <Text style={s.cardTitle}>{v.subject_name}</Text>
              <Text style={s.cardMeta}>
                {fmtVisit(v.completed_at)}{v.completed_by ? ` · ${v.completed_by}` : ""}
              </Text>
              {(v.notes_log || []).map(n => (
                <Text key={n.id} style={s.noteLine}>{n.body}</Text>
              ))}
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function OfficerCaseload({ subjects, busy, onRefresh, onOpen, onSchedule }) {
  const pull = usePullToRefresh(onRefresh);
  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={pull}>
      {!subjects && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}
      {subjects?.length === 0 && (
        <View style={s.center}><Text style={s.muted}>No subjects assigned to you.</Text></View>
      )}
      {(subjects || []).map(sub => (
        <Pressable key={sub.subject_id}
                   style={({ pressed }) => [s.card, pressed && s.cardPressed]}
                   onPress={() => onOpen(sub)}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}>
            <Avatar name={sub.name} size={44} hasLogin={sub.has_login} />
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{sub.name}</Text>
              <Text style={s.cardMeta}>{sub.case_number} · {sub.status}</Text>
              <Text style={s.cardMeta}>
                {sub.upcoming_visits} upcoming
                {sub.pending_requests > 0 ? ` · ${sub.pending_requests} request` : ""}
              </Text>
            </View>
          </View>
          <View style={s.rowBtns}>
            {sub.phone ? (
              <Pressable style={s.btnGhost}
                         onPress={() => Linking.openURL(`tel:${sub.phone.replace(/[^0-9+]/g, "")}`)}>
                <Text style={s.btnGhostText}>Call</Text>
              </Pressable>
            ) : null}
            {sub.address_line1 ? (
              <Pressable style={s.btnGhost}
                         onPress={() => openMaps(addressOf(sub))}>
                <Text style={s.btnGhostText}>Directions</Text>
              </Pressable>
            ) : null}
            <Pressable style={s.btnSolid} onPress={() => onSchedule(sub)}>
              <Text style={s.btnSolidText}>Schedule visit</Text>
            </Pressable>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/* ================================================================
   A subject's file, as the officer sees it. The same four modules as
   the web console, and the same endpoints behind them.
================================================================ */
const TRAVEL_OPTS  = [["none","None"],["local","Local only"],
                      ["interstate","Interstate"],["international","International"]];
const CS_OPTS      = [["todo","To do"],["in_progress","In progress"],["complete","Complete"]];
const hhmmToDate = t => { const d = new Date();
  const [h, m] = String(t || "21:00").split(":").map(Number);
  d.setHours(h || 0, m || 0, 0, 0); return d; };
const dateToHhmm = d =>
  `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
const isoDay = d => d.toISOString().slice(0, 10);

/**
 * One module of a case file, collapsed to a line until it is asked for.
 *
 * The officer's subject screen used to render every module expanded, so
 * finding the curfew meant scrolling past three other things. A case file has
 * a dozen modules and an officer wants one of them; the summary line is what
 * tells them which.
 *
 * The chip carries state, so a collapsed card still says whether something
 * needs attention. Collapsing must never hide the fact that there is
 * something to look at.
 */
function Section({ title, chip, tone = "muted", summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const pill = { ok: s.pillOk, warn: s.pillWarn, brand: s.pillNeutral, muted: s.pillMuted }[tone];
  const ink  = { ok: C.ok, warn: C.amber, brand: C.brand, muted: C.muted }[tone];
  return (
    <View style={s.card}>
      <Pressable style={s.secHead} onPress={() => setOpen(v => !v)} hitSlop={6}>
        <Text style={s.cardTitle}>{title}</Text>
        {chip ? (
          <View style={[s.pill, pill]}><Text style={[s.pillText, { color: ink }]}>{chip}</Text></View>
        ) : null}
        <Text style={[s.secChevron, open && { transform: [{ rotate: "90deg" }] }]}>›</Text>
      </Pressable>
      {!open && summary ? <Text style={s.secSummary}>{summary}</Text> : null}
      {open ? <View style={s.secBody}>{children}</View> : null}
    </View>
  );
}

/** A label/value line inside an expanded section. */
function Detail({ label, value, onPress, action }) {
  if (!value && !action) return null;
  const body = (
    <View style={s.detailRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.detailLabel}>{label}</Text>
        <Text style={[s.detailValue, onPress && { color: C.brand }]}>{value || "—"}</Text>
      </View>
      {action ? <Text style={s.detailAction}>{action}</Text> : null}
    </View>
  );
  return onPress
    ? <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: .6 }}>{body}</Pressable>
    : body;
}

function OfficerSubject({ auth, subject, onBack }) {
  const [detail, setDetail] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await authed(
        `${SAAS_BASE}/api/subject/detail?subject_id=${encodeURIComponent(subject.subject_id)}`,
        auth.token);
      if (r.ok) setDetail(await r.json());
    } catch {} finally { setBusy(false); }
  }, [subject]);
  useEffect(() => { load(); }, [load]);
  const pull = usePullToRefresh(load);

  const post = async (path, body, okMsg) => {
    try {
      const r = await authed(`${SAAS_BASE}${path}`, auth.token, {
        method: "POST",
        body: JSON.stringify({ subject_id: subject.subject_id, ...body }) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast(d.error || "Couldn't save — please try again", "err");
        return false;
      }
      toast(okMsg || "Saved");
      setSheet(null); await load();
      return true;
    } catch {
      toast("No connection — nothing was saved", "err");
      return false;
    }
  };

  const cur  = detail?.curfew;
  const emp  = detail?.employment;
  const trav = detail?.travel_permit;
  const svc  = detail?.community_service || [];
  const cars = detail?.vehicles || [];
  const kin  = detail?.contacts || [];
  const notes = detail?.case_notes || [];
  const docs = detail?.documents || [];
  const visits = detail?.visits || [];
  const dates = detail?.important_dates?.dates || [];
  const openDates = dates.filter(d => d.status === "scheduled");
  const fin = detail?.financial;
  const goals = detail?.goals || [];
  const openGoals_ = goals.filter(g => g.status === "open");
  const actions = detail?.actions || [];
  const agr  = detail?.agreement;
  const rep  = detail?.reentry;
  /* The roster row is enough to open this screen; the full record arrives
     with the detail. Fall back so the header is never blank while it loads. */
  const who  = detail?.subject || subject;
  const svcDone = svc.filter(o => o.status === "complete").length;
  const nextVisit = visits
    .filter(v => v.status !== "completed" && v.status !== "cancelled" && v.scheduled_at)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
  const travExpired = isExpired(trav);
  const travAllowed = trav && trav.level !== "none" && !travExpired;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.profileBar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={[s.linkText, { fontSize: 15 }]}>‹ Back</Text>
        </Pressable>
        <Avatar name={subject.name} size={40} hasLogin={subject.has_login} />
        <View style={{ flex: 1 }}>
          <Text style={s.profileName} numberOfLines={1}>{subject.name}</Text>
          <Text style={s.profileMeta}>{subject.case_number} · {subject.status}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.listBody} refreshControl={pull}>
        {!detail && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

        {detail && (
          <>
            {/* Who and where, first — it is what an officer needs standing at
                a door, and it is the one thing that was not on this screen
                at all. Open by default for the same reason. */}
            <Section title="Contact & address" defaultOpen
                     summary={addressLine(who) || "No address on record"}>
              <Detail label="Address" value={addressOf(who) || "None on record"}
                      action="Directions"
                      onPress={() => openMaps(addressOf(who))} />
              <Detail label="Phone" value={who?.phone} action="Call"
                      onPress={() => who?.phone &&
                        Linking.openURL(`tel:${who.phone.replace(/[^0-9+]/g, "")}`)} />
              <Detail label="Email" value={who?.email} />
              <Detail label="Date of birth" value={dobLine(who?.dob)} />
              <Detail label="Supervising officer" value={who?.officer} />
              <Detail label="Next review" value={asDate(who?.next_review)} />
            </Section>

            <Section title="Family & contacts"
                     chip={kin.length ? `${kin.length}` : "None"}
                     tone={kin.length ? "brand" : "muted"}
                     summary={kin.length
                       ? kin.map(c => c.name).slice(0, 3).join(", ")
                         + (kin.length > 3 ? ` +${kin.length - 3}` : "")
                       : "None on record"}>
              <ContactsCard bare contacts={kin} theirName={subject.name.split(" ")[0]}
                onSave={(v, done) => post("/api/contacts", v,
                          v.id ? "Contact updated" : "Contact added")
                          .then(ok => { if (ok) done(); })}
                onRemove={c => post("/api/contacts/delete", { id: c.id }, "Contact removed")} />
            </Section>

            <Section title="Employment"
                     chip={EMPLOY_LABEL[emp?.status || "not_employed"]}
                     tone={emp?.status === "employed" || emp?.status === "self_employed"
                           ? "ok" : "muted"}
                     summary={employmentSummary(emp)}>
              <Detail label="Employer" value={emp?.company_name} />
              <Detail label="Supervisor" value={emp?.supervisor} />
              <Detail label="Address" value={emp?.address} />
              <Detail label="Phone" value={emp?.phone} action={emp?.phone ? "Call" : null}
                      onPress={() => emp?.phone &&
                        Linking.openURL(`tel:${emp.phone.replace(/[^0-9+]/g, "")}`)} />
              <Detail label="Notes" value={emp?.notes} />
              {emp?.updated_by === "subject" ? (
                <Text style={s.cardMeta}>Last reported by {subject.name.split(" ")[0]}.</Text>
              ) : null}
              <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                         onPress={() => setSheet({ mode: "employment" })}>
                <Text style={s.ctaText}>Edit employment</Text>
              </Pressable>
            </Section>

            <Section title="Vehicles" chip={cars.length ? `${cars.length}` : "None"}
                     tone={cars.length ? "brand" : "muted"}
                     summary={cars.length
                       ? cars.map(v => [v.year, v.make, v.model].filter(Boolean).join(" ")).join(", ")
                       : "None on record"}>
              {cars.length ? cars.map(v => (
                <Detail key={v.id}
                        label={[v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}
                        value={[v.color, v.plate ? `Plate ${v.plate}` : "",
                                v.state, v.notes].filter(Boolean).join(" · ") || "No details"} />
              )) : <Text style={s.cardMeta}>None on record.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Subjects maintain their own vehicle details.
              </Text>
            </Section>

            <Section title="Curfew" chip={cur?.active ? "In effect" : "None"}
                     tone={cur?.active ? "brand" : "muted"}
                     summary={cur?.active
                       ? `${to12h(cur.start_time)} to ${to12h(cur.end_time)}`
                       : "No curfew set"}>
              <Detail label="Hours" value={cur?.active
                ? `${to12h(cur.start_time)} to ${to12h(cur.end_time)}` : "No curfew set"} />
              <Detail label="Notes" value={cur?.notes} />
              <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                         onPress={() => setSheet({ mode: "curfew" })}>
                <Text style={s.ctaText}>Edit curfew</Text>
              </Pressable>
            </Section>

            <Section title="Travel permit"
                     chip={travExpired ? "Expired" : travAllowed ? TRAVEL_LABEL[trav.level] : "None"}
                     tone={travExpired ? "warn" : travAllowed ? "ok" : "muted"}
                     summary={travAllowed
                       ? `${TRAVEL_LABEL[trav.level]}${trav.expires_on ? ` until ${asDate(trav.expires_on)}` : ", no expiry"}`
                       : travExpired ? `Expired ${asDate(trav.expires_on)}` : "No travel permitted"}>
              <Detail label="Level" value={trav ? TRAVEL_LABEL[trav.level] : "None permitted"} />
              <Detail label="Expires" value={trav?.expires_on ? asDate(trav.expires_on) : "No expiry"} />
              <Detail label="Notes" value={trav?.notes} />
              <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                         onPress={() => setSheet({ mode: "travel" })}>
                <Text style={s.ctaText}>Edit travel permit</Text>
              </Pressable>
            </Section>

            <Section title="Community service"
                     chip={svc.length ? `${svcDone}/${svc.length}` : "None"}
                     tone={svc.length && svcDone === svc.length ? "ok"
                           : svc.length ? "brand" : "muted"}
                     summary={svc.length
                       ? `${svcDone} of ${svc.length} complete`
                       : "Nothing assigned"}>
              {svc.length ? svc.map(o => (
                <Pressable key={o.id} style={s.detailRow}
                           onPress={() => setSheet({ mode: "service", item: o })}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>{o.title}</Text>
                    <Text style={s.cardMeta}>
                      {o.required_quantity ? `${o.required_quantity} hours` : "Hours not set"}</Text>
                  </View>
                  <View style={[s.pill, o.status === "complete" ? s.pillOk
                               : o.status === "in_progress" ? s.pillNeutral : s.pillMuted]}>
                    <Text style={[s.pillText, { color: o.status === "complete" ? C.ok
                                  : o.status === "in_progress" ? C.brand : C.muted }]}>
                      {CS_LABEL[o.status]}</Text>
                  </View>
                </Pressable>
              )) : <Text style={s.cardMeta}>Nothing assigned.</Text>}
              <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                         onPress={() => setSheet({ mode: "service", item: {} })}>
                <Text style={s.ctaText}>Add a requirement</Text>
              </Pressable>
            </Section>

            {/* Documents an officer signs live on their own screens. What a
                case file owes here is where they stand, not their text. */}
            <Section title="Supervision agreement"
                     chip={!agr ? "None" : agr.subject_signed_at ? "Acknowledged"
                           : agr.status === "active" ? "Awaiting subject" : "Draft"}
                     tone={!agr ? "muted" : agr.subject_signed_at ? "ok"
                           : agr.status === "active" ? "warn" : "muted"}
                     summary={!agr ? "No agreement on file"
                       : `${agr.condition_count} conditions · `
                         + (agr.subject_signed_at
                            ? `acknowledged ${asDate(agr.subject_signed_at)}`
                            : "not yet acknowledged")}>
              <Detail label="Type" value={agr ? `${agr.kind} · ${agr.supervision_level || "standard"}` : null} />
              <Detail label="Term" value={agr?.start_date
                ? `${asDate(agr.start_date)} — ${agr.end_date ? asDate(agr.end_date) : "open"}` : null} />
              <Detail label="Conditions" value={agr ? `${agr.condition_count}` : null} />
              <Detail label="Officer signed" value={agr?.officer_signed_at
                ? asDateTime(agr.officer_signed_at) : "Not signed"} />
              <Detail label="Subject acknowledged" value={agr?.subject_signed_at
                ? asDateTime(agr.subject_signed_at) : "Not acknowledged"} />
              {agr?.amended_at ? (
                <Text style={s.cardMeta}>Amended {asDate(agr.amended_at)} — the earlier
                  acknowledgment no longer applies.</Text>
              ) : null}
              {!agr ? <Text style={s.cardMeta}>Create one from the console.</Text> : null}
            </Section>

            <Section title="Reentry plan"
                     chip={!rep ? "None" : rep.certified_at ? "Certified"
                           : `${rep.readiness.percent}%`}
                     tone={!rep ? "muted" : rep.certified_at ? "ok"
                           : rep.readiness.ready_for_reentry ? "ok" : "warn"}
                     summary={!rep ? "No plan on file"
                       : `${rep.readiness.complete} of ${rep.readiness.total} checkpoints · `
                         + `${rep.readiness.critical_complete}/${rep.readiness.critical_total} critical`}>
              <Detail label="Target release" value={asDate(rep?.target_release_date)} />
              <Detail label="Readiness" value={rep
                ? `${rep.readiness.percent}% — ${rep.readiness.complete} of ${rep.readiness.total} complete`
                : null} />
              <Detail label="Critical requirements" value={rep
                ? `${rep.readiness.critical_complete} of ${rep.readiness.critical_total} satisfied`
                : null} />
              <Detail label="Awaiting a signature" value={rep
                ? `${rep.readiness.awaiting_signature}` : null} />
              <Detail label="Accepted by subject" value={rep?.subject_signed_at
                ? asDateTime(rep.subject_signed_at) : "Not yet accepted"} />
              <Detail label="Certified" value={rep?.certified_at
                ? `${asDateTime(rep.certified_at)} by ${rep.certified_by || "the officer"}`
                : "Not certified"} />
              {!rep ? <Text style={s.cardMeta}>Create one from the console.</Text> : null}
            </Section>

            <Section title="Important dates"
                     chip={!dates.length ? "None"
                           : openDates.length ? `${openDates.length}` : "Closed"}
                     tone={openDates.some(d => d.state === "assigned"
                                            || d.state === "viewed"
                                            || d.awaiting_outcome) ? "warn"
                           : openDates.length ? "brand" : "muted"}
                     summary={!dates.length ? "None scheduled"
                       : openDates.length
                         ? `Next ${fmtVisit(openDates[0].scheduled_at)}`
                           + (openDates.filter(d => d.state === "assigned").length
                              ? " · not yet seen"
                              : openDates.filter(d => d.state === "viewed").length
                                ? " · viewed, not accepted" : "")
                         : `${dates.length} past`}>
              {dates.length ? dates.map(d => (
                <View key={d.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.dateWhen}>{fmtVisit(d.scheduled_at)}</Text>
                    <Text style={s.detailTitle}>{d.title || d.kind_label}</Text>
                    {d.location ? <Text style={s.cardMeta}>{d.location}</Text> : null}
                    {d.address ? (
                      <Pressable onPress={() => openMaps(d.address)}>
                        <Text style={[s.cardAddr, { color: C.brand }]}>{d.address}</Text>
                      </Pressable>
                    ) : null}
                    {d.outcome_note ? <Text style={s.noteLine}>{d.outcome_note}</Text> : null}
                  </View>
                  <View style={[s.pill, datePill(d.state, d.awaiting_outcome)]}>
                    <Text style={[s.pillText, { color: dateInk(d.state, d.awaiting_outcome) }]}>
                      {DATE_STATE[d.state] || ""}
                      {d.awaiting_outcome ? " · due" : ""}</Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>None scheduled.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Appointments are scheduled from the console.
              </Text>
            </Section>

            <Section title="Financial balance"
                     chip={!fin?.items.length ? "None"
                           : fin.totals.balance_cents ? money(fin.totals.balance_cents)
                           : "Settled"}
                     tone={!fin?.items.length ? "muted"
                           : fin.totals.overdue_cents ? "warn"
                           : fin.totals.balance_cents ? "brand" : "ok"}
                     summary={!fin?.items.length ? "Nothing owed"
                       : `${money(fin.totals.balance_cents)} due of `
                         + `${money(fin.totals.owed_cents)}`
                         + (fin.totals.overdue_cents
                            ? ` · ${money(fin.totals.overdue_cents)} overdue` : "")}>
              <Detail label="Total due" value={money(fin?.totals.balance_cents)} />
              <Detail label="Paid" value={money(fin?.totals.paid_cents)} />
              {fin?.totals.waived_cents
                ? <Detail label="Waived" value={money(fin.totals.waived_cents)} /> : null}
              <Detail label="Overdue" value={money(fin?.totals.overdue_cents)} />
              <Detail label="Next due" value={fin?.totals.next_due
                ? asDate(fin.totals.next_due) : "—"} />
              {(fin?.items || []).map(i => (
                <View key={i.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>
                      {FIN_KIND[i.kind] || i.kind} — {money(i.amount_cents)}</Text>
                    <Text style={s.cardMeta}>
                      {i.due_date ? `Due ${asDate(i.due_date)}` : "No due date"}
                      {i.paid_cents ? ` · ${money(i.paid_cents)} paid` : ""}
                    </Text>
                  </View>
                  <View style={[s.pill, i.state === "paid" || i.state === "waived" ? s.pillOk
                               : i.state === "overdue" ? s.pillErr : s.pillNeutral]}>
                    <Text style={[s.pillText, { color:
                      i.state === "paid" || i.state === "waived" ? C.ok
                      : i.state === "overdue" ? C.err : C.brand }]}>
                      {FIN_STATE[i.state] || ""}</Text>
                  </View>
                </View>
              ))}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Obligations are raised and waived from the console.
              </Text>
            </Section>

            {/* What they agreed to at a visit, in their own words.

                Only what the officer accepted and only what is theirs — a
                proposal nobody has reviewed is not work, and the officer's own
                list is not theirs to watch. Ticking is REPORTING, not deciding:
                the record says who said so, the same way a goal step does. */}
            <Section title="What they agreed to"
                     chip={actions.length ? `${actions.length}` : "None"}
                     tone={actions.some(a => overdueAction(a)) ? "warn"
                           : actions.length ? "brand" : "muted"}
                     summary={!actions.length ? "Nothing outstanding"
                       : actions.map(a => a.body).slice(0, 2).join("; ")
                         + (actions.length > 2 ? ` +${actions.length - 2}` : "")}>
              {actions.length ? actions.map(a => (
                <View key={a.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>{a.body}</Text>
                    <Text style={[s.cardMeta, overdueAction(a) && { color: C.err }]}>
                      {a.due_date ? `Due ${asDate(a.due_date)}` : "No date set"}
                      {a.due_hint ? ` · said "${a.due_hint}"` : ""}
                    </Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>Nothing outstanding.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Accepted off a visit summary. Closing one out is done from the
                console, or by the subject reporting it in their own app.
              </Text>
            </Section>

            <Section title="Goals"
                     chip={openGoals_.length ? `${openGoals_.length} open` : "None"}
                     tone={openGoals_.some(g => goalOverdue(g)) ? "warn"
                           : openGoals_.length ? "brand" : "muted"}
                     summary={!goals.length ? "None assigned"
                       : openGoals_.length
                         ? openGoals_.map(g => g.title).slice(0, 2).join(", ")
                           + (openGoals_.length > 2 ? ` +${openGoals_.length - 2}` : "")
                         : `${goals.length} complete`}>
              {goals.length ? goals.map(g => (
                <View key={g.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>{g.title}</Text>
                    <Text style={s.cardMeta}>
                      {g.due_date ? `Due ${asDate(g.due_date)}` : "No due date"}
                      {g.progress?.total ? ` · ${g.progress.done}/${g.progress.total} steps` : ""}
                    </Text>
                  </View>
                  <View style={[s.pill, g.status !== "open" ? s.pillOk
                               : goalOverdue(g) ? s.pillErr
                               : g.state === "awaiting_officer" ? s.pillWarn : s.pillNeutral]}>
                    <Text style={[s.pillText, { color: g.status !== "open" ? C.ok
                                  : goalOverdue(g) ? C.err
                                  : g.state === "awaiting_officer" ? C.amber : C.brand }]}>
                      {GOAL_STATE[g.state] || ""}</Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>None assigned.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Goals are set and closed from the console.
              </Text>
            </Section>

            <Section title="Visits" chip={visits.length ? `${visits.length}` : "None"}
                     tone={visits.length ? "brand" : "muted"}
                     summary={nextVisit
                       ? `Next ${fmtVisit(nextVisit.scheduled_at)}`
                       : visits.length ? "Nothing upcoming" : "No visits on record"}>
              {visits.length ? visits.slice(0, 8).map(v => (
                <View key={v.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>{fmtVisit(v.scheduled_at)}</Text>
                    <Text style={s.cardMeta}>
                      {[v.officer, (v.notes_log || []).length
                        ? `${v.notes_log.length} notes` : "",
                        (v.photos || []).length ? `${v.photos.length} photos` : ""]
                        .filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                  <View style={[s.pill, v.status === "completed" ? s.pillOk
                               : v.accepted_at ? s.pillNeutral : s.pillWarn]}>
                    <Text style={[s.pillText, { color: v.status === "completed" ? C.ok
                                  : v.accepted_at ? C.brand : C.amber }]}>
                      {v.status === "completed" ? "Complete"
                        : v.accepted_at ? "Confirmed" : "Not confirmed"}</Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>None on record.</Text>}
            </Section>

            <Section title="Case notes" chip={notes.length ? `${notes.length}` : "None"}
                     tone={notes.length ? "brand" : "muted"}
                     summary={notes.length
                       ? `Latest ${asDate(notes[0].created_at)}`
                       : "Nothing recorded"}>
              {notes.length ? notes.slice(0, 10).map(n => (
                <View key={n.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailValue}>{n.body}</Text>
                    <Text style={s.cardMeta}>
                      {n.author || "Unattributed"} · {asDateTime(n.created_at)}</Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>Nothing recorded.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Case notes cannot be edited once saved.
              </Text>
            </Section>

            <Section title="Documents" chip={docs.length ? `${docs.length}` : "None"}
                     tone={docs.length ? "brand" : "muted"}
                     summary={docs.length
                       ? `${docs.length} on file · latest ${asDate(docs[0].created_at)}`
                       : "None on file"}>
              {docs.length ? docs.map(d => (
                <Pressable key={d.id} style={s.detailRow}
                           onPress={() => Linking.openURL(`${SAAS_BASE}/documents/${d.id}`)}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.detailValue, { color: C.brand }]}>{d.title}</Text>
                    <Text style={s.cardMeta}>{asDate(d.created_at)}</Text>
                  </View>
                  <Text style={s.detailAction}>Open</Text>
                </Pressable>
              )) : <Text style={s.cardMeta}>None on file.</Text>}
            </Section>
          </>
        )}
      </ScrollView>

      {sheet?.mode === "curfew" && (
        <CurfewSheet value={cur || {}} onCancel={() => setSheet(null)}
                     onSave={v => post("/api/curfew", v, "Curfew saved")} />
      )}
      {sheet?.mode === "employment" && (
        <EmploymentSheet value={emp || {}} onCancel={() => setSheet(null)}
                         onSave={v => post("/api/employment", v, "Employment saved")} />
      )}
      {sheet?.mode === "travel" && (
        <TravelSheet value={trav || {}} onCancel={() => setSheet(null)}
                     onSave={v => post("/api/travel-permit", v, "Travel permit saved")} />
      )}
      {sheet?.mode === "service" && (
        <ServiceSheet value={sheet.item} onCancel={() => setSheet(null)}
                      onSave={v => post("/api/obligations", { ...v, kind: "community_service" },
                                        "Requirement saved")} />
      )}
    </SafeAreaView>
  );
}

/* Chips rather than a picker — one tap, and every option is visible. */
function Choice({ options, value, onChange }) {
  return (
    <View style={s.choiceRow}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)}
                   style={[s.choice, value === v && s.choiceOn]}>
          <Text style={[s.choiceText, value === v && s.choiceTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function CurfewSheet({ value, onCancel, onSave }) {
  const [active, setActive] = useState(!!value.active);
  const [start, setStart] = useState(hhmmToDate(value.start_time || "21:00"));
  const [end, setEnd] = useState(hhmmToDate(value.end_time || "06:00"));
  const [show, setShow] = useState(null);
  return (
    <Sheet title="Curfew" onCancel={onCancel} saveLabel="Save"
           onSave={() => onSave({ active, start_time: dateToHhmm(start),
                                  end_time: dateToHhmm(end) })}>
      <Choice options={[["yes","Has a curfew"],["no","No curfew"]]}
              value={active ? "yes" : "no"} onChange={v => setActive(v === "yes")} />
      {active && (
        <View style={s.fieldRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>From</Text>
            {Platform.OS === "ios"
              ? <DateTimePicker value={start} mode="time" display="compact"
                                onChange={(_, d) => d && setStart(d)} />
              : <Pressable style={s.input} onPress={() => setShow("start")}>
                  <Text style={{ fontSize: 16 }}>{to12h(dateToHhmm(start))}</Text></Pressable>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Until</Text>
            {Platform.OS === "ios"
              ? <DateTimePicker value={end} mode="time" display="compact"
                                onChange={(_, d) => d && setEnd(d)} />
              : <Pressable style={s.input} onPress={() => setShow("end")}>
                  <Text style={{ fontSize: 16 }}>{to12h(dateToHhmm(end))}</Text></Pressable>}
          </View>
        </View>
      )}
      {show && Platform.OS === "android" && (
        <DateTimePicker value={show === "start" ? start : end} mode="time"
          onChange={(e, d) => { setShow(null);
            if (e.type === "set" && d) (show === "start" ? setStart : setEnd)(d); }} />
      )}
    </Sheet>
  );
}

function TravelSheet({ value, onCancel, onSave }) {
  const [level, setLevel] = useState(value.level || "none");
  const [exp, setExp] = useState(value.expires_on
    ? new Date(value.expires_on + "T00:00:00") : new Date(Date.now() + 90 * 864e5));
  const [show, setShow] = useState(false);
  return (
    <Sheet title="Travel permit" onCancel={onCancel} saveLabel="Save"
           onSave={() => onSave({ level,
             expires_on: level === "none" ? null : isoDay(exp) })}>
      <Choice options={TRAVEL_OPTS} value={level} onChange={setLevel} />
      {level !== "none" && (
        <>
          <Text style={s.label}>Expires</Text>
          {Platform.OS === "ios"
            ? <DateTimePicker value={exp} mode="date" display="compact" minimumDate={new Date()}
                              onChange={(_, d) => d && setExp(d)}
                              style={{ alignSelf: "flex-start" }} />
            : <>
                <Pressable style={s.input} onPress={() => setShow(true)}>
                  <Text style={{ fontSize: 16 }}>{asDate(isoDay(exp))}</Text></Pressable>
                {show && <DateTimePicker value={exp} mode="date" minimumDate={new Date()}
                  onChange={(e, d) => { setShow(false); if (e.type === "set" && d) setExp(d); }} />}
              </>}
        </>
      )}
      <Text style={s.sheetHint}>
        {level === "none" ? "No travel is permitted."
          : `${TRAVEL_LABEL[level]} travel permitted until ${asDate(isoDay(exp))}.`}
      </Text>
    </Sheet>
  );
}

/* Employment is reported by the subject and recorded by the officer, and both
   can now write it. ONE set of fields, rendered by both surfaces — two copies
   would drift, and the drift would be the two of them disagreeing about where
   someone works. */
function useEmploymentDraft(value) {
  const [status, setStatus] = useState(value.status || "not_employed");
  const [company, setCompany] = useState(value.company_name || "");
  const [address, setAddress] = useState(value.address || "");
  const [phone, setPhone] = useState(value.phone || "");
  const [supervisor, setSupervisor] = useState(value.supervisor || "");
  const employed = status === "employed";
  return {
    status, setStatus, company, setCompany, address, setAddress,
    phone, setPhone, supervisor, setSupervisor, employed,
    ready: !employed || !!company.trim(),
    payload: { status, company_name: company.trim(), address: address.trim(),
               phone: phone.trim(), supervisor: supervisor.trim() }
  };
}

function EmploymentFields({ d, youWording = false }) {
  return (
    <>
      <Choice options={[["employed","Employed"],["self_employed","Self-employed"],
                        ["not_employed","Not employed"]]}
              value={d.status} onChange={d.setStatus} />

      {/* Employer fields only exist for an employer. The server drops them for
          the other two statuses, so hiding them here says the same thing. */}
      {d.employed && (
        <>
          <Field label="Company name" value={d.company} onChange={d.setCompany}
                 placeholder="e.g. Ridgeway Fabrication" autoCapitalize="words" />
          <Field label="Address" value={d.address} onChange={d.setAddress}
                 placeholder="Street, city, state" autoCapitalize="words" />
          <View style={s.fieldRow}>
            <Field label="Phone" value={d.phone} onChange={d.setPhone}
                   placeholder="(423) 555-0100" keyboardType="phone-pad" />
            <Field label="Supervisor" value={d.supervisor} onChange={d.setSupervisor}
                   placeholder="e.g. J. Barrett" autoCapitalize="words" />
          </View>
        </>
      )}

      <Text style={s.sheetHint}>
        {d.employed
          ? d.company.trim()
            ? `Employed at ${d.company.trim()}.`
            : "Enter the company name to save."
          : d.status === "self_employed"
          ? "Self-employed. No employer details are recorded."
          : youWording ? "You are not currently employed." : "Not currently employed."}
      </Text>
    </>
  );
}

function EmploymentSheet({ value, onCancel, onSave }) {
  const d = useEmploymentDraft(value);
  return (
    <Sheet title="Employment" onCancel={onCancel} saveLabel="Save"
           disabled={!d.ready} onSave={() => onSave(d.payload)}>
      <EmploymentFields d={d} />
    </Sheet>
  );
}

function ServiceSheet({ value, onCancel, onSave }) {
  const [title, setTitle] = useState(value.title || "");
  const [hours, setHours] = useState(value.required_quantity ? String(value.required_quantity) : "");
  const [status, setStatus] = useState(value.status || "todo");
  return (
    <Sheet title={value.id ? "Edit requirement" : "Add requirement"}
           onCancel={onCancel} saveLabel="Save" disabled={!title.trim()}
           onSave={() => onSave({ id: value.id, title: title.trim(),
             required_quantity: hours ? Number(hours) : null, unit: "hours", status })}>
      <Text style={s.label}>Title</Text>
      <TextInput style={s.input} value={title} onChangeText={setTitle}
                 placeholder="e.g. Riverside Park clean-up" placeholderTextColor={C.faint} />
      <Text style={s.label}>Hours required</Text>
      <TextInput style={s.input} value={hours} onChangeText={setHours}
                 keyboardType="decimal-pad" placeholder="40" placeholderTextColor={C.faint} />
      <Text style={s.label}>Status</Text>
      <Choice options={CS_OPTS} value={status} onChange={setStatus} />
    </Sheet>
  );
}

/* ================================================================
   Home — condensed case profile, then Programs / Visits
================================================================ */
/* Two ways to owe an acknowledgment: never given one, or had it withdrawn
   because the officer amended the conditions. */
const needsAck = c => !!(c?.agreement && !c.agreement.subject_signed_at);
const wasAmended = c => !!(c?.agreement?.amended_at && needsAck(c));

/**
 * Everything currently waiting on the subject.
 *
 * One function rather than a chain of banners, so "what do I owe" has a single
 * answer that the screen renders and nothing else has to remember to keep in
 * step. Order is the order they should be done in: you acknowledge the
 * conditions of your supervision before signing off pieces of a plan made
 * under them.
 *
 * `needsPlanAck` and `rePending` are declared further down with the rest of
 * the reentry helpers; this is only ever called during a render, by which
 * point they exist.
 */
/**
 * The home screen: everything waiting on this person, as cards.
 *
 * It used to be the programs list with the outstanding items stacked above it
 * as banners — which worked while there were two of them and stopped working
 * at seven. A wall of identical amber bars is not a summary; it is a queue
 * somebody scrolls past to reach the thing they opened the app for.
 *
 * So the same facts, one card each, ordered by how much they need doing.
 * Nothing here is new information — it is the counts the badges already carry,
 * given room to say what they mean.
 */
function homeCards(c, programs, open) {
  const cards = [];
  const add = (x) => cards.push(x);

  if (needsAck(c)) add({
    key: "agreement", icon: "document-text-outline", tone: "err",
    title: "Conditions of supervision",
    line: wasAmended(c) ? "Updated — read and acknowledge again"
                        : "Read and acknowledge them",
    cta: "Review", onPress: open.agreement
  });

  const rp = c?.reentry;
  const mine = rp?.readiness?.awaiting_signature || 0;
  if (rp && mine > 0) add({
    key: "reentry", icon: "footsteps-outline", tone: "err",
    title: "Reentry plan",
    line: `${mine} checkpoint${mine === 1 ? "" : "s"} need${mine === 1 ? "s" : ""} your signature`,
    meta: rp.readiness ? `${rp.readiness.percent}% ready` : "",
    cta: "Sign", onPress: open.reentry
  });

  const newA = c?.unseen_actions || 0;
  const openA = (c?.actions || []).length;
  if (openA) add({
    key: "actions", icon: "checkbox-outline",
    tone: (c?.actions || []).some(overdueAction) ? "err" : newA ? "warn" : "brand",
    title: "What you agreed to",
    line: newA ? `${newA} new item${newA === 1 ? "" : "s"} from a visit`
               : `${openA} thing${openA === 1 ? "" : "s"} to do`,
    meta: openA !== newA ? `${openA} outstanding` : "",
    cta: "Open", onPress: open.actions
  });

  const unconf = c?.unconfirmed_visits || 0;
  const nextVisit = (c?.visits || [])
    .filter(v => v.scheduled_at && v.status === "scheduled")
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
  if (unconf || nextVisit) add({
    key: "visits", icon: "people-outline", tone: unconf ? "warn" : "brand",
    title: "Visits",
    line: unconf
      ? `${unconf} appointment${unconf === 1 ? "" : "s"} need${unconf === 1 ? "s" : ""} confirming`
      : `Next on ${fmtVisit(nextVisit.scheduled_at)}`,
    cta: unconf ? "Confirm" : "See all", onPress: open.visits
  });

  const dates = (c?.important_dates || []);
  const unack = dates.filter(d => d.state === "assigned" || d.state === "viewed").length;
  const unreported = dates.filter(d => d.awaiting_outcome).length;
  if (unack || unreported) add({
    key: "dates", icon: "calendar-outline", tone: unreported ? "err" : "warn",
    title: "Appointments",
    line: unack ? `${unack} to confirm` : `${unreported} with no outcome reported`,
    meta: unack && unreported ? `${unreported} need reporting` : "",
    cta: "Open", onPress: open.details
  });

  const fin = c?.financial;
  if (fin?.totals?.balance_cents > 0) add({
    key: "money", icon: "cash-outline",
    tone: fin.totals.overdue_cents > 0 ? "err" : "brand",
    title: "What you owe",
    line: fin.totals.overdue_cents > 0
      ? `${money(fin.totals.overdue_cents)} overdue`
      : `${money(fin.totals.balance_cents)} outstanding`,
    cta: "Open", onPress: open.details
  });

  const goalsOpen = (c?.goals || []).filter(g => g.status === "open").length;
  if (goalsOpen) add({
    key: "goals", icon: "flag-outline", tone: "brand",
    title: "Goals",
    line: `${goalsOpen} being worked on`,
    cta: "Open", onPress: open.actions
  });

  const notStarted = (programs || []).filter(p => !progStarted(p)).length;
  if (notStarted) add({
    key: "programs", icon: "book-outline", tone: "err",
    title: "Programs",
    line: `${notStarted} course${notStarted === 1 ? "" : "s"} not started`,
    cta: "Open", onPress: open.programs
  });

  return cards;
}

/**
 * The home screen itself.
 *
 * Cards, not banners. A banner says "something is wrong here"; a card says
 * what and how much. Seven banners say nothing at all.
 */
function HomeScreen({ caseData, programs, onRefresh, open }) {
  const pull = usePullToRefresh(onRefresh);
  const cards = homeCards(caseData, programs, open);

  const TONE = { err: [C.err, C.errSoft], warn: [C.amber, C.amberSoft],
                 brand: [C.brand, C.brandSoft] };

  return (
    <ScrollView contentContainerStyle={s.listBody} refreshControl={pull}>
      {!caseData && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

      {cards.map(card => {
        const [ink, bg] = TONE[card.tone] || TONE.brand;
        return (
          <Pressable key={card.key} onPress={card.onPress}
                     style={({ pressed }) => [s.homeCard, pressed && { opacity: .6 }]}>
            <View style={[s.homeIcon, { backgroundColor: bg }]}>
              <Ionicons name={card.icon} size={20} color={ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.homeTitle}>{card.title}</Text>
              <Text style={[s.homeLine, { color: ink }]}>{card.line}</Text>
              {card.meta ? <Text style={s.homeMeta}>{card.meta}</Text> : null}
            </View>
            <Text style={s.homeCta}>{card.cta}</Text>
          </Pressable>
        );
      })}

      {caseData && !cards.length ? (
        <View style={s.homeClear}>
          <Ionicons name="checkmark-circle-outline" size={34} color={C.ok} />
          <Text style={s.homeClearTitle}>Nothing outstanding</Text>
          <Text style={s.homeClearText}>
            You are up to date. Anything new from a visit will appear here.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}


function Home({ auth, onLaunch, onSignOut }) {
  /* Home, not Programs. The app is a supervision app that happens to carry
     courses, and opening on the course list said the opposite. */
  const [tab, setTab] = useState("home");
  const [caseData, setCaseData] = useState(null);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [reentryOpen, setReentryOpen] = useState(false);

  /* Northwood's data, fetched with the Waypoint token — their side asks
     Waypoint who the token belongs to rather than trusting the app. */
  /* One flag per thing that can be marked seen, because they are marked by
     different screens: visits by the Visits tab, goals and commitments by the
     Actions tab. A single "seen" flag would clear a badge nobody looked at. */
  const loadCase = useCallback(async (markSeen, markActionsSeen) => {
    const q = [markSeen && "seen=1",
               markActionsSeen && "goals_seen=1",
               markActionsSeen && "actions_seen=1"]
                .filter(Boolean).join("&");
    try {
      const r = await authed(`${SAAS_BASE}/api/me/case${q ? `?${q}` : ""}`, auth.token);
      if (r.ok) setCaseData(await r.json());
    } catch {}   // a 401 has already ended the session
  }, [auth]);

  useEffect(() => { loadCase(false); }, [loadCase]);

  /* Assignments live in Waypoint, not Northwood, so this is a second server —
     the app is a client of both, by design. Held here rather than inside the
     Programs tab because the badge on the tab needs the same answer, and two
     fetches of one endpoint is two versions of one fact. */
  const [programs, setPrograms] = useState(null);
  const [progError, setProgError] = useState(null);
  const loadPrograms = useCallback(async () => {
    setProgError(null);
    try {
      const r = await authed(`${API_BASE}/api/me/assignments`, auth.token);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPrograms((await r.json()).programs || []);
    } catch (e) {
      // An expired session already returned to sign-in; don't blame the network.
      if (String(e.message || "").includes("session")) return;
      setProgError(`Can't reach Waypoint at ${API_BASE}. Check the server is running `
                 + `and that API_BASE in config.js is this machine's LAN address.`);
    }
  }, [auth]);
  useEffect(() => { loadPrograms(); }, [loadPrograms]);

  const progBadge = programBadge(programs);
  /* The tab holds two kinds of thing now — commitments made at a visit and the
     longer goals they usually serve — so the badge counts both. An officer's
     accepted action with a date on it deserves the same red the goals get. */
  const actionsOpen = (caseData?.actions || []).length;
  const actionsLate = (caseData?.actions || []).some(overdueAction);
  const goalsOnly = goalBadge(caseData?.goals);
  const goalsBadge = (goalsOnly || actionsOpen)
    ? { n: (goalsOnly?.n || 0) + actionsOpen,
        colour: actionsLate ? C.err : (goalsOnly?.colour || C.brand) }
    : null;

  const unseen = caseData?.unseen_visits || 0;
  /* The badge counts appointments still waiting on them, not ones they have
     not looked at. Opening the tab used to clear it, so an unconfirmed visit
     lost its indicator the moment they glanced at the screen — while the
     officer's console still read "Seen, not confirmed". */
  const unconfirmed = caseData?.unconfirmed_visits || 0;
  const subject = caseData?.subject;

  // Marking them seen is still worth doing; it is just not what the badge is.
  const openVisits = () => { setTab("visits"); if (unseen) loadCase(true); };
  const openGoals = () => {
    setTab("goals");
    /* Opening the tab is what marks a goal — and now an action item — seen.
       The badge does not depend on it: that counts what is outstanding, and
       only finishing something clears it. Seeing a badge is not seeing the
       thing it points at. */
    if (caseData?.unseen_goals || caseData?.unseen_actions) loadCase(false, true);
  };

  /* The root is BRAND coloured, not the page background.
     SafeAreaView pads the notch and the home indicator from the outside, so
     whatever colour it carries is what shows in those strips. Left as the page
     background it drew a pale gap under the tab bar; painted brand, the bar
     runs to the bottom edge and the header runs to the top, which is what a
     tab bar is meant to look like. The content sits in its own view between
     them and keeps the page background. */
  return (
    <SafeAreaView style={s.safeBrand}>
      <View style={s.profileBarBrand}>
        <Avatar name={auth.person?.name || subject?.name} onBrand />
        <View style={{ flex: 1 }}>
          <Text style={s.profileNameOn}>{auth.person?.name || subject?.name}</Text>
          <Text style={s.profileMetaOn}>
            {subject?.case_number ? `${subject.case_number}  ·  ` : ""}
            {subject?.status || "Learner"}
          </Text>
          {subject?.officer ? (
            <Text style={s.profileMetaOn}>Officer {subject.officer}</Text>
          ) : null}
        </View>
        <Pressable onPress={onSignOut} hitSlop={10}>
          <Text style={s.signOutOn}>Sign out</Text>
        </Pressable>
      </View>

      <View style={s.appBody}>
      {tab === "home"
        ? <HomeScreen caseData={caseData} programs={programs}
                      onRefresh={() => loadCase(false)}
                      open={{ agreement: () => setAgreementOpen(true),
                              reentry: () => setReentryOpen(true),
                              visits: openVisits, actions: openGoals,
                              programs: () => setTab("programs"),
                              details: () => setTab("details") }} />
        : tab === "programs"
        ? <ProgramList programs={programs} error={progError} onReload={loadPrograms}
                       onLaunch={onLaunch} onSignOut={onSignOut} />
        : tab === "goals"
        ? <GoalList auth={auth} caseData={caseData} onRefresh={() => loadCase(false)} />
        : tab === "visits"
        ? <VisitList auth={auth} caseData={caseData} onRefresh={() => loadCase(true)} />
        : <MyDetails auth={auth} caseData={caseData} onRefresh={() => loadCase(false)}
                     onOpenAgreement={() => setAgreementOpen(true)}
                     onOpenReentry={() => setReentryOpen(true)} />}
      </View>

      {/* The bottom bar. Five destinations, thumb-reachable, and the badge sits
          on the icon rather than beside a word — at this size the word is the
          label, not the target. */}
      <View style={s.navBar}>
        {[{ key: "home", icon: "home-outline", on: "home", label: "Home",
            badge: null, press: () => setTab("home") },
          { key: "programs", icon: "book-outline", on: "book", label: "Programs",
            badge: progBadge, press: () => setTab("programs") },
          { key: "goals", icon: "checkbox-outline", on: "checkbox", label: "Actions",
            badge: goalsBadge, press: openGoals },
          { key: "visits", icon: "people-outline", on: "people", label: "Visits",
            badge: unconfirmed > 0 ? { n: unconfirmed, colour: C.err } : null,
            press: openVisits },
          { key: "details", icon: "person-outline", on: "person", label: "Me",
            badge: null, press: () => setTab("details") }
        ].map(t => {
          const active = tab === t.key;
          return (
            <Pressable key={t.key} style={s.navItem} onPress={t.press}>
              <View>
                <Ionicons name={active ? t.on : t.icon} size={23}
                          color={active ? "#fff" : "rgba(255,255,255,0.62)"} />
                {t.badge ? (
                  <View style={[s.navBadge, { backgroundColor: t.badge.colour }]}>
                    <Text style={s.navBadgeText}>{t.badge.n}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[s.navLabel, active && s.navLabelOn]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Modal visible={agreementOpen} animationType="slide"
             onRequestClose={() => setAgreementOpen(false)}>
        <AgreementScreen auth={auth} caseData={caseData}
                         onClose={() => setAgreementOpen(false)}
                         onAcknowledged={() => loadCase(false)} />
      </Modal>

      <Modal visible={reentryOpen} animationType="slide"
             onRequestClose={() => setReentryOpen(false)}>
        <ReentryScreen auth={auth} caseData={caseData}
                       onClose={() => setReentryOpen(false)}
                       onChanged={() => loadCase(false)} />
      </Modal>
    </SafeAreaView>
  );
}

/* ================================================================
   Supervision agreement — the subject reads the same document the PDF
   renders, grouped the same way, and acknowledges it here.

   Acceptance is deliberate on purpose: the button stays disabled until they
   have scrolled to the end and ticked the box. A promise to have read
   something they were never shown is worth nothing, and this is the record
   a revocation hearing would rest on.
================================================================ */
function AgreementScreen({ auth, caseData, onClose, onAcknowledged }) {
  const pull = usePullToRefresh(onAcknowledged);
  const a = caseData?.agreement;
  const subject = caseData?.subject || {};
  const cats = caseData?.condition_categories || [];
  const signed = !!a?.subject_signed_at;

  const [reachedEnd, setReachedEnd] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!a) return null;

  const byCat = {};
  (a.conditions || []).forEach(c => (byCat[c.category] ||= []).push(c));
  let n = 0;

  const accept = async () => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/agreement/sign`, auth.token,
                             { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not record your acknowledgment");
      await onAcknowledged();
      onClose();
      toast("Acknowledgment recorded");
    } catch (e) {
      toast(String(e.message || e), "err");
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.agHeader}>
        <Text style={s.agHeaderTitle} numberOfLines={1}>Conditions of Supervision</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={s.agClose}>Close</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.agDocBody} refreshControl={pull}
        scrollEventThrottle={64}
        onScroll={e => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 48)
            setReachedEnd(true);
        }}
        onContentSizeChange={(_w, h) => { if (h < 1) setReachedEnd(true); }}>

        {!signed && (
          <View style={s.agNotice}>
            <Text style={s.agNoticeText}>
              {wasAmended(caseData)
                ? `These conditions were updated on ${asDateTime(a.amended_at)}. Your earlier `
                  + "acknowledgment no longer applies — please read them again."
                : "Read these conditions in full, then acknowledge them at the bottom."}
            </Text>
          </View>
        )}

        <Text style={s.agOffice}>{a.office || "Northwood Corrections"}</Text>

        <View style={s.agFacts}>
          <Fact label="Subject" value={subject.name} />
          <Fact label="Case number" value={subject.case_number} />
          <Fact label="Supervision type" value={a.kind} />
          <Fact label="Level" value={a.supervision_level} />
          <Fact label="Start date" value={asDate(a.start_date)} />
          <Fact label="Expires" value={asDate(a.end_date)} />
          <Fact label="Supervising officer" value={a.officer_name} />
        </View>

        {cats.map(([key, label]) => {
          const list = byCat[key] || [];
          if (!list.length) return null;
          return (
            <View key={key}>
              <Text style={s.agSection}>{label}</Text>
              {list.map(c => {
                const num = ++n;
                return (
                  <View key={c.id} style={s.agCond}>
                    <Text style={s.agCondNum}>{num}.</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.agCondText}>{c.body}</Text>
                      {c.obligation_title ? (
                        <Text style={s.agTracked}>
                          Tracked as {c.obligation_title}
                          {c.required_quantity
                            ? ` — ${c.required_quantity} ${c.unit || ""}`.trimEnd() : ""}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}

        {!(a.conditions || []).length && (
          <Text style={s.cardMeta}>No conditions have been recorded.</Text>
        )}

        {a.violation_text ? (
          <View style={s.agViol}>
            <Text style={s.agViolTitle}>IF YOU DO NOT COMPLY</Text>
            <Text style={s.agViolText}>{a.violation_text}</Text>
          </View>
        ) : null}

        <View style={s.agAck}>
          <Text style={s.agAckTitle}>Acknowledgment</Text>
          {signed ? (
            <View style={s.agAckDone}>
              <Text style={s.agAckDoneText}>
                ✓  You acknowledged these conditions on {asDateTime(a.subject_signed_at)}.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.agAckBlurb}>
                By acknowledging, you confirm that these conditions have been explained to
                you, that you have read them or had them read to you, and that you
                understand them.
              </Text>
              <Pressable style={s.agCheckRow} disabled={!reachedEnd}
                         onPress={() => setChecked(v => !v)}>
                <View style={[s.agBox, checked && s.agBoxOn, !reachedEnd && s.agBoxOff]}>
                  {checked && <Text style={s.agBoxTick}>✓</Text>}
                </View>
                <Text style={[s.agCheckText, !reachedEnd && { color: C.faint }]}>
                  {reachedEnd
                    ? "I have read and understand these conditions of supervision."
                    : "Scroll to the end of the conditions to continue."}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.cta, (!checked || busy) && s.ctaOff,
                                         pressed && { backgroundColor: C.brandDark }]}
                disabled={!checked || busy} onPress={accept}>
                <Text style={s.ctaText}>
                  {busy ? "Recording…" : "Acknowledge these conditions"}</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}


/* ================================================================
   Reentry plan — the subject's side.

   Two different things happen on this screen and they are deliberately not
   merged. Accepting the PLAN is a one-off: the subject reads the whole
   document and says yes, exactly as with the conditions of supervision.
   Signing a CHECKPOINT happens over and over, weeks apart, as each piece of
   their release gets arranged.

   The second is the one that matters here. A checkpoint the officer alone
   ticks is a tick box; a checkpoint both parties sign is a record that the
   person it is about agreed it had actually happened. So the subject can
   only sign what the officer has already marked verified, and their
   signature is what completes it.
================================================================ */

const reDone = i => i.status === "exception" ||
  (i.status === "ready" && i.officer_signed_at && i.subject_signed_at);

/* Waiting on THIS person specifically — the only thing they can act on. */
const reNeedsMe = i =>
  i.status === "ready" && i.officer_signed_at && !i.subject_signed_at;

const needsPlanAck = c => !!(c?.reentry && !c.reentry.subject_signed_at);

/* A program is started once it is no longer "not attempted" — the same test
   the list uses to label a card, defined once so the badge and the card
   cannot disagree about what "started" means. */
const progStarted = p => !!p.registration_id && p.completion_status !== "not attempted";
/* Some SCORM packages mark their content completed on ARRIVAL at the quiz.
   If there is no result yet and the attempt was explicitly suspended, the
   learner still has something to resume. Completed with passed/failed remains
   a real completion even when a package leaves its exit mode as suspend. */
const progResumable = p => p.exit_mode === "suspend" &&
  (p.completion_status !== "completed" || p.success_status === "unknown");
const progDone = p => p.completion_status === "completed" && !progResumable(p);

/**
 * What the Programs tab badge says.
 *
 * Red while something has not been opened, amber once everything outstanding
 * is under way, and nothing at all when it is all finished. Two states rather
 * than one because "you have not started this" and "you are part-way through"
 * ask different things of the person holding the phone.
 */
/* Mirrors db/goals.mjs. A goal past its date is urgent whatever its steps
   say, and a goal nobody has touched is urgent too — both are red. Once
   everything open is under way it is amber, and a closed goal is nothing. */
/** An action past the date derived from what was said at the visit. */
const overdueAction = a =>
  !!a.due_date && a.due_date < new Date().toISOString().slice(0, 10);

const goalOverdue = g => g.status === "open" && !!g.due_date &&
  g.due_date < new Date().toISOString().slice(0, 10);

function goalBadge(goals) {
  const open = (goals || []).filter(g => g.status === "open");
  if (!open.length) return null;
  const urgent = open.some(g => goalOverdue(g) || (g.progress?.done ?? 0) === 0);
  return { n: open.length, colour: urgent ? C.err : C.amber };
}

function programBadge(programs) {
  const open = (programs || []).filter(p => !progDone(p));
  if (!open.length) return null;
  return { n: open.length, colour: open.some(p => !progStarted(p)) ? C.err : C.amber };
}
const rePending = c => (c?.reentry?.items || []).filter(reNeedsMe).length;

const RE_AREA_LABEL = { ready: "Ready", in_progress: "In progress",
  needs_attention: "Needs attention", at_risk: "At risk",
  not_applicable: "Not applicable" };

function reAreaStatus(items) {
  const live = items.filter(i => i.status !== "not_applicable");
  if (!live.length) return "not_applicable";
  if (live.every(reDone)) return "ready";
  const unmet = live.filter(i => !reDone(i));
  if (unmet.some(i => i.critical && i.status === "not_started")) return "at_risk";
  if (unmet.some(i => i.status === "in_progress" || i.status === "ready"))
    return "in_progress";
  return "needs_attention";
}

function ReentryScreen({ auth, caseData, onClose, onChanged }) {
  const pull = usePullToRefresh(onChanged);
  const plan = caseData?.reentry;
  const areas = caseData?.reentry_areas || [];
  const statusLabel = Object.fromEntries(caseData?.reentry_statuses || []);
  const [busy, setBusy] = useState(null);
  const [checked, setChecked] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  if (!plan) return null;
  const accepted = !!plan.subject_signed_at;
  const r = plan.readiness || {};

  const signItem = async item => {
    setBusy(item.id);
    try {
      const res = await authed(`${SAAS_BASE}/api/me/reentry/item/sign`, auth.token,
        { method: "POST", body: JSON.stringify({ id: item.id }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not record your signature");
      await onChanged();
      toast(d.complete ? `${item.label} — complete` : "Signed");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(null); }
  };

  const acceptPlan = async () => {
    setBusy("plan");
    try {
      const res = await authed(`${SAAS_BASE}/api/me/reentry/sign`, auth.token,
                               { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not record your acceptance");
      await onChanged();
      toast("Reentry plan accepted");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(null); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.agHeader}>
        <Text style={s.agHeaderTitle} numberOfLines={1}>Reentry Plan</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={s.agClose}>Close</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.agDocBody} refreshControl={pull}
        scrollEventThrottle={64}
        onScroll={e => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 48)
            setReachedEnd(true);
        }}>

        <View style={s.reSummary}>
          <Text style={s.rePct}>{r.percent}%</Text>
          <Text style={s.reSummaryLine}>
            {r.complete} of {r.total} steps complete
          </Text>
          <View style={[s.reGate, r.ready_for_reentry && s.reGateOn,
                        plan.certified_at && s.reGateDone]}>
            <Text style={[s.reGateText, r.ready_for_reentry && s.reGateTextOn,
                          plan.certified_at && s.reGateTextDone]}>
              {plan.certified_at
                ? "Your plan is complete"
                : r.ready_for_reentry
                ? "All essential requirements are met"
                : `${r.critical_total - r.critical_complete} essential requirement${
                    r.critical_total - r.critical_complete === 1 ? "" : "s"} outstanding`}
            </Text>
          </View>
          {plan.certified_at ? (
            <Text style={s.reTarget}>
              Signed off by {plan.certified_by || "your officer"} on{" "}
              {asDate(plan.certified_at)}
            </Text>
          ) : null}
          {plan.target_release_date ? (
            <Text style={s.reTarget}>
              Target release {asDate(plan.target_release_date)}</Text>
          ) : null}
        </View>

        {/* The only thing on this screen they can act on, said once, at the top. */}
        {accepted && rePending(caseData) > 0 ? (
          <View style={s.agNotice}>
            <Text style={s.agNoticeText}>
              {rePending(caseData)} step{rePending(caseData) === 1 ? " is" : "s are"} waiting
              for your signature. Sign one only if you agree it has actually been arranged.
            </Text>
          </View>
        ) : null}

        {areas.map(([key, title, desc]) => {
          const items = (plan.items || []).filter(i => i.area === key);
          if (!items.length) return null;
          const st = reAreaStatus(items);
          return (
            <View key={key} style={s.reAreaCard}>
              <View style={s.reAreaTop}>
                <Text style={s.reAreaTitle}>{title}</Text>
                <View style={[s.reChip, s[`reChip_${st}`]]}>
                  <Text style={[s.reChipText, s[`reChipText_${st}`]]}>
                    {RE_AREA_LABEL[st]}</Text>
                </View>
              </View>
              <Text style={s.reAreaDesc}>{desc}</Text>

              {items.map(i => {
                const done = reDone(i);
                const mine = reNeedsMe(i);
                return (
                  <View key={i.id} style={s.reRow}>
                    <View style={[s.reTick, done && s.reTickOn]}>
                      {done ? <Text style={s.reTickMark}>✓</Text> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.reRowLabel, i.status === "not_applicable"
                                    && { color: C.faint }]}>{i.label}</Text>
                      {i.detail ? <Text style={s.reRowDetail}>{i.detail}</Text> : null}
                      {i.status === "exception" ? (
                        <Text style={s.reRowMit}>
                          Exception — {i.mitigation}
                        </Text>
                      ) : null}
                      {!done && !mine ? (
                        <Text style={s.reRowStatus}>
                          {i.status === "ready"
                            ? "Waiting for your officer to sign"
                            : statusLabel[i.status] || i.status}
                        </Text>
                      ) : null}
                      {mine && accepted ? (
                        <Pressable
                          style={({ pressed }) => [s.reSignBtn, pressed && { opacity: .7 },
                                                   busy === i.id && { opacity: .5 }]}
                          disabled={busy === i.id}
                          onPress={() => signItem(i)}>
                          <Text style={s.reSignBtnText}>
                            {busy === i.id ? "Signing…" : "Sign off"}</Text>
                        </Pressable>
                      ) : null}
                      {mine && !accepted ? (
                        <Text style={s.reRowStatus}>
                          Accept the plan below before signing steps off.</Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}

        <View style={s.agAck}>
          <Text style={s.agAckTitle}>Acceptance</Text>
          {accepted ? (
            <View style={s.agAckDone}>
              <Text style={s.agAckDoneText}>
                ✓  You accepted this plan on {asDateTime(plan.subject_signed_at)}.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.agAckBlurb}>
                By accepting, you confirm that this plan has been explained to you and
                that you understand what is required of you before release. This is not
                a statement that anything is finished — you and your officer sign each
                step off together as it is arranged, and your officer signs the whole
                plan off at the end.
              </Text>
              <Pressable style={s.agCheckRow} disabled={!reachedEnd}
                         onPress={() => setChecked(v => !v)}>
                <View style={[s.agBox, checked && s.agBoxOn, !reachedEnd && s.agBoxOff]}>
                  {checked && <Text style={s.agBoxTick}>✓</Text>}
                </View>
                <Text style={[s.agCheckText, !reachedEnd && { color: C.faint }]}>
                  {reachedEnd
                    ? "I have read and understand this reentry plan."
                    : "Scroll to the end of the plan to continue."}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.cta, (!checked || busy === "plan") && s.ctaOff,
                                         pressed && { backgroundColor: C.brandDark }]}
                disabled={!checked || busy === "plan"} onPress={acceptPlan}>
                <Text style={s.ctaText}>
                  {busy === "plan" ? "Recording…" : "Accept this plan"}</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================================================================
   My Details — curfew and community service are set by the officer and
   read-only here. Vehicles are self-reported, so the subject maintains
   their own.
================================================================ */
function MyDetails({ auth, caseData, onRefresh, onOpenAgreement, onOpenReentry }) {
  const pull = usePullToRefresh(onRefresh);
  const agrPdf = (caseData?.documents || [])
    .find(d => d.doc_type === "supervision_agreement");
  const agr = caseData?.agreement;
  const ackOwed = needsAck(caseData);
  const cur = caseData?.curfew;
  const svc = caseData?.community_service || [];
  const cars = caseData?.vehicles || [];
  const trav = caseData?.travel_permit;
  const emp = caseData?.employment;
  const travExpired = isExpired(trav);
  const travAllowed = trav && trav.level !== "none" && !travExpired;
  const [editing, setEditing] = useState(null);   // {} for new, {…} for existing
  const [busy, setBusy] = useState(false);

  const save = async v => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/vehicles`, auth.token, {
        method: "POST", body: JSON.stringify(v) });
      if (!r.ok) throw new Error((await r.json()).error || "Could not save");
      setEditing(null); await onRefresh();
      toast(v.id ? "Vehicle updated" : "Vehicle added");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(false); }
  };

  // Native confirmations stay native — Alert IS the platform dialog here.
  // The empty body said nothing; name what is being removed.
  /* Their own people. The subject_id comes from the token on the server, so
     nothing here needs to say who they are. */
  const saveEmployment = async (v, done) => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/employment`, auth.token, {
        method: "POST", body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not save");
      await onRefresh();
      done();
      toast("Employment updated");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(false); }
  };

  const saveContact = async (v, done) => {
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/contacts`, auth.token, {
        method: "POST", body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not save");
      await onRefresh();
      done();
      toast(v.id ? "Contact updated" : "Contact added");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(false); }
  };

  const removeContact = async c => {
    try {
      const r = await authed(`${SAAS_BASE}/api/me/contacts/delete`, auth.token, {
        method: "POST", body: JSON.stringify({ id: c.id }) });
      if (!r.ok) throw new Error((await r.json()).error || "Could not remove");
      await onRefresh();
      toast("Contact removed");
    } catch (e) { toast(String(e.message || e), "err"); }
  };

  const remove = v => Alert.alert("Remove this vehicle?",
    `${[v.year, v.make, v.model].filter(Boolean).join(" ") || "This vehicle"} will be `
    + "removed from your record. Your officer will see the change.", [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: async () => {
        try {
          const r = await authed(`${SAAS_BASE}/api/me/vehicles/delete`, auth.token, {
            method: "POST", body: JSON.stringify({ id: v.id }) });
          if (!r.ok) throw new Error((await r.json()).error || "Could not remove");
          await onRefresh();
          toast("Vehicle removed");
        } catch (e) { toast(String(e.message || e), "err"); }
      } }]);

  return (
    <ScrollView contentContainerStyle={s.listBody} refreshControl={pull}>
      {!caseData && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

      {caseData && (
        <>
          <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>Curfew</Text>
              <View style={[s.pill, cur?.active ? s.pillNeutral : s.pillMuted]}>
                <Text style={[s.pillText, { color: cur?.active ? C.brand : C.muted }]}>
                  {cur?.active ? "In effect" : "None"}</Text>
              </View>
            </View>
            {cur?.active ? (
              <>
                <Text style={s.bigTime}>{to12h(cur.start_time)} to {to12h(cur.end_time)}</Text>
                {cur.notes ? <Text style={s.noteLine}>{cur.notes}</Text> : null}
              </>
            ) : (
              <Text style={s.cardMeta}>You do not currently have a curfew.</Text>
            )}
          </View>

          {(agr || agrPdf) && (
            <View style={s.card}>
              <View style={s.cardTop}>
                <Text style={s.cardTitle}>Supervision agreement</Text>
                {agr && (
                  <View style={[s.pill, ackOwed ? s.pillWarn : s.pillOk]}>
                    <Text style={[s.pillText, { color: ackOwed ? C.amber : C.ok }]}>
                      {ackOwed ? "Action needed" : "Acknowledged"}</Text>
                  </View>
                )}
              </View>

              {agr ? (
                <Text style={s.cardMeta}>
                  {ackOwed
                    ? wasAmended(caseData)
                      ? "Your conditions were updated. Please review and acknowledge them again."
                      : `${(agr.conditions || []).length} conditions to review and acknowledge.`
                    : `You acknowledged these conditions on ${asDateTime(agr.subject_signed_at)}.`}
                </Text>
              ) : (
                <Text style={s.cardMeta}>{agrPdf.title}</Text>
              )}

              {agr && (
                <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                  onPress={onOpenAgreement}>
                  <Text style={s.ctaText}>
                    {ackOwed ? "Review and acknowledge" : "Read my conditions"}</Text>
                </Pressable>
              )}

              {agrPdf && (
                <Pressable style={({ pressed }) => [s.ctaGhost, pressed && { opacity: .6 }]}
                  onPress={() => Linking.openURL(`${SAAS_BASE}/documents/${agrPdf.id}`)}>
                  <Text style={s.ctaGhostText}>Open signed PDF</Text>
                </Pressable>
              )}
            </View>
          )}

          {caseData?.reentry && (() => {
            const rp = caseData.reentry, rr = rp.readiness || {};
            const owed = !rp.subject_signed_at, waiting = rePending(caseData);
            return (
              <View style={s.card}>
                <View style={s.cardTop}>
                  <Text style={s.cardTitle}>Reentry plan</Text>
                  <View style={[s.pill, owed || waiting ? s.pillWarn : s.pillNeutral]}>
                    <Text style={[s.pillText,
                                  { color: owed || waiting ? C.amber : C.brand }]}>
                      {rp.certified_at ? "Complete"
                        : owed ? "Action needed"
                        : waiting ? `${waiting} to sign`
                        : `${rr.percent}% ready`}</Text>
                  </View>
                </View>
                <Text style={s.cardMeta}>
                  {rp.certified_at
                    ? `Complete. Signed off by ${rp.certified_by || "your officer"} on `
                      + `${asDate(rp.certified_at)}.`
                    : owed
                    ? "Your reentry plan is ready to review and accept."
                    : waiting
                      ? `${waiting} step${waiting === 1 ? "" : "s"} your officer has `
                        + "verified are waiting for your signature."
                      : `${rr.complete} of ${rr.total} steps complete. `
                        + (rr.ready_for_reentry
                           ? "All essential requirements are met."
                           : `${rr.critical_total - rr.critical_complete} essential `
                             + "requirements outstanding.")}
                </Text>
                <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                  onPress={onOpenReentry}>
                  <Text style={s.ctaText}>
                    {owed ? "Review and accept" : waiting ? "Sign off steps" : "Open my plan"}</Text>
                </Pressable>
              </View>
            );
          })()}

          <DatesCard auth={auth} caseData={caseData} onRefresh={onRefresh}
                     onOpenMaps={openMaps} />

          <FinanceCard auth={auth} caseData={caseData} onRefresh={onRefresh} />

          <EmploymentCard value={emp} busy={busy} onSave={saveEmployment} />

          <ContactsCard contacts={caseData?.contacts || []} busy={busy}
                        onSave={saveContact} onRemove={removeContact} />

          <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>Travel permit</Text>
              <View style={[s.pill, travAllowed ? s.pillNeutral : s.pillMuted]}>
                <Text style={[s.pillText, { color: travAllowed ? C.brand : C.muted }]}>
                  {travExpired ? "Expired" : travAllowed ? TRAVEL_LABEL[trav.level] : "None"}
                </Text>
              </View>
            </View>
            {travAllowed ? (
              <>
                <Text style={s.bigTime}>{TRAVEL_LABEL[trav.level]}</Text>
                <Text style={s.cardMeta}>
                  {trav.expires_on ? `Valid until ${asDate(trav.expires_on)}` : "No expiry date"}
                </Text>
                {trav.notes ? <Text style={s.noteLine}>{trav.notes}</Text> : null}
              </>
            ) : travExpired ? (
              <Text style={s.cardMeta}>
                Your permit expired on {asDate(trav.expires_on)}. Speak to your officer
                before travelling.
              </Text>
            ) : (
              <Text style={s.cardMeta}>
                You are not currently permitted to travel outside your area.
              </Text>
            )}
          </View>

          <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>Community service</Text>
              {svc.length > 0 && (
                <View style={[s.pill, s.pillMuted]}>
                  <Text style={[s.pillText, { color: C.muted }]}>
                    {svc.filter(o => o.status === "complete").length}/{svc.length} done</Text>
                </View>
              )}
            </View>
            {svc.length ? svc.map(o => (
              <View key={o.id} style={s.detailRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.detailTitle}>{o.title}</Text>
                  <Text style={s.cardMeta}>
                    {o.required_quantity ? `${o.required_quantity} hours` : "Hours to be confirmed"}</Text>
                </View>
                <View style={[s.pill, o.status === "complete" ? s.pillOk
                             : o.status === "in_progress" ? s.pillNeutral : s.pillMuted]}>
                  <Text style={[s.pillText, { color: o.status === "complete" ? C.ok
                                : o.status === "in_progress" ? C.brand : C.muted }]}>
                    {CS_LABEL[o.status] || o.status}</Text>
                </View>
              </View>
            )) : <Text style={s.cardMeta}>Nothing assigned.</Text>}
          </View>

          <View style={s.card}>
            <View style={s.cardTop}><Text style={s.cardTitle}>My vehicles</Text></View>

            {editing ? (
              <VehicleForm value={editing} busy={busy}
                           onCancel={() => setEditing(null)} onSave={save} />
            ) : (
              <>
                {cars.length ? cars.map(v => (
                  <View key={v.id} style={s.detailRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.detailTitle}>
                        {[v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}</Text>
                      <Text style={s.cardMeta}>
                        {[v.color, v.plate ? `Plate ${v.plate}` : "", v.state]
                          .filter(Boolean).join(" · ") || "No details"}</Text>
                    </View>
                    <Pressable onPress={() => setEditing(v)} hitSlop={8}>
                      <Text style={s.linkText}>Edit</Text></Pressable>
                    <Pressable onPress={() => remove(v)} hitSlop={8}>
                      <Text style={[s.linkText, { color: C.muted, marginLeft: 14 }]}>Remove</Text></Pressable>
                  </View>
                )) : <Text style={s.cardMeta}>None on record.</Text>}

                <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                           onPress={() => setEditing({})}>
                  <Text style={s.ctaText}>Add a vehicle</Text>
                </Pressable>
              </>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

/* ================================================================
   Family contacts

   The one module both sides maintain, so there is ONE card component and the
   officer and the subject both render it. Two copies would drift, and the
   drift would be two people disagreeing about the same person's phone number.
================================================================ */
/* ================================================================
   Shared form pieces

   Both of these MUST live at module scope. A component declared inside
   another is a new component type on every render, so React unmounts and
   remounts it — which is why the vehicle Year field lost focus after each
   character. It looked like an input bug; it was a component-identity bug.
================================================================ */

/** A tappable summary card that opens an editor. */
function Row({ title, value, onPress, chip, chipOk }) {
  return (
    <Pressable style={({ pressed }) => [s.card, pressed && s.cardPressed]} onPress={onPress}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle}>{title}</Text>
        {chip ? (
          <View style={[s.pill, chipOk ? s.pillNeutral : s.pillMuted]}>
            <Text style={[s.pillText, { color: chipOk ? C.brand : C.muted }]}>{chip}</Text>
          </View>
        ) : null}
      </View>
      <Text style={s.cardMeta}>{value}</Text>
      <Text style={[s.linkText, { marginTop: 10 }]}>Edit</Text>
    </Pressable>
  );
}

/** One label/value pair on the agreement. */
function Fact({ label, value }) {
  return (
    <View style={s.agFact}>
      <Text style={s.agFactLabel}>{label}</Text>
      <Text style={s.agFactValue}>{value || "\u2014"}</Text>
    </View>
  );
}

/** A labelled text input. */
function Field({ label, value, onChange, style, ...rest }) {
  return (
    <View style={[{ flex: 1 }, style]}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChange}
                 placeholderTextColor={C.faint} {...rest} />
    </View>
  );
}

/** A field that opens a list. React Native has no native select, and a chip
 *  row stops working past a handful of options. */
function PickerField({ label, value, options, onChange, placeholder = "Choose…", style }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[{ flex: 1 }, style]}>
      <Text style={s.label}>{label}</Text>
      <Pressable style={s.input} onPress={() => setOpen(true)}>
        <Text numberOfLines={1} style={{ fontSize: 16, color: value ? C.ink : C.faint }}>
          {value || placeholder}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent
             onRequestClose={() => setOpen(false)}>
        <View style={s.sheetWrap}>
          <Pressable style={s.sheetScrim} onPress={() => setOpen(false)} />
          <View style={[s.sheet, { maxHeight: "72%" }]}>
            <Text style={s.sheetTitle}>{label}</Text>
            <ScrollView>
              {options.map(o => (
                <Pressable key={o} style={s.pickRow}
                           onPress={() => { onChange(o); setOpen(false); }}>
                  <Text style={[s.pickText, o === value && s.pickTextOn]}>{o}</Text>
                  {o === value ? <Text style={s.pickTick}>✓</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* The makes that actually turn up on a caseload, plus an escape hatch. A list
   that cannot express someone's car is worse than a free-text box. */
const CAR_MAKES = [
  "Acura","Audi","BMW","Buick","Cadillac","Chevrolet","Chrysler","Dodge","Ford","GMC",
  "Honda","Hyundai","Infiniti","Jeep","Kia","Land Rover","Lexus","Lincoln","Mazda",
  "Mercedes-Benz","Mercury","Mini","Mitsubishi","Nissan","Pontiac","Ram","Saturn",
  "Subaru","Tesla","Toyota","Volkswagen","Volvo","Other"
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY"
];

const RELATIONSHIPS = [
  "Mother","Father","Stepmother","Stepfather","Guardian",
  "Spouse","Partner","Girlfriend","Boyfriend","Fiancé(e)","Ex-spouse",
  "Son","Daughter","Brother","Sister",
  "Grandmother","Grandfather","Aunt","Uncle","Cousin","Nephew","Niece",
  "In-law","Friend","Neighbor","Roommate","Clergy","Sponsor","Other"
];

/** The subject's own employment. Reported by them, verified by their officer —
 *  so they maintain it here and the officer sees who changed it last. */
function EmploymentCard({ value, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const emp = value || {};

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle}>Employment</Text>
        <View style={[s.pill, emp.status && emp.status !== "not_employed"
                     ? s.pillNeutral : s.pillMuted]}>
          <Text style={[s.pillText, { color: emp.status && emp.status !== "not_employed"
                        ? C.brand : C.muted }]}>
            {EMPLOY_LABEL[emp.status || "not_employed"]}</Text>
        </View>
      </View>

      {/* The editor is a separate component so it mounts fresh from the
          current record each time. A draft held here would be initialised once
          and go stale the moment the officer changed anything. */}
      {editing ? (
        <EmploymentEditor value={emp} busy={busy}
                          onCancel={() => setEditing(false)}
                          onSave={v => onSave(v, () => setEditing(false))} />
      ) : (
        <>
          {emp.status === "employed" ? (
            <>
              <Text style={s.bigTime}>{emp.company_name}</Text>
              {emp.address ? <Text style={s.cardMeta}>{emp.address}</Text> : null}
              {(emp.phone || emp.supervisor) ? (
                <Text style={s.cardMeta}>
                  {[emp.supervisor ? `Supervisor ${emp.supervisor}` : "", emp.phone]
                    .filter(Boolean).join("  ·  ")}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={s.cardMeta}>
              {emp.status === "self_employed"
                ? "You are recorded as self-employed."
                : "No employment on record."}
            </Text>
          )}
          {emp.notes ? <Text style={s.noteLine}>{emp.notes}</Text> : null}
          <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
            Your agreement requires you to report a change within 72 hours.
          </Text>
          <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                     onPress={() => setEditing(true)}>
            <Text style={s.ctaText}>Update my employment</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function EmploymentEditor({ value, busy, onCancel, onSave }) {
  const d = useEmploymentDraft(value);
  return (
    <View style={{ marginTop: 4 }}>
      <EmploymentFields d={d} youWording />
      <View style={s.rowBtns}>
        <Pressable style={s.btnGhost} onPress={onCancel}>
          <Text style={s.btnGhostText}>Cancel</Text></Pressable>
        <Pressable style={[s.btnSolid, (!d.ready || busy) && { opacity: 0.5 }]}
                   disabled={!d.ready || busy} onPress={() => onSave(d.payload)}>
          <Text style={s.btnSolidText}>{busy ? "Saving…" : "Save"}</Text></Pressable>
      </View>
    </View>
  );
}

/**
 * `bare` drops the card chrome and the heading, for when this is already
 * inside a Section that provides both. One component either way — the
 * alternative is a second contacts list to keep in step with this one.
 */
function ContactsCard({ contacts, onSave, onRemove, busy, theirName, bare }) {
  const [editing, setEditing] = useState(null);   // {} for new, {…} for existing

  const confirmRemove = c => Alert.alert("Remove this contact?",
    `${c.name} (${c.relationship}) will be removed from the record.`,
    [{ text: "Cancel", style: "cancel" },
     { text: "Remove", style: "destructive", onPress: () => onRemove(c) }]);

  return (
    <View style={bare ? null : s.card}>
      {bare ? null : (
        <View style={s.cardTop}>
          <Text style={s.cardTitle}>Family &amp; contacts</Text>
          {contacts.length > 0 && (
            <View style={[s.pill, s.pillMuted]}>
              <Text style={[s.pillText, { color: C.muted }]}>{contacts.length}</Text>
            </View>
          )}
        </View>
      )}

      {editing ? (
        <ContactForm value={editing} busy={busy}
                     onCancel={() => setEditing(null)}
                     onSave={v => onSave(v, () => setEditing(null))} />
      ) : (
        <>
          {contacts.length ? contacts.map(c => (
            <View key={c.id} style={s.detailRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.detailTitle}>{c.name}</Text>
                <Text style={s.cardMeta}>
                  {c.relationship}
                  {"  ·  "}
                  <Text style={s.linkText} onPress={() => Linking.openURL(
                    `tel:${String(c.phone).replace(/[^\d+]/g, "")}`)}>{c.phone}</Text>
                </Text>
                {/* Provenance, so an officer can see what the subject supplied
                    without the list being split in two. */}
                {theirName && c.added_by === "subject" ? (
                  <Text style={[s.cardMeta, { color: C.brand }]}>
                    Added by {theirName}</Text>
                ) : null}
              </View>
              <Pressable onPress={() => setEditing(c)} hitSlop={8}>
                <Text style={s.linkText}>Edit</Text></Pressable>
              <Pressable onPress={() => confirmRemove(c)} hitSlop={8}>
                <Text style={[s.linkText, { color: C.muted, marginLeft: 14 }]}>Remove</Text></Pressable>
            </View>
          )) : <Text style={s.cardMeta}>None on record.</Text>}

          <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                     onPress={() => setEditing({})}>
            <Text style={s.ctaText}>Add a contact</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function ContactForm({ value, busy, onCancel, onSave }) {
  const [name, setName] = useState(value.name || "");
  const [relationship, setRelationship] = useState(value.relationship || "");
  const [phone, setPhone] = useState(value.phone || "");
  const ready = name.trim() && relationship && phone.trim();

  return (
    <View style={{ marginTop: 4 }}>
      <Field label="Name" value={name} onChange={setName}
             placeholder="e.g. Bob Smith" autoCapitalize="words" />

      <View style={s.fieldRow}>
        <PickerField label="Relationship" value={relationship}
                     options={RELATIONSHIPS} onChange={setRelationship} />
        <Field label="Phone number" value={phone} onChange={setPhone}
               placeholder="333-222-1111" keyboardType="phone-pad" />
      </View>

      <View style={s.rowBtns}>
        <Pressable style={s.btnGhost} onPress={onCancel}>
          <Text style={s.btnGhostText}>Cancel</Text></Pressable>
        <Pressable style={[s.btnSolid, (!ready || busy) && { opacity: 0.5 }]}
                   disabled={!ready || busy}
                   onPress={() => onSave({ id: value.id, name: name.trim(),
                                           relationship, phone: phone.trim() })}>
          <Text style={s.btnSolidText}>
            {busy ? "Saving…" : value.id ? "Save changes" : "Add contact"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function VehicleForm({ value, busy, onCancel, onSave }) {
  const [f, setF] = useState({
    year: value.year || "", make: value.make || "", model: value.model || "",
    color: value.color || "", plate: value.plate || "", state: value.state || ""
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  // "Other" means the list could not name it, so a box appears to type it in.
  const listedMake = CAR_MAKES.includes(f.make);
  const [otherMake, setOtherMake] = useState(f.make && !listedMake);

  return (
    <View style={{ marginTop: 4 }}>
      <View style={s.fieldRow}>
        <Field label="Year" value={f.year} onChange={t => set("year", t.replace(/\D/g, ""))}
               placeholder="2019" keyboardType="number-pad" maxLength={4} />
        {otherMake ? (
          <Field label="Make" value={f.make} onChange={t => set("make", t)}
                 placeholder="Make" autoCapitalize="words" autoFocus />
        ) : (
          <PickerField label="Make" value={f.make} options={CAR_MAKES}
                       onChange={v => {
                         if (v === "Other") { setOtherMake(true); set("make", ""); }
                         else set("make", v);
                       }} />
        )}
      </View>
      {otherMake && (
        <Pressable onPress={() => { setOtherMake(false); set("make", ""); }} hitSlop={8}>
          <Text style={[s.linkText, { marginBottom: 10 }]}>Choose from the list instead</Text>
        </Pressable>
      )}

      <View style={s.fieldRow}>
        <Field label="Model" value={f.model} onChange={t => set("model", t)}
               placeholder="Corolla" autoCapitalize="words" />
        <Field label="Color" value={f.color} onChange={t => set("color", t)}
               placeholder="Silver" autoCapitalize="words" />
      </View>

      <View style={s.fieldRow}>
        <Field label="License plate" value={f.plate}
               onChange={t => set("plate", t.toUpperCase())}
               placeholder="ABC-1234" autoCapitalize="characters" autoCorrect={false} />
        <PickerField label="State" value={f.state} options={US_STATES}
                     onChange={v => set("state", v)} placeholder="State" />
      </View>

      <View style={s.rowBtns}>
        <Pressable style={s.btnGhost} onPress={onCancel}>
          <Text style={s.btnGhostText}>Cancel</Text></Pressable>
        <Pressable style={[s.btnSolid, busy && { opacity: 0.6 }]} disabled={busy}
                   onPress={() => onSave({ ...f, id: value.id })}>
          <Text style={s.btnSolidText}>{busy ? "Saving…" : value.id ? "Save changes" : "Add vehicle"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ================================================================
   Visits
================================================================ */
/* ================================================================
   Goals — the subject's side.

   They tick off the action steps, because they are the ones doing them. They
   do not close the goal: ten resumes submitted is not a job, and only the
   officer can say the goal is met. The screen says so rather than leaving
   somebody wondering why a fully-ticked goal is still open.
================================================================ */
const GOAL_STATE = {
  not_started:      "Not started",
  in_progress:      "In progress",
  awaiting_officer: "With your officer",
  overdue:          "Overdue",
  complete:         "Complete",
  cancelled:        "Cancelled"
};

function GoalList({ auth, caseData, onRefresh }) {
  const pull = usePullToRefresh(onRefresh);
  const [busy, setBusy] = useState(null);
  /* What they agreed to out loud at a visit. Kept on this tab rather than
     given its own: this is the "what am I working on" screen, and a commitment
     from Tuesday belongs beside the goals it usually serves. */
  const actions = caseData?.actions || [];
  const goals = caseData?.goals || [];
  const open = goals.filter(g => g.status === "open");
  const closed = goals.filter(g => g.status !== "open");

  /* Reporting, not deciding. The subject says they have done it and the record
     says who said so — the same shape as ticking a goal step. A list only the
     officer can close is a list the subject is merely watched against, which is
     the opposite of what this product argues. */
  const reportDone = async a => {
    setBusy(`a${a.id}`);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/actions/done`, auth.token, {
        method: "POST", body: JSON.stringify({ id: a.id }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't update that");
      await onRefresh();
      toast("Reported as done");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(null); }
  };

  const toggle = async st => {
    setBusy(st.id);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/goals/step`, auth.token, {
        method: "POST", body: JSON.stringify({ id: st.id, done: !st.done_at }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't update that step");
      await onRefresh();
      toast(st.done_at ? "Step reopened" : "Step marked done");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(null); }
  };

  const card = g => {
    const p = g.progress || { done: 0, total: 0, percent: 0 };
    const late = goalOverdue(g);
    const closedGoal = g.status !== "open";
    const tone = closedGoal ? "ok" : late ? "err" : p.done ? "brand" : "amber";
    const chipStyle = { ok: s.pillOk, err: s.pillErr, brand: s.pillNeutral,
                        amber: s.pillWarn }[tone];
    const ink = { ok: C.ok, err: C.err, brand: C.brand, amber: C.amber }[tone];
    return (
      <View key={g.id} style={[s.card, closedGoal && { opacity: 0.7 }]}>
        <View style={s.cardTop}>
          <Text style={[s.cardTitle, { flex: 1 }]}>{g.title}</Text>
          <View style={[s.pill, chipStyle]}>
            <Text style={[s.pillText, { color: ink }]}>{GOAL_STATE[g.state] || ""}</Text>
          </View>
        </View>

        {g.detail ? <Text style={s.cardMeta}>{g.detail}</Text> : null}
        <Text style={[s.cardMeta, late && { color: C.err, fontWeight: "700" }]}>
          {g.due_date ? `${late ? "Was due" : "Due"} ${asDate(g.due_date)}` : "No due date"}
          {p.total ? ` · ${p.done} of ${p.total} steps` : ""}
        </Text>

        {p.total ? (
          <View style={s.goalBar}>
            <View style={[s.goalBarFill, { width: `${p.percent}%` }]} />
          </View>
        ) : null}

        {(g.steps || []).map(st => (
          <Pressable key={st.id} style={s.goalStep}
                     disabled={closedGoal || busy === st.id}
                     onPress={() => toggle(st)}>
            <View style={[s.goalTick, st.done_at && s.goalTickOn,
                          closedGoal && { opacity: 0.6 }]}>
              {st.done_at ? <Text style={s.goalTickMark}>✓</Text> : null}
            </View>
            <Text style={[s.goalStepText, st.done_at && s.goalStepDone]}>{st.body}</Text>
          </Pressable>
        ))}

        {/* A fully-ticked goal that is still open is not a bug, and saying so
            is cheaper than letting somebody wonder. */}
        {!closedGoal && p.total > 0 && p.done === p.total ? (
          <Text style={s.goalNote}>
            Everything here is done. Your officer closes the goal.
          </Text>
        ) : null}
        {closedGoal && g.completed_at ? (
          <Text style={s.goalNote}>
            Closed by {g.completed_by || "your officer"} on {asDate(g.completed_at.slice(0, 10))}.
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView contentContainerStyle={s.listBody} refreshControl={pull}>
      {!caseData && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

      {/* First on the screen, above the goals: these were said out loud a few
          days ago and have dates on them. A goal is months of work; this is
          what is owed this week. */}
      {actions.length ? (
        <View style={s.card}>
          <View style={s.cardTop}>
            <Text style={s.cardTitle}>What you agreed to</Text>
            <View style={[s.pill, actions.some(overdueAction) ? s.pillErr : s.pillNeutral]}>
              <Text style={[s.pillText, { color: actions.some(overdueAction)
                            ? C.err : C.brand }]}>{actions.length}</Text>
            </View>
          </View>
          {actions.map((a, i) => (
            <Pressable key={a.id}
                       style={({ pressed }) => [s.actRow, i === 0 && s.actRowFirst,
                                                pressed && { opacity: .55 }]}
                       disabled={busy === `a${a.id}`}
                       onPress={() => reportDone(a)}>
              <View style={[s.goalTick, busy === `a${a.id}` && { opacity: .4 }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.actBody}>{a.body}</Text>
                <View style={s.actMeta}>
                  <Text style={[s.actDue, overdueAction(a) && s.actDueLate]}>
                    {a.due_date ? asDate(a.due_date) : "No date"}
                  </Text>
                  {a.due_hint
                    ? <Text style={s.actSaid} numberOfLines={1}>you said “{a.due_hint}”</Text>
                    : null}
                </View>
              </View>
            </Pressable>
          ))}
          <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
            These came out of your visits. Tap one once you have done it — your
            officer sees that you reported it.
          </Text>
        </View>
      ) : null}

      {caseData && !goals.length && !actions.length && (
        <View style={s.center}><Text style={s.muted}>No goals yet.</Text></View>
      )}
      {open.map(card)}
      {closed.length ? <Text style={s.dayHeading}>Completed</Text> : null}
      {closed.map(card)}
    </ScrollView>
  );
}

/* ================================================================
   Financial balance — the subject's side.

   They can see what they owe and record a payment they made, because they
   paid at an office and are entering the transaction. They cannot change what
   they owe: that is imposed by a court, and there is no route here for it.
================================================================ */
function FinanceCard({ auth, caseData, onRefresh }) {
  const fin = caseData?.financial;
  const [paying, setPaying] = useState(null);   // item id
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);

  if (!fin || !fin.items.length) return null;
  const t = fin.totals;

  const submit = async item => {
    if (!amount.trim()) return toast("Enter the amount you paid.", "err");
    setBusy(true);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/financial/payment`, auth.token, {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, amount: amount.trim(),
                               method: method.trim() || null }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't record that payment");
      await onRefresh();
      toast(`Payment of ${money(d.item.payments.at(-1).amount_cents)} recorded`);
      setPaying(null); setAmount(""); setMethod("");
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(false); }
  };

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle}>Financial balance</Text>
        <View style={[s.pill, t.overdue_cents ? s.pillErr
                     : t.balance_cents ? s.pillWarn : s.pillOk]}>
          <Text style={[s.pillText, { color: t.overdue_cents ? C.err
                        : t.balance_cents ? C.amber : C.ok }]}>
            {t.balance_cents ? money(t.balance_cents) + " due" : "Settled"}</Text>
        </View>
      </View>

      <Text style={s.bigTime}>{money(t.balance_cents)}</Text>
      <Text style={s.cardMeta}>
        {money(t.paid_cents)} paid of {money(t.owed_cents)}
        {t.overdue_cents ? ` · ${money(t.overdue_cents)} overdue` : ""}
        {t.next_due ? ` · next due ${asDate(t.next_due)}` : ""}
      </Text>

      {fin.items.map(i => {
        const settled = i.balance_cents === 0;
        return (
          <View key={i.id} style={s.detailRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.detailTitle}>
                {FIN_KIND[i.kind] || i.kind} — {money(i.amount_cents)}</Text>
              {i.description ? <Text style={s.cardMeta}>{i.description}</Text> : null}
              <Text style={[s.cardMeta, i.state === "overdue" && { color: C.err,
                            fontWeight: "700" }]}>
                {i.due_date
                  ? `${i.state === "overdue" ? "Was due" : "Due"} ${asDate(i.due_date)}`
                  : "No due date"}
                {i.paid_cents ? ` · ${money(i.paid_cents)} paid` : ""}
              </Text>

              {/* Their own payment history, so "I paid that" is answerable
                  without ringing the office. */}
              {(i.payments || []).map(pmt => (
                <Text key={pmt.id} style={s.finPayLine}>
                  {asDate(pmt.paid_on)} · {money(pmt.amount_cents)}
                  {pmt.method ? ` · ${pmt.method}` : ""}
                  {pmt.recorded_role === "subject" ? " · recorded by you" : ""}
                </Text>
              ))}

              {!settled && paying === i.id ? (
                <View style={{ marginTop: 10 }}>
                  <TextInput style={s.input} value={amount} onChangeText={setAmount}
                             keyboardType="decimal-pad" placeholder="Amount you paid"
                             placeholderTextColor={C.faint} />
                  <TextInput style={s.input} value={method} onChangeText={setMethod}
                             placeholder="How you paid — e.g. money order"
                             placeholderTextColor={C.faint} />
                  <View style={s.rowBtns}>
                    <Pressable style={s.btnGhost} onPress={() => setPaying(null)}>
                      <Text style={s.btnGhostText}>Cancel</Text>
                    </Pressable>
                    <Pressable style={[s.btnSolid, busy && { opacity: .5 }]}
                               disabled={busy} onPress={() => submit(i)}>
                      <Text style={s.btnSolidText}>
                        {busy ? "Recording…" : "Record payment"}</Text>
                    </Pressable>
                  </View>
                  <Text style={s.finNote}>
                    Recording a payment you made at an office. Your officer sees it
                    on the case file.
                  </Text>
                </View>
              ) : null}
            </View>

            {!settled && paying !== i.id ? (
              <Pressable onPress={() => { setPaying(i.id); setAmount(""); setMethod(""); }}>
                <Text style={s.detailAction}>Pay</Text>
              </Pressable>
            ) : (
              <View style={[s.pill, settled ? s.pillOk : s.pillMuted]}>
                <Text style={[s.pillText, { color: settled ? C.ok : C.muted }]}>
                  {FIN_STATE[i.state] || ""}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/* ================================================================
   Important dates — the subject's side.

   They confirm they will be there, and afterwards say whether they made it.
   They cannot move one: a court date is not something a subject reschedules,
   and there is no route for it.
================================================================ */
function DatesCard({ auth, caseData, onRefresh, onOpenMaps }) {
  const dates = caseData?.important_dates || [];
  const [busy, setBusy] = useState(null);
  const reported = useRef(new Set());

  /* Tell the SaaS which appointments have actually been drawn for them.
     Reported once each, in one call, and only for the ones the server still
     has as unseen — so this is a single request the first time a new
     appointment appears and nothing at all afterwards. */
  useEffect(() => {
    const fresh = dates
      .filter(d => d.status === "scheduled" && !d.seen_at && !reported.current.has(d.id))
      .map(d => d.id);
    if (!fresh.length) return;
    fresh.forEach(id => reported.current.add(id));
    authed(`${SAAS_BASE}/api/me/important-dates/seen`, auth.token,
      { method: "POST", body: JSON.stringify({ ids: fresh }) })
      // A failed report is not worth interrupting anybody: it retries the
      // next time the screen mounts, and nothing the subject can do is
      // blocked by it.
      .then(() => onRefresh())
      .catch(() => {});
  }, [dates, auth, onRefresh]);

  if (!dates.length) return null;

  const open = dates.filter(d => d.status === "scheduled");
  const past = dates.filter(d => d.status !== "scheduled");

  const call = async (path, body, okMsg, id) => {
    setBusy(id);
    try {
      const r = await authed(`${SAAS_BASE}${path}`, auth.token,
        { method: "POST", body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Couldn't record that");
      await onRefresh();
      toast(okMsg);
    } catch (e) { toast(String(e.message || e), "err"); }
    finally { setBusy(null); }
  };

  const reportOutcome = d => Alert.alert(
    "Did you attend?", d.title || d.kind_label,
    [{ text: "Cancel", style: "cancel" },
     { text: "I missed it", style: "destructive",
       onPress: () => call("/api/me/important-dates/close",
         { id: d.id, status: "missed" }, "Recorded as missed", d.id) },
     { text: "I attended",
       onPress: () => call("/api/me/important-dates/close",
         { id: d.id, status: "completed" }, "Recorded as attended", d.id) }]);

  const row = d => {
    const needsAck = d.state === "assigned" || d.state === "viewed";
    const needsOutcome = !!d.awaiting_outcome;
    return (
      <View key={d.id} style={[s.detailRow, d.status !== "scheduled" && { opacity: 0.7 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.dateWhen, (needsAck || needsOutcome) && { color: C.err }]}>
            {needsAck ? "● " : ""}{fmtVisit(d.scheduled_at)}
          </Text>
          <Text style={s.detailTitle}>{d.title || d.kind_label}</Text>
          {d.title ? <Text style={s.cardMeta}>{d.kind_label}</Text> : null}
          {d.location ? <Text style={s.cardMeta}>{d.location}</Text> : null}
          {d.address ? (
            <Pressable onPress={() => onOpenMaps(d.address)}>
              <Text style={[s.cardAddr, { color: C.brand }]}>{d.address}</Text>
            </Pressable>
          ) : null}
          {d.detail ? <Text style={s.noteLine}>{d.detail}</Text> : null}

          {needsAck ? (
            <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark },
                              busy === d.id && { opacity: .5 }]}
                       disabled={busy === d.id}
                       onPress={() => call("/api/me/important-dates/acknowledge",
                         { id: d.id }, "Confirmed — your officer can see it", d.id)}>
              <Text style={s.ctaText}>
                {busy === d.id ? "Confirming…" : "I will be there"}</Text>
            </Pressable>
          ) : needsOutcome ? (
            <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                       disabled={busy === d.id} onPress={() => reportOutcome(d)}>
              <Text style={s.ctaText}>
                {busy === d.id ? "Recording…" : "Did you attend?"}</Text>
            </Pressable>
          ) : d.status === "scheduled" ? (
            <Text style={s.stampLine}>You confirmed {asDateTime(d.acknowledged_at)}</Text>
          ) : (
            <Text style={s.stampLine}>
              {DATE_STATE[d.state]}
              {d.completed_role ? ` — recorded by the ${d.completed_role}` : ""}
            </Text>
          )}
        </View>
        <View style={[s.pill, datePill(d.state, d.awaiting_outcome)]}>
          <Text style={[s.pillText, { color: dateInk(d.state, d.awaiting_outcome) }]}>
            {DATE_STATE[d.state] || ""}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle}>Important dates</Text>
        {open.length ? (
          <View style={[s.pill, s.pillNeutral]}>
            <Text style={[s.pillText, { color: C.brand }]}>{open.length} upcoming</Text>
          </View>
        ) : null}
      </View>
      <Text style={s.cardMeta}>
        Hearings and appointments you have to attend. Confirm each one, then
        tell us how it went.
      </Text>
      {open.map(row)}
      {past.length ? <Text style={s.datePast}>Past</Text> : null}
      {past.map(row)}
    </View>
  );
}

function VisitList({ auth, caseData, onRefresh }) {
  const pull = usePullToRefresh(onRefresh);
  const allVisits = (caseData?.visits || []).filter(v => v.status !== "cancelled");
  const pending = allVisits.find(v => v.status === "requested");

  /* What is coming up, soonest first — then what has already happened, most
     recent first. The server returns them in one chronological run, which put
     a visit from three months ago above the one on Thursday. That order is
     right for the officer's timeline in the console and wrong here: a subject
     opens this to find out when they next have to be somewhere. */
  const visits = allVisits
    .filter(v => v.status !== "requested")
    .sort((a, b) => {
      const doneA = a.status === "completed", doneB = b.status === "completed";
      if (doneA !== doneB) return doneA ? 1 : -1;
      const ta = new Date(a.scheduled_at || 0), tb = new Date(b.scheduled_at || 0);
      return doneA ? tb - ta : ta - tb;
    });
  const [requesting, setRequesting] = useState(false);

  /* The subject asks; the officer picks the date. */
  const requestVisit = () => {
    Alert.prompt?.("Request an appointment",
      "What do you need to see your officer about? (optional)",
      [{ text: "Cancel", style: "cancel" },
       { text: "Send request", onPress: async note => {
           setRequesting(true);
           try {
             const r = await authed(`${SAAS_BASE}/api/me/visits/request`, auth.token,
               { method: "POST", body: JSON.stringify({ note: note || null }) });
             if (!r.ok) throw new Error((await r.json()).error || "Could not send");
             await onRefresh();
             toast("Request sent to your officer");
           } catch (e) { toast(String(e.message || e), "err"); }
           finally { setRequesting(false); }
         } }]);
  };
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(null);
  const refresh = async () => { setBusy(true); await onRefresh(); setBusy(false); };

  const accept = async id => {
    setAccepting(id);
    try {
      const r = await authed(`${SAAS_BASE}/api/me/visits/accept`, auth.token, {
        method: "POST", body: JSON.stringify({ id }) });
      if (!r.ok) throw new Error((await r.json()).error || "Could not confirm");
      await onRefresh();
      toast("Appointment confirmed");
    } catch (e) {
      toast(String(e.message || e), "err");
    } finally { setAccepting(null); }
  };

  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={pull}>
      {!caseData && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

      {caseData && (pending ? (
        <View style={[s.card, { alignItems: "center" }]}>
          <Text style={{ fontWeight: "700", fontSize: 15.5, color: C.ink }}>Request sent</Text>
          <Text style={[s.cardMeta, { textAlign: "center", marginTop: 4 }]}>
            Your officer will confirm a date shortly.</Text>
        </View>
      ) : (
        <Pressable style={({ pressed }) => [s.cta, { marginTop: 0, marginBottom: 4 },
                                            pressed && { backgroundColor: C.brandDark }]}
                   onPress={requestVisit} disabled={requesting}>
          <Text style={s.ctaText}>
            {requesting ? "Sending…" : "Request an appointment"}</Text>
        </Pressable>
      ))}
      {caseData && visits.length === 0 && (
        <View style={s.center}><Text style={s.muted}>No visits scheduled.</Text></View>
      )}
      {visits.map((v, i) => {
        /* Where the upcoming run ends and the history begins. Without it the
           reordering just looks arbitrary — a heading is what turns a sorted
           list into two lists. */
        const firstDone = v.status === "completed" &&
                          (i === 0 || visits[i - 1].status !== "completed");
        const done = v.status === "completed";
        const accepted = !!v.accepted_at;
        return (
          <View key={v.id}>
            {firstDone ? <Text style={s.dayHeading}>Past visits</Text> : null}
            <View style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>
                {v.time_fixed ? fmtVisit(v.scheduled_at)
                              : `${fmtVisit(v.scheduled_at).split(",").slice(0, 2).join(",")} — any time`}
              </Text>
              <View style={[s.pill, (done || accepted) ? s.pillOk : s.pillNeutral]}>
                <Text style={[s.pillText, { color: (done || accepted) ? C.ok : C.brand }]}>
                  {done ? "Completed" : accepted ? "Accepted" : "Confirm"}
                </Text>
              </View>
            </View>
            {v.officer ? <Text style={s.cardMeta}>Officer {v.officer}</Text> : null}
            {v.location ? <Text style={s.cardMeta}>{v.location}</Text> : null}
            {v.notes ? <Text style={s.noteLine}>{v.notes}</Text> : null}

            {done ? (
              <Text style={s.stampLine}>Recorded as completed {fmtVisit(v.completed_at)}</Text>
            ) : accepted ? (
              <Text style={s.stampLine}>You confirmed {fmtVisit(v.accepted_at)}</Text>
            ) : (
              <Pressable style={({ pressed }) => [s.cta, pressed && { backgroundColor: C.brandDark }]}
                         onPress={() => accept(v.id)} disabled={accepting === v.id}>
                <Text style={s.ctaText}>
                  {accepting === v.id ? "Confirming…" : "Accept this appointment"}</Text>
              </Pressable>
            )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/* A view of what Home fetched, not a second fetcher of the same thing. */
function ProgramList({ programs, error, onReload, onLaunch, onSignOut }) {
  const pull = usePullToRefresh(onReload);

  return (
      <ScrollView
        contentContainerStyle={s.listBody}
        refreshControl={pull}>

        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorTitle}>Can't load your programs</Text>
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}

        {!error && programs === null && (
          <View style={s.center}><ActivityIndicator color={C.brand} /></View>
        )}

        {programs?.length === 0 && (
          <View style={s.center}><Text style={s.muted}>Nothing assigned yet.</Text></View>
        )}

        {programs?.map(p => {
          const done = progDone(p);
          const passed = p.success_status === "passed";
          const failed = p.success_status === "failed";
          const started = progStarted(p);
          const suspended = progResumable(p);

          return (
            <Pressable
              key={p.program_id}
              style={({ pressed }) => [s.card, pressed && s.cardPressed]}
              onPress={() => onLaunch(p)}>

              <View style={s.cardTop}>
                <Text style={s.cardTitle} numberOfLines={2}>{p.title}</Text>
                <View style={[s.pill,
                  done ? s.pillOk : started ? s.pillNeutral : s.pillMuted]}>
                  <Text style={[s.pillText,
                    done ? { color: C.ok } : started ? { color: C.brand } : { color: C.muted }]}>
                    {done ? "Completed" : started ? "In progress" : "Not started"}
                  </Text>
                </View>
              </View>

              <Text style={s.cardMeta}>
                SCORM {p.scorm_version}
                {p.attempt ? `  ·  Attempt ${p.attempt}` : ""}
                {p.score_raw != null ? `  ·  Score ${p.score_raw}${p.score_max ? `/${p.score_max}` : ""}` : ""}
              </Text>

              {(passed || failed) && (
                <Text style={[s.resultLine, { color: passed ? C.ok : C.err }]}>
                  {passed ? "Passed" : "Not passed"}
                </Text>
              )}

              <View style={s.cta}>
                <Text style={s.ctaText}>
                  {done ? "Retake course" : suspended ? "Resume course"
                   : started ? "Continue" : "Start course"}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
  );
}

/* ================================================================
   Player
================================================================ */
function Player({ auth, program, onExit }) {
  const webRef = useRef(null);
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [ended, setEnded] = useState(false);
  const [result, setResult] = useState(null);   // native results screen
  const [leaving, setLeaving] = useState(false);

  /* Ask for a launch ticket, then open it. The ticket is short lived and
     single use — the app never holds a long-lived credential. */
  useEffect(() => {
    (async () => {
      try {
        const r = await authed(`${API_BASE}/api/me/launch`, auth.token, {
          method: "POST", body: JSON.stringify({ program_id: program.program_id })
        });
        const d = await r.json();
        if (!r.ok || !d.launch_url) throw new Error(d.error || `HTTP ${r.status}`);
        setUrl(d.launch_url);
      } catch (e) { setError(String(e.message || e)); }
    })();
  }, [program, auth]);

  const flush = useCallback(() => {
    // Every SetValue is already persisted server-side; this pushes the
    // elapsed time, which is what would otherwise be lost to a kill.
    webRef.current?.injectJavaScript("window.__waypointFlush && window.__waypointFlush(); true;");
  }, []);

  /* iOS and Android kill backgrounded apps without warning, so Terminate
     frequently never fires. Flush the moment we lose the foreground. */
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active") flush();
    });
    return () => sub.remove();
  }, [flush]);

  /* Ending a session is not the same as flushing. Without Terminate the
     server never closes the attempt and never reports it onward — which is
     exactly what "Save & Exit" is supposed to do. */
  const suspendAndExit = useCallback(() => {
    setLeaving(true);
    webRef.current?.injectJavaScript(
      "window.__waypointSuspendAndExit && window.__waypointSuspendAndExit(); true;");
    // Don't strand the learner if the course never answers.
    setTimeout(() => onExit(), 4000);
  }, [onExit]);

  const confirmExit = useCallback(() => {
    if (ended) return onExit();
    Alert.alert("Leave this course?", "Your progress is saved. You can pick up where you left off.",
      [{ text: "Stay", style: "cancel" },
       { text: "Save & Exit", onPress: suspendAndExit }]);
  }, [ended, suspendAndExit, onExit]);

  /* Android's hardware back must run the exit flow. Letting it unmount
     the WebView discards anything not yet written. */
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { confirmExit(); return true; });
    return () => sub.remove();
  }, [confirmExit]);

  const contentOrigin = url ? url.split("/player")[0] : "";

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <View style={s.mark}><Text style={s.markText}>W</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} numberOfLines={1}>{program.title}</Text>
          <Text style={s.headerSub}>{ended ? "Session complete" : "In progress · saved automatically"}</Text>
        </View>
      </View>

      <View style={s.stage}>
        {result ? (
          <ScrollView contentContainerStyle={s.resultWrap}>
            <View style={[s.resultIcon,
              result.reg?.success_status === "failed" ? { backgroundColor: C.errSoft } : null]}>
              <Text style={{ fontSize: 30 }}>
                {result.reg?.success_status === "failed" ? "✕"
                  : result.reg?.completion_status === "completed" ? "✓" : "⏱"}
              </Text>
            </View>

            <Text style={s.resultTitle}>
              {result.reg?.success_status === "passed" ? "Course passed"
                : result.reg?.success_status === "failed" ? "Course not passed"
                : result.reg?.completion_status === "completed" ? "Course completed"
                : "Progress saved"}
            </Text>
            <Text style={s.resultSub}>
              {result.reg?.success_status === "passed" ? "Nice work — your result has been recorded."
                : result.reg?.success_status === "failed" ? "You finished, but didn't reach the pass mark."
                : result.reg?.completion_status === "completed" ? "You've reached the end of this course."
                : "You can pick up where you left off next time."}
            </Text>

            <View style={s.resultTable}>
              {[
                ["Status", result.reg?.completion_status === "completed" ? "Completed" : "In progress"],
                ...(result.reg?.success_status && result.reg.success_status !== "unknown"
                    ? [["Result", result.reg.success_status === "passed" ? "Passed" : "Not passed"]] : []),
                ...(result.reg?.score_raw != null
                    ? [["Score", `${result.reg.score_raw}${result.reg.score_max ? ` / ${result.reg.score_max}` : ""}`]] : []),
                ["Time spent", fmtDur(result.reg?.total_seconds)],
                ["Attempt", String(result.reg?.attempt ?? "—")]
              ].map(([k, v]) => (
                <View key={k} style={s.resultRow}>
                  <Text style={s.resultKey}>{k}</Text>
                  <Text style={s.resultVal}>{v}</Text>
                </View>
              ))}
            </View>

            <Text style={s.resultNote}>
              {result.webhook?.delivered ? "Your result has been sent to your record."
                : result.webhook?.skipped ? "Saved. Reporting to the main system isn't configured here."
                : "Saved here, but the main system couldn't be notified yet — it will be retried."}
            </Text>
          </ScrollView>
        ) : error ? (
          <View style={s.center}>
            <Text style={s.errorTitle}>Couldn't start this course</Text>
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : !url ? (
          <View style={s.center}><ActivityIndicator color={C.brand} /></View>
        ) : (
          <WebView
            ref={webRef}
            source={{ uri: url }}
            style={s.web}
            startInLoadingState
            renderLoading={() => (
              <View style={[s.center, s.loadingOverlay]}><ActivityIndicator color={C.brand} /></View>
            )}

            /* --- containment -------------------------------------------
               Uploaded course code runs in here. It gets no filesystem
               access, no share of the app's cookies, and no route off the
               content origin. */
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            incognito={true}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            allowsBackForwardNavigationGestures={false}
            /* Matched against the ORIGIN only — a trailing path makes every
               URL fail the check, and react-native-webview then hands it to
               Linking, which opens the system browser. */
            originWhitelist={[contentOrigin]}
            onShouldStartLoadWithRequest={req => {
              // Keep the course inside its own package. Anything else is
              // a course trying to navigate away — refuse it.
              const allowed = req.url.startsWith(contentOrigin) || req.url === "about:blank";
              if (!allowed) console.warn("blocked navigation:", req.url);
              return allowed;
            }}

            /* --- messages from the player ------------------------------ */
            onMessage={e => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.type === "session_ended") {
                  setEnded(true);
                  if (leaving) return onExit();      // they asked to leave
                  setResult({ reg: msg.registration, webhook: msg.webhook });
                }
                // The player asks us to return the learner to their list.
                // Without this the "Done" button inside the WebView is dead —
                // there is no tab for it to close.
                if (msg.type === "exit") onExit();
              } catch {}
            }}

            javaScriptEnabled
            domStorageEnabled={false}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
          />
        )}
      </View>

      {/* Platform chrome below the content. The course's own buttons sit
          inside the white card; ours is unmistakably outside it. */}
      <View style={s.actionbar}>
        <Pressable
          style={({ pressed }) => [s.exitBtn, pressed && { backgroundColor: C.brandDark }]}
          onPress={confirmExit}>
          <Text style={s.exitText}>
            {leaving ? "Saving…" : ended ? "Done" : "Save & Exit"}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/* ================================================================ */
/* ================================================================
   Toast

   Every save needs to say so. A modal Alert for a routine success is too
   heavy — it interrupts and has to be dismissed — and the alternative used
   until now was nothing at all, which reads as "the button is broken".

   A module-level subscriber rather than context, so any component can
   confirm a save without threading a prop through four levels.
================================================================ */
let toastListener = null;
const toast = (message, kind = "ok") => toastListener?.({ message, kind });

/* Every server restart, password reset and demo reset invalidates the token
   this app is holding. Until now nothing noticed: `loadCase` kept whatever it
   had last fetched, so the screen went on showing records that no longer
   existed, and the next write failed with "sign in required" next to them.
   Data you cannot act on is worse than no data — a dead session ends. */
let expiredListener = null;
const sessionExpired = () => expiredListener?.();

/** Any call carrying a token. A 401 means the session is over; say so once
 *  and return to sign-in rather than leaving the screen lying. */
async function authed(url, token, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}),
               Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (r.status === 401) { sessionExpired(); throw new Error("Your session has expired."); }
  return r;
}

function ToastHost() {
  const [item, setItem] = useState(null);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef(null);

  useEffect(() => {
    toastListener = next => {
      clearTimeout(timer.current);
      setItem(next);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true })
          .start(() => setItem(null));
      }, next.kind === "err" ? 4200 : 2400);
    };
    return () => { toastListener = null; clearTimeout(timer.current); };
  }, [anim]);

  if (!item) return null;
  return (
    <Animated.View pointerEvents="none" style={[s.toast,
      item.kind === "err" && s.toastErr,
      item.kind === "warn" && s.toastWarn,
      { opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>
      <Text style={s.toastText}>{item.message}</Text>
    </Animated.View>
  );
}

export default function App() {
  const [auth, setAuth] = useState(null);      // { token, person }
  const [active, setActive] = useState(null);
  const [expired, setExpired] = useState(null);

  const signOut = useCallback(() => { setActive(null); setAuth(null); }, []);

  useEffect(() => {
    expiredListener = () => {
      setActive(null); setAuth(null);
      setExpired("Your session has expired. Please sign in again.");
    };
    return () => { expiredListener = null; };
  }, []);

  return (
    <>
      {/* Light on the subject's brand header, dark everywhere else. A black
          clock on a blue header is unreadable, and the officer's screens still
          have a pale bar at the top. */}
      <StatusBar
        barStyle={auth && auth.kind !== "officer" && !active ? "light-content" : "dark-content"}
        backgroundColor={auth && auth.kind !== "officer" && !active ? C.brand : C.surface} />
      {!auth
        ? <SignIn onSignedIn={a => { setExpired(null); setAuth(a); }} notice={expired} />
        : auth.kind === "officer"
        ? <OfficerHome auth={auth} onSignOut={signOut} />
        : active
        ? <Player auth={auth} program={active} onExit={() => setActive(null)} />
        : <Home auth={auth} onLaunch={setActive} onSignOut={signOut} />}
      <ToastHost />
    </>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  /* The subject's shell. Brand at the root so the safe-area strips at the notch
     and the home indicator are brand too; the page background lives in appBody
     between them. */
  safeBrand: { flex: 1, backgroundColor: C.brand },
  appBody: { flex: 1, backgroundColor: C.bg },

  toast: {
    position: "absolute", left: 20, right: 20, bottom: 44,
    backgroundColor: C.ink, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 18,
    shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 }, elevation: 8
  },
  pickRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.line
  },
  pickText: { flex: 1, fontSize: 16, color: C.ink },
  pickTextOn: { fontWeight: "700", color: C.brand },
  pickTick: { fontSize: 16, fontWeight: "800", color: C.brand },

  recCardOn: { borderColor: C.err, borderWidth: 2, backgroundColor: C.errSoft },
  recLive: { flexDirection: "row", alignItems: "center", gap: 7 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.err },
  recClock: { fontSize: 15, fontWeight: "700", color: C.err,
              fontVariant: ["tabular-nums"] },
  recBtn: { marginTop: 12, borderRadius: 10, paddingVertical: 13,
            alignItems: "center" },
  recBtnStart: { backgroundColor: C.err },
  recBtnStop: { backgroundColor: C.ink },
  recBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  recPlay: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.brandSoft,
             alignItems: "center", justifyContent: "center" },
  recPlayIcon: { color: C.brand, fontSize: 14, fontWeight: "700" },
  recPlayOn: { backgroundColor: C.brand },
  recPlayIconOn: { color: "#fff" },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  photoThumb: {
    width: 96, height: 96, borderRadius: 10,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.line
  },

  toastErr: { backgroundColor: C.err },
  toastWarn: { backgroundColor: C.amber },
  toastText: { color: "#fff", fontSize: 14.5, fontWeight: "600",
               textAlign: "center", lineHeight: 20 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line
  },
  mark: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: C.brand,
    alignItems: "center", justifyContent: "center"
  },
  markText: { color: "#fff", fontWeight: "800", fontSize: 17 },
  headerTitle: { fontSize: 16.5, fontWeight: "700", color: C.ink, letterSpacing: -0.2 },
  headerSub: { fontSize: 12.5, color: C.muted, marginTop: 1 },

  actionbar: {
    backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.line,
    paddingHorizontal: 16, paddingVertical: 12
  },
  exitBtn: {
    backgroundColor: C.brand, borderRadius: 12,
    paddingVertical: 16, alignItems: "center"
  },
  exitText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  signOut: { color: C.brand, fontSize: 14.5, fontWeight: "600" },

  profileBar: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line
  },
  profileBarBrand: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14,
    backgroundColor: C.brand
  },
  profileNameOn: { fontSize: 18, fontWeight: "700", color: "#fff", letterSpacing: -0.3 },
  profileMetaOn: { fontSize: 13, color: "rgba(255,255,255,0.78)", marginTop: 1 },
  signOutOn: { color: "#fff", fontSize: 14.5, fontWeight: "700" },
  profileName: { fontSize: 18, fontWeight: "700", color: C.ink, letterSpacing: -0.3 },
  profileMeta: { fontSize: 13, color: C.muted, marginTop: 1 },

  tabs: { flexDirection: "row", backgroundColor: C.surface,
          borderBottomWidth: 1, borderBottomColor: C.line },
  tab: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
         paddingVertical: 14, flex: 1, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: C.brand },
  tabText: { fontSize: 15, fontWeight: "600", color: C.muted },
  tabTextOn: { color: C.brand, fontWeight: "700" },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: C.err,
           alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },

  noteLine: { marginTop: 8, fontSize: 14, color: C.ink2, lineHeight: 20,
              backgroundColor: C.bg, padding: 10, borderRadius: 8 },
  stampLine: { marginTop: 12, fontSize: 13.5, color: C.ok, fontWeight: "600" },

  dayHeading: { fontSize: 13, fontWeight: "700", color: C.muted, textTransform: "uppercase",
                letterSpacing: 0.6, marginTop: 6, marginBottom: 10, marginLeft: 2 },
  visitTime: { flex: 1, fontSize: 20, fontWeight: "700", color: C.ink, letterSpacing: -0.4 },
  rowBtns: { flexDirection: "row", gap: 9, marginTop: 14, flexWrap: "wrap" },
  btnGhost: { paddingVertical: 10, paddingHorizontal: 15, borderRadius: 9,
              borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  btnGhostText: { color: C.ink2, fontWeight: "650", fontSize: 14 },
  btnSolid: { flex: 1, minWidth: 130, paddingVertical: 11, borderRadius: 9,
              backgroundColor: C.brand, alignItems: "center" },
  btnSolidText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  sheetWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  sheetScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: "rgba(15,23,42,0.45)" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
           padding: 22, paddingBottom: 34 },
  sheetTitle: { fontSize: 19, fontWeight: "700", color: C.ink, letterSpacing: -0.3 },
  sheetSub: { fontSize: 14, color: C.muted, marginTop: 3, marginBottom: 6 },
  sheetHint: { fontSize: 12.5, color: C.faint, marginTop: 10, lineHeight: 18 },
  textarea: { height: 110, paddingTop: 13 },
  bigTime: { fontSize: 24, fontWeight: "700", color: C.ink, letterSpacing: -0.5, marginTop: 8 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12,
               borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  detailTitle: { fontSize: 15, fontWeight: "650", color: C.ink },
  linkText: { color: C.brand, fontWeight: "650", fontSize: 14 },
  fieldRow: { flexDirection: "row", gap: 12 },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  choice: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 9,
            borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  choiceOn: { borderColor: C.brand, backgroundColor: C.brandSoft },
  choiceText: { fontSize: 14, fontWeight: "600", color: C.ink2 },
  choiceTextOn: { color: C.brand, fontWeight: "700" },

  signInWrap: { flexGrow: 1, justifyContent: "center", padding: 28, backgroundColor: C.bg },
  signInMark: {
    width: 56, height: 56, borderRadius: 16, backgroundColor: C.brand,
    alignItems: "center", justifyContent: "center", alignSelf: "center"
  },
  signInMarkText: { color: "#fff", fontWeight: "800", fontSize: 26 },
  signInTitle: { fontSize: 26, fontWeight: "700", color: C.ink, textAlign: "center",
                 marginTop: 16, letterSpacing: -0.5 },
  signInSub: { fontSize: 15, color: C.muted, textAlign: "center", marginTop: 4, marginBottom: 28 },
  signInError: {
    backgroundColor: C.errSoft, borderRadius: 10, padding: 13, marginBottom: 18,
    borderWidth: 1, borderColor: "#fecaca"
  },
  signInErrorText: { color: C.err, fontSize: 14, fontWeight: "600" },
  signInNotice: { backgroundColor: C.amberSoft, borderColor: C.amberLine },
  signInNoticeText: { color: C.amber },
  label: { fontSize: 13.5, fontWeight: "600", color: C.ink2, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 11,
    paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: C.ink
  },
  primaryBtn: {
    backgroundColor: C.brand, borderRadius: 12, paddingVertical: 16,
    alignItems: "center", marginTop: 26
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  listBody: { padding: 16, gap: 14 },
  card: {
    backgroundColor: C.surface, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: C.line,
    shadowColor: "#0f172a", shadowOpacity: 0.05, shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 }, elevation: 2
  },
  cardPressed: { backgroundColor: C.brandSoft, borderColor: C.brand },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: C.ink, letterSpacing: -0.3 },
  cardAddr: { fontSize: 13, color: C.muted, marginTop: 4, lineHeight: 18 },
  routeBar: { flexDirection: "row", alignItems: "center", gap: 11,
              backgroundColor: C.brandSoft, borderRadius: 12, padding: 13,
              marginBottom: 12 },
  routeIcon: { fontSize: 16, color: C.brand },
  routeText: { flex: 1, fontSize: 14.5, color: C.brand, fontWeight: "600" },
  routeGo: { fontSize: 14, fontWeight: "800", color: C.brand },
  agRow: { flexDirection: "row", gap: 11, alignItems: "flex-start", paddingVertical: 10,
           borderTopWidth: 1, borderTopColor: C.line, marginTop: 10 },
  agBody: { fontSize: 14.5, color: C.ink, fontWeight: "500", lineHeight: 20 },
  agBodyDone: { color: C.muted },
  agNote: { fontSize: 13, color: C.ink2, backgroundColor: C.bg, borderRadius: 8,
            padding: 8, marginTop: 6, lineHeight: 18 },
  agSrc: { fontSize: 10.5, fontWeight: "800", color: C.muted, letterSpacing: 0.5,
           textTransform: "uppercase", marginTop: 2 },
  dateWhen: { fontSize: 13, fontWeight: "700", color: C.brand,
              fontVariant: ["tabular-nums"] },
  datePast: { fontSize: 12.5, fontWeight: "700", color: C.muted, marginTop: 14,
              textTransform: "uppercase", letterSpacing: 0.6 },
  finPayLine: { fontSize: 12.5, color: C.muted, marginTop: 3,
                fontVariant: ["tabular-nums"] },
  finNote: { fontSize: 12.5, color: C.faint, marginTop: 8, lineHeight: 18 },

  /* goals */
  goalBar: { height: 5, borderRadius: 3, backgroundColor: C.line, marginTop: 11,
             overflow: "hidden" },
  goalBarFill: { height: "100%", backgroundColor: C.brand, borderRadius: 3 },
  goalStep: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 9 },
  goalTick: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
              borderColor: C.line, alignItems: "center", justifyContent: "center" },
  goalTickOn: { backgroundColor: C.ok, borderColor: C.ok },
  goalTickMark: { color: "#fff", fontSize: 13, fontWeight: "800" },
  goalStepText: { flex: 1, fontSize: 14.5, color: C.ink, lineHeight: 20 },
  goalStepDone: { color: C.muted, textDecorationLine: "line-through" },
  goalNote: { fontSize: 12.5, color: C.muted, marginTop: 10, lineHeight: 18 },

  /* a collapsible module of a case file */
  secHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  secChevron: { fontSize: 22, color: C.faint, fontWeight: "700", lineHeight: 22,
                width: 14, textAlign: "center" },
  secSummary: { fontSize: 13.5, color: C.muted, marginTop: 5, lineHeight: 19 },
  secBody: { marginTop: 12 },
  detailLabel: { fontSize: 11.5, fontWeight: "700", color: C.muted,
                 textTransform: "uppercase", letterSpacing: 0.5 },
  detailValue: { fontSize: 15, color: C.ink, marginTop: 2, lineHeight: 20 },
  detailAction: { fontSize: 13, fontWeight: "700", color: C.brand },

  /* reentry plan */
  reSummary: { alignItems: "center", paddingVertical: 18 },
  rePct: { fontSize: 46, fontWeight: "800", color: C.ink, letterSpacing: -2 },
  reSummaryLine: { fontSize: 14, color: C.muted, marginTop: 2 },
  reGate: { marginTop: 12, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999,
            backgroundColor: C.amberSoft },
  reGateOn: { backgroundColor: C.okSoft },
  reGateDone: { backgroundColor: C.brand },
  reGateText: { fontSize: 13, fontWeight: "700", color: C.amber, textAlign: "center" },
  reGateTextOn: { color: C.ok },
  reGateTextDone: { color: "#fff" },
  reTarget: { fontSize: 13, color: C.muted, marginTop: 10 },

  reAreaCard: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1,
                borderColor: C.line, padding: 16, marginBottom: 12 },
  reAreaTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
               gap: 10 },
  reAreaTitle: { fontSize: 16, fontWeight: "700", color: C.ink, flex: 1 },
  reAreaDesc: { fontSize: 12.5, color: C.muted, lineHeight: 18, marginTop: 4,
                marginBottom: 6 },
  reChip: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  reChipText: { fontSize: 11, fontWeight: "700" },
  reChip_ready: { backgroundColor: C.okSoft },
  reChipText_ready: { color: C.ok },
  reChip_in_progress: { backgroundColor: C.brandSoft },
  reChipText_in_progress: { color: C.brand },
  reChip_needs_attention: { backgroundColor: C.amberSoft },
  reChipText_needs_attention: { color: C.amber },
  reChip_at_risk: { backgroundColor: C.errSoft },
  reChipText_at_risk: { color: C.err },
  reChip_not_applicable: { backgroundColor: C.bg },
  reChipText_not_applicable: { color: C.muted },

  reRow: { flexDirection: "row", gap: 11, alignItems: "flex-start",
           paddingTop: 11, borderTopWidth: 1, borderTopColor: C.line, marginTop: 10 },
  reTick: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: C.line,
            alignItems: "center", justifyContent: "center", marginTop: 1 },
  reTickOn: { backgroundColor: C.ok, borderColor: C.ok },
  reTickMark: { color: "#fff", fontSize: 12, fontWeight: "800" },
  reRowLabel: { fontSize: 14.5, color: C.ink, fontWeight: "500", lineHeight: 20 },
  reRowDetail: { fontSize: 13, color: C.ink2, marginTop: 3, lineHeight: 18 },
  reRowMit: { fontSize: 12.5, color: C.amber, backgroundColor: C.amberSoft, marginTop: 6,
              padding: 8, borderRadius: 8, lineHeight: 18 },
  reRowStatus: { fontSize: 12.5, color: C.muted, marginTop: 3 },
  reSignBtn: { alignSelf: "flex-start", marginTop: 9, backgroundColor: C.brand,
               paddingVertical: 8, paddingHorizontal: 16, borderRadius: 9 },
  reSignBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  cardMeta: { marginTop: 6, fontSize: 13, color: C.muted },
  resultLine: { marginTop: 4, fontSize: 13.5, fontWeight: "700" },

  /* An appointment request, on the amber card. Its own colours rather than the
     shared ones because it sits on an amber ground, where C.muted is unreadable
     and C.ink is heavier than the card wants. */
  reqRow: { flexDirection: "row", alignItems: "center", gap: 12,
            paddingVertical: 12, marginTop: 10,
            borderTopWidth: 1, borderTopColor: "#fde68a" },
  reqName: { fontSize: 15, fontWeight: "700", color: "#7c2d12" },
  reqNote: { fontSize: 13.5, color: "#92400e", marginTop: 2 },
  reqWhen: { fontSize: 12, color: "#b45309", marginTop: 4 },
  reqGo:   { fontSize: 14, fontWeight: "700", color: "#b45309" },

  /* Why they asked, shown in the scheduling sheet. Quoted, not editable, and
     not pre-filled into the officer's own note — see ScheduleSheet. */
  askedFor: { backgroundColor: "#fffbeb", borderWidth: 1, borderColor: "#fde68a",
              borderRadius: 10, padding: 12, marginTop: 4 },
  askedForLabel: { fontSize: 11.5, fontWeight: "700", color: "#b45309",
                   letterSpacing: 0.4, textTransform: "uppercase" },
  askedForBody: { fontSize: 14, color: "#7c2d12", marginTop: 5, lineHeight: 20 },

  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillOk: { backgroundColor: C.okSoft },
  pillWarn: { backgroundColor: C.amberSoft },
  pillErr:  { backgroundColor: C.errSoft },
  pillNeutral: { backgroundColor: C.brandSoft },
  pillMuted: { backgroundColor: C.bg },
  pillText: { fontSize: 12, fontWeight: "700" },

  cta: {
    marginTop: 14, backgroundColor: C.brand, borderRadius: 10,
    paddingVertical: 12, alignItems: "center"
  },
  ctaText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  ctaOff: { backgroundColor: C.faint },
  ctaGhost: {
    marginTop: 10, borderRadius: 10, paddingVertical: 12, alignItems: "center",
    borderWidth: 1, borderColor: C.line
  },
  ctaGhostText: { color: C.ink2, fontWeight: "700", fontSize: 14.5 },

  /* ---- supervision agreement ---- */
  agHeader: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.surface
  },
  agHeaderTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: C.ink, letterSpacing: -0.3 },
  agClose: { fontSize: 15, fontWeight: "700", color: C.brand },

  /* The scrolling body of a document screen — NOT the agenda row text above.
     These were both called agBody, and a duplicate key in one StyleSheet means
     the later one silently wins: every agenda row and action item was being
     drawn as a padded grey block. Renamed so the collision cannot come back. */
  agDocBody: { padding: 16, paddingBottom: 40, backgroundColor: C.bg },

  /* ---- home cards and the bottom bar ---- */
  homeCard: {
    flexDirection: "row", alignItems: "center", gap: 13,
    backgroundColor: C.surface, borderRadius: 14, padding: 15,
    borderWidth: 1, borderColor: C.line, marginBottom: 10,
    shadowColor: "#0f172a", shadowOpacity: 0.05, shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 }, elevation: 2
  },
  homeIcon: { width: 40, height: 40, borderRadius: 12,
              alignItems: "center", justifyContent: "center" },
  homeTitle: { fontSize: 13, fontWeight: "700", color: C.muted,
               letterSpacing: 0.2, textTransform: "uppercase" },
  homeLine: { fontSize: 15.5, fontWeight: "650", marginTop: 3, lineHeight: 21 },
  homeMeta: { fontSize: 12.5, color: C.faint, marginTop: 2 },
  homeCta: { fontSize: 13.5, fontWeight: "700", color: C.brand },
  homeClear: { alignItems: "center", paddingVertical: 46, gap: 8 },
  homeClearTitle: { fontSize: 17, fontWeight: "700", color: C.ink },
  homeClearText: { fontSize: 14, color: C.muted, textAlign: "center",
                   lineHeight: 20, maxWidth: 280 },

  /* flexShrink 0 and a floor on the height. Beside a sibling with flex:1 the
     bar was being squeezed to about half its size — the icons survived, the
     labels did not, and it read as the bar sliding off the bottom of the
     screen. A chrome element gets its space first; the content takes what is
     left, not the other way round. */
  /* The top padding also has to clear the badges, which sit above the icon at
     top:-6 — at 9pt they were nearly touching the edge of the bar. */
  navBar: { flexDirection: "row", backgroundColor: C.brand,
            paddingTop: 18, paddingBottom: 8, flexShrink: 0, minHeight: 66 },
  navItem: { flex: 1, alignItems: "center", gap: 3 },
  navLabel: { fontSize: 10.5, fontWeight: "600", color: "rgba(255,255,255,0.62)" },
  navLabelOn: { color: "#fff", fontWeight: "800" },
  /* A ring in the bar colour, so a red badge sitting on blue still reads as a
     separate object rather than a smudge. */
  navBadge: { position: "absolute", top: -6, right: -12, minWidth: 18, height: 18,
              borderRadius: 9, paddingHorizontal: 4, alignItems: "center",
              justifyContent: "center", backgroundColor: C.err,
              borderWidth: 1.5, borderColor: C.brand },
  navBadgeText: { color: "#fff", fontSize: 10.5, fontWeight: "800" },

  /* One commitment per row: tick, sentence, and when it is owed. Its own
     styles rather than borrowed agenda ones — that borrowing is how the
     duplicate key above went unnoticed for so long. */
  actRow: { flexDirection: "row", gap: 12, alignItems: "flex-start",
            paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: C.line },
  actRowFirst: { borderTopWidth: 0, paddingTop: 4 },
  actBody: { fontSize: 15, color: C.ink, fontWeight: "500", lineHeight: 20.5 },
  actMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5,
             flexWrap: "wrap" },
  actDue: { fontSize: 12, fontWeight: "700", color: C.brand,
            backgroundColor: C.brandSoft, paddingHorizontal: 8, paddingVertical: 2,
            borderRadius: 999, overflow: "hidden" },
  actDueLate: { color: C.err, backgroundColor: C.errSoft },
  actSaid: { fontSize: 12.5, color: C.faint, flexShrink: 1 },
  agNotice: {
    backgroundColor: C.amberSoft, borderWidth: 1, borderColor: C.amberLine,
    borderRadius: 12, padding: 14, marginBottom: 16
  },
  agNoticeText: { fontSize: 13.5, lineHeight: 20, color: C.amber, fontWeight: "600" },
  agOffice: { fontSize: 13, color: C.muted, marginBottom: 12 },

  agFacts: {
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.line,
    paddingHorizontal: 16, paddingVertical: 6, marginBottom: 6
  },
  agFact: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line },
  agFactLabel: {
    fontSize: 11, fontWeight: "800", color: C.muted,
    textTransform: "uppercase", letterSpacing: 0.6
  },
  agFactValue: { fontSize: 15, fontWeight: "600", color: C.ink, marginTop: 2 },

  agSection: {
    fontSize: 12, fontWeight: "800", color: C.brand, textTransform: "uppercase",
    letterSpacing: 0.7, marginTop: 24, marginBottom: 4
  },
  agCond: {
    flexDirection: "row", gap: 10, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: C.line
  },
  agCondNum: { fontSize: 13.5, fontWeight: "800", color: C.faint, minWidth: 20 },
  agCondText: { fontSize: 14.5, lineHeight: 21, color: C.ink },
  agTracked: {
    marginTop: 7, alignSelf: "flex-start", fontSize: 12.5, fontWeight: "600",
    color: C.brand, backgroundColor: C.brandSoft,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, overflow: "hidden"
  },

  agViol: {
    marginTop: 24, backgroundColor: C.errSoft, borderWidth: 1, borderColor: "#fecaca",
    borderRadius: 12, padding: 15
  },
  agViolTitle: { fontSize: 11.5, fontWeight: "800", color: C.err, letterSpacing: 0.6 },
  agViolText: { marginTop: 6, fontSize: 14, lineHeight: 21, color: C.ink2 },

  agAck: {
    marginTop: 24, backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 16
  },
  agAckTitle: { fontSize: 16, fontWeight: "700", color: C.ink },
  agAckBlurb: { marginTop: 8, fontSize: 14, lineHeight: 21, color: C.ink2 },
  agAckDone: {
    marginTop: 12, backgroundColor: C.okSoft, borderWidth: 1, borderColor: "#a7f3d0",
    borderRadius: 10, padding: 14
  },
  agAckDoneText: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: C.ok },
  agCheckRow: {
    flexDirection: "row", gap: 12, alignItems: "flex-start", marginTop: 14,
    borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 13
  },
  agBox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: C.brand,
    alignItems: "center", justifyContent: "center"
  },
  agBoxOn: { backgroundColor: C.brand },
  agBoxOff: { borderColor: C.faint },
  agBoxTick: { color: "#fff", fontSize: 14, fontWeight: "900", lineHeight: 16 },
  agCheckText: { flex: 1, fontSize: 14, lineHeight: 20, color: C.ink },

  stage: { flex: 1 },
  // No borderRadius/overflow here: on iOS that clips and mis-sizes the
  // WKWebView contents. The native header already frames it.
  web: { flex: 1, backgroundColor: "#fff" },
  loadingOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#fff" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },

  resultWrap: { padding: 24, alignItems: "center", backgroundColor: C.surface, flexGrow: 1 },
  resultIcon: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: C.okSoft,
    alignItems: "center", justifyContent: "center", marginTop: 12, marginBottom: 18
  },
  resultTitle: { fontSize: 22, fontWeight: "700", color: C.ink, letterSpacing: -0.4 },
  resultSub: { fontSize: 14.5, color: C.muted, textAlign: "center", marginTop: 6, marginBottom: 22, lineHeight: 21 },
  resultTable: {
    alignSelf: "stretch", borderWidth: 1, borderColor: C.line,
    borderRadius: 12, backgroundColor: C.bg, overflow: "hidden"
  },
  resultRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 13, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line
  },
  resultKey: { color: C.muted, fontSize: 14.5, flexShrink: 1 },
  resultVal: { color: C.ink, fontSize: 15, fontWeight: "700", marginLeft: 12 },
  resultNote: { marginTop: 18, fontSize: 12.5, color: C.faint, textAlign: "center", lineHeight: 19 },
  muted: { color: C.muted, fontSize: 14.5 },
  errorBox: {
    backgroundColor: C.errSoft, borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: "#fecaca"
  },
  errorTitle: { color: C.err, fontWeight: "700", fontSize: 15, marginBottom: 6 },
  errorText: { color: C.ink2, fontSize: 13.5, lineHeight: 20 }
});
