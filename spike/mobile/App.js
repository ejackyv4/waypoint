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
  ActivityIndicator, Alert, Animated, AppState, BackHandler, KeyboardAvoidingView,
  Linking, Modal, Platform, Pressable, RefreshControl, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View
} from "react-native";
import { WebView } from "react-native-webview";
import DateTimePicker from "@react-native-community/datetimepicker";
import { API_BASE, SAAS_BASE } from "./config";

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
        return { reached: true, ok: r.ok, body: await r.json().catch(() => ({})) };
      } catch {
        return { reached: false, ok: false, body: {} };   // never reached the server
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

      if (!staff.reached && !learner.reached) {
        setError(`Can't reach the server at ${API_BASE}. Check you are on the same `
               + "network and that the demo is running.");
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
function Avatar({ name, size = 46, hasLogin = false }) {
  const initials = String(name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  const circle = (
    <View style={{ width: size, height: size, borderRadius: size / 2,
                   backgroundColor: `hsl(${h}, 42%, 42%)`,
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

function fmtVisit(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short",
                                       hour: "2-digit", minute: "2-digit" });
}

/* ================================================================
   Officer — Schedule and Caseload
================================================================ */
const addressOf = v => [v.address_line1, v.city, v.state, v.postal_code]
  .filter(Boolean).join(", ");

/** Hand the address to whatever map app the platform prefers. */
function openMaps(address) {
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
  const startVisit = v =>
    write("/api/visits/start", { id: v.id, officer: auth.user?.name },
          `Visit started — ${v.subject_name}`);

  const completeVisit = (v, note, observations) =>
    write("/api/visits/complete",
          { id: v.id, officer: auth.user?.name, note: note || null, observations },
          "Visit recorded");

  const scheduleVisit = (subject_id, when, note) =>
    write("/api/visits", { subject_id, scheduled_at: when.toISOString(),
                           officer: auth.user?.name, notes: note || null },
          `Visit scheduled for ${fmtVisit(when.toISOString())}`);

  const pending = data?.requests?.length || 0;

  if (viewing) return (
    <OfficerSubject auth={auth} subject={viewing} onBack={() => { setViewing(null); load(); }} />
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
        ? <OfficerSchedule data={data} busy={busy} onRefresh={load}
            onStart={v => startVisit(v)}
            onComplete={v => setSheet({ mode: "complete", visit: v })}
            onSchedule={v => setSheet({ mode: "schedule",
              subject: { subject_id: v.subject_id, name: v.subject_name } })} />
        : <OfficerCaseload subjects={caseload} busy={busy} onRefresh={load}
            onOpen={setViewing}
            onSchedule={sub => setSheet({ mode: "schedule", subject: sub })} />}

      {sheet?.mode === "complete" && (
        <CompleteSheet visit={sheet.visit} onCancel={() => setSheet(null)}
                       onSave={(note, obs) => completeVisit(sheet.visit, note, obs)} />
      )}
      {sheet?.mode === "schedule" && (
        <ScheduleSheet subject={sheet.subject} onCancel={() => setSheet(null)}
                       onSave={(when, note) => scheduleVisit(sheet.subject.subject_id, when, note)} />
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

function ScheduleSheet({ subject, onCancel, onSave }) {
  const initial = new Date(Date.now() + 7 * 864e5);
  initial.setHours(10, 0, 0, 0);
  const [when, setWhen] = useState(initial);
  const [note, setNote] = useState("");
  const [show, setShow] = useState(Platform.OS === "ios" ? "datetime" : null);
  const [saving, setSaving] = useState(false);

  return (
    <Sheet title="Schedule a visit" subtitle={subject.name}
           onCancel={onCancel} saveLabel={saving ? "Saving…" : "Schedule"}
           disabled={saving}
           onSave={() => { setSaving(true); onSave(when, note.trim()); }}>
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

function OfficerSchedule({ data, busy, onRefresh, onStart, onComplete, onSchedule }) {
  const upcoming = data?.upcoming || [];
  const requests = data?.requests || [];

  /* Group by day so the list reads like a diary rather than a table. */
  const days = [];
  upcoming.forEach(v => {
    const label = dayLabel(v.scheduled_at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(v);
    else days.push({ label, items: [v] });
  });

  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={onRefresh} tintColor={C.brand} />}>

      {requests.length > 0 && (
        <View style={[s.card, { borderColor: "#fde68a", backgroundColor: "#fffbeb" }]}>
          <Text style={{ fontWeight: "700", color: "#b45309", fontSize: 15 }}>
            {requests.length} appointment {requests.length === 1 ? "request" : "requests"}
          </Text>
          {requests.map(r => (
            <Text key={r.id} style={[s.cardMeta, { color: "#92400e" }]}>
              {r.subject_name}{r.request_note ? ` — ${r.request_note}` : ""}
            </Text>
          ))}
          <Text style={[s.cardMeta, { color: "#92400e", marginTop: 8 }]}>
            Set a date from the web console.
          </Text>
        </View>
      )}

      {!data && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}
      {data && upcoming.length === 0 && (
        <View style={s.center}><Text style={s.muted}>No visits scheduled.</Text></View>
      )}

      {days.map(day => (
        <View key={day.label}>
          <Text style={s.dayHeading}>{day.label}</Text>
          {day.items.map(v => {
            const address = addressOf(v);
            return (
              <View key={v.id} style={s.card}>
                <View style={s.cardTop}>
                  <Text style={s.visitTime}>{timeLabel(v.scheduled_at)}</Text>
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
                {address ? <Text style={s.cardMeta}>{address}</Text> : null}
                {v.notes ? <Text style={s.noteLine}>{v.notes}</Text> : null}
                {v.started_at ? (
                  <Text style={[s.cardMeta, { color: C.brand, fontWeight: "700" }]}>
                    In progress — started {timeLabel(v.started_at)}
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
                  {v.started_at ? (
                    <Pressable style={({ pressed }) => [s.btnSolid, pressed && { backgroundColor: C.brandDark }]}
                               onPress={() => onComplete(v)}>
                      <Text style={s.btnSolidText}>End visit</Text>
                    </Pressable>
                  ) : (
                    <Pressable style={({ pressed }) => [s.btnSolid, pressed && { backgroundColor: C.brandDark }]}
                               onPress={() => onStart(v)}>
                      <Text style={s.btnSolidText}>Start visit</Text>
                    </Pressable>
                  )}
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
  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={onRefresh} tintColor={C.brand} />}>
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

      <ScrollView contentContainerStyle={s.listBody}>
        {!detail && <View style={s.center}><ActivityIndicator color={C.brand} /></View>}

        {detail && (
          <>
            <Row title="Curfew"
                 chip={cur?.active ? "In effect" : "None"} chipOk={!!cur?.active}
                 value={cur?.active ? `${to12h(cur.start_time)} to ${to12h(cur.end_time)}`
                                    : "No curfew set"}
                 onPress={() => setSheet({ mode: "curfew" })} />

            <ContactsCard contacts={detail?.contacts || []} theirName={subject.name.split(" ")[0]}
              onSave={(v, done) => post("/api/contacts", v,
                        v.id ? "Contact updated" : "Contact added")
                        .then(ok => { if (ok) done(); })}
              onRemove={c => post("/api/contacts/delete", { id: c.id }, "Contact removed")} />

            <Row title="Employment"
                 chip={EMPLOY_LABEL[emp?.status || "not_employed"]}
                 chipOk={emp?.status === "employed" || emp?.status === "self_employed"}
                 value={employmentSummary(emp)}
                 onPress={() => setSheet({ mode: "employment" })} />

            <Row title="Travel permit"
                 chip={travExpired ? "Expired" : travAllowed ? TRAVEL_LABEL[trav.level] : "None"}
                 chipOk={travAllowed}
                 value={travAllowed
                   ? `${TRAVEL_LABEL[trav.level]}${trav.expires_on ? ` until ${asDate(trav.expires_on)}` : ", no expiry"}`
                   : travExpired ? `Expired ${asDate(trav.expires_on)}` : "No travel permitted"}
                 onPress={() => setSheet({ mode: "travel" })} />

            <View style={s.card}>
              <View style={s.cardTop}>
                <Text style={s.cardTitle}>Community service</Text>
                {svc.length > 0 && (
                  <View style={[s.pill, s.pillMuted]}><Text style={[s.pillText, { color: C.muted }]}>
                    {svc.filter(o => o.status === "complete").length}/{svc.length} done</Text></View>
                )}
              </View>
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
            </View>

            <View style={s.card}>
              <View style={s.cardTop}><Text style={s.cardTitle}>Vehicles</Text></View>
              {cars.length ? cars.map(v => (
                <View key={v.id} style={s.detailRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detailTitle}>
                      {[v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}</Text>
                    <Text style={s.cardMeta}>
                      {[v.color, v.plate ? `Plate ${v.plate}` : ""].filter(Boolean).join(" · ") || "No details"}
                    </Text>
                  </View>
                </View>
              )) : <Text style={s.cardMeta}>None on record.</Text>}
              <Text style={[s.cardMeta, { marginTop: 10, color: C.faint }]}>
                Subjects maintain their own vehicle details.
              </Text>
            </View>
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

function Home({ auth, onLaunch, onSignOut }) {
  const [tab, setTab] = useState("programs");
  const [caseData, setCaseData] = useState(null);
  const [agreementOpen, setAgreementOpen] = useState(false);

  /* Northwood's data, fetched with the Waypoint token — their side asks
     Waypoint who the token belongs to rather than trusting the app. */
  const loadCase = useCallback(async (markSeen) => {
    try {
      const r = await authed(`${SAAS_BASE}/api/me/case${markSeen ? "?seen=1" : ""}`, auth.token);
      if (r.ok) setCaseData(await r.json());
    } catch {}   // a 401 has already ended the session
  }, [auth]);

  useEffect(() => { loadCase(false); }, [loadCase]);

  const unseen = caseData?.unseen_visits || 0;
  const subject = caseData?.subject;

  const openVisits = () => { setTab("visits"); if (unseen) loadCase(true); };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.profileBar}>
        <Avatar name={auth.person?.name || subject?.name} />
        <View style={{ flex: 1 }}>
          <Text style={s.profileName}>{auth.person?.name || subject?.name}</Text>
          <Text style={s.profileMeta}>
            {subject?.case_number ? `${subject.case_number}  ·  ` : ""}
            {subject?.status || "Learner"}
          </Text>
          {subject?.officer ? (
            <Text style={s.profileMeta}>Officer {subject.officer}</Text>
          ) : null}
        </View>
        <Pressable onPress={onSignOut} hitSlop={10}>
          <Text style={s.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <View style={s.tabs}>
        <Pressable style={[s.tab, tab === "programs" && s.tabOn]} onPress={() => setTab("programs")}>
          <Text style={[s.tabText, tab === "programs" && s.tabTextOn]}>Programs</Text>
        </Pressable>
        <Pressable style={[s.tab, tab === "visits" && s.tabOn]} onPress={openVisits}>
          <Text style={[s.tabText, tab === "visits" && s.tabTextOn]}>Visits</Text>
          {unseen > 0 && (
            <View style={s.badge}><Text style={s.badgeText}>{unseen}</Text></View>
          )}
        </Pressable>
        <Pressable style={[s.tab, tab === "details" && s.tabOn]} onPress={() => setTab("details")}>
          <Text style={[s.tabText, tab === "details" && s.tabTextOn]}>My Details</Text>
        </Pressable>
      </View>

      {/* Sits above the tabs so it is unmissable whichever tab they land on.
          It does not hijack the session — this is a prompt, not a gate. */}
      {needsAck(caseData) && (
        <Pressable style={s.ackBanner} onPress={() => setAgreementOpen(true)}>
          <Text style={s.ackBannerIcon}>&#9888;</Text>
          <Text style={s.ackBannerText}>
            {wasAmended(caseData)
              ? "Your conditions of supervision have been updated. Review and acknowledge them again."
              : "You have conditions of supervision to review and acknowledge."}
          </Text>
          <Text style={s.ackBannerGo}>Review</Text>
        </Pressable>
      )}

      {tab === "programs"
        ? <ProgramList auth={auth} onLaunch={onLaunch} onSignOut={onSignOut} />
        : tab === "visits"
        ? <VisitList auth={auth} caseData={caseData} onRefresh={() => loadCase(true)} />
        : <MyDetails auth={auth} caseData={caseData} onRefresh={() => loadCase(false)}
                     onOpenAgreement={() => setAgreementOpen(true)} />}

      <Modal visible={agreementOpen} animationType="slide"
             onRequestClose={() => setAgreementOpen(false)}>
        <AgreementScreen auth={auth} caseData={caseData}
                         onClose={() => setAgreementOpen(false)}
                         onAcknowledged={() => loadCase(false)} />
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

      <ScrollView contentContainerStyle={s.agBody} scrollEventThrottle={64}
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
   My Details — curfew and community service are set by the officer and
   read-only here. Vehicles are self-reported, so the subject maintains
   their own.
================================================================ */
function MyDetails({ auth, caseData, onRefresh, onOpenAgreement }) {
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
    <ScrollView contentContainerStyle={s.listBody}>
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

function ContactsCard({ contacts, onSave, onRemove, busy, theirName }) {
  const [editing, setEditing] = useState(null);   // {} for new, {…} for existing

  const confirmRemove = c => Alert.alert("Remove this contact?",
    `${c.name} (${c.relationship}) will be removed from the record.`,
    [{ text: "Cancel", style: "cancel" },
     { text: "Remove", style: "destructive", onPress: () => onRemove(c) }]);

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle}>Family &amp; contacts</Text>
        {contacts.length > 0 && (
          <View style={[s.pill, s.pillMuted]}>
            <Text style={[s.pillText, { color: C.muted }]}>{contacts.length}</Text>
          </View>
        )}
      </View>

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
function VisitList({ auth, caseData, onRefresh }) {
  const allVisits = (caseData?.visits || []).filter(v => v.status !== "cancelled");
  const pending = allVisits.find(v => v.status === "requested");
  const visits = allVisits.filter(v => v.status !== "requested");
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
      refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={C.brand} />}>
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
      {visits.map(v => {
        const done = v.status === "completed";
        const accepted = !!v.accepted_at;
        return (
          <View key={v.id} style={s.card}>
            <View style={s.cardTop}>
              <Text style={s.cardTitle}>{fmtVisit(v.scheduled_at)}</Text>
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
        );
      })}
    </ScrollView>
  );
}

function ProgramList({ auth, onLaunch, onSignOut }) {
  const [programs, setPrograms] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await authed(`${API_BASE}/api/me/assignments`, auth.token);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPrograms((await r.json()).programs || []);
    } catch (e) {
      // An expired session already returned to sign-in; don't blame the network.
      if (String(e.message || "").includes("session")) return;
      setError(`Can't reach Waypoint at ${API_BASE}. Check the server is running and that API_BASE in config.js is this machine's LAN address.`);
    } finally { setBusy(false); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  return (
      <ScrollView
        contentContainerStyle={s.listBody}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={C.brand} />}>

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
          const done = p.completion_status === "completed";
          const passed = p.success_status === "passed";
          const failed = p.success_status === "failed";
          const started = p.registration_id && p.completion_status !== "not attempted";
          const suspended = p.exit_mode === "suspend";

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
      <StatusBar barStyle="dark-content" backgroundColor={C.surface} />
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
  cardMeta: { marginTop: 6, fontSize: 13, color: C.muted },
  resultLine: { marginTop: 4, fontSize: 13.5, fontWeight: "700" },

  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillOk: { backgroundColor: C.okSoft },
  pillWarn: { backgroundColor: C.amberSoft },
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
  ackBanner: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: C.amberSoft, borderBottomWidth: 1, borderBottomColor: C.amberLine,
    paddingHorizontal: 16, paddingVertical: 12
  },
  ackBannerIcon: { fontSize: 16, color: C.amber },
  ackBannerText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: C.amber, fontWeight: "600" },
  ackBannerGo: { fontSize: 13.5, fontWeight: "800", color: C.amber },

  agHeader: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.surface
  },
  agHeaderTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: C.ink, letterSpacing: -0.3 },
  agClose: { fontSize: 15, fontWeight: "700", color: C.brand },

  agBody: { padding: 16, paddingBottom: 40, backgroundColor: C.bg },
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
