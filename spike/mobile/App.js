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
  ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Platform,
  Pressable, RefreshControl, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, TextInput, View
} from "react-native";
import { WebView } from "react-native-webview";
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
  ok: "#059669", okSoft: "#ecfdf5", err: "#dc2626", errSoft: "#fef2f2"
};

/* ================================================================
   Sign in

   The learner authenticates against Waypoint with credentials the SaaS
   provisioned. The token that comes back is person-scoped: it lists
   their programs and asks for launch tickets. It cannot write to a
   registration — that still requires redeeming a ticket.
================================================================ */
function SignIn({ onSignedIn }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!identifier.trim() || !password) return setError("Enter your email and password.");
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim(), password })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Sign in failed");
      onSignedIn({ token: d.token, person: d.person });
    } catch (e) {
      setError(String(e.message || e).includes("Network")
        ? `Can't reach Waypoint at ${API_BASE}.` : String(e.message || e));
    } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}
                           style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.signInWrap} keyboardShouldPersistTaps="handled">
          <View style={s.signInMark}><Text style={s.signInMarkText}>W</Text></View>
          <Text style={s.signInTitle}>Waypoint</Text>
          <Text style={s.signInSub}>Sign in to your learning</Text>

          {error && <View style={s.signInError}><Text style={s.signInErrorText}>{error}</Text></View>}

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
/* Initials avatar, colored deterministically so it is recognizable. */
function Avatar({ name, size = 46 }) {
  const initials = String(name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2,
                   backgroundColor: `hsl(${h}, 42%, 42%)`,
                   alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
}

function fmtVisit(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short",
                                       hour: "2-digit", minute: "2-digit" });
}

/* ================================================================
   Home — condensed case profile, then Programs / Visits
================================================================ */
function Home({ auth, onLaunch, onSignOut }) {
  const [tab, setTab] = useState("programs");
  const [caseData, setCaseData] = useState(null);

  /* Northwood's data, fetched with the Waypoint token — their side asks
     Waypoint who the token belongs to rather than trusting the app. */
  const loadCase = useCallback(async (markSeen) => {
    try {
      const r = await fetch(`${SAAS_BASE}/api/me/case${markSeen ? "?seen=1" : ""}`,
        { headers: { Authorization: `Bearer ${auth.token}` } });
      if (r.ok) setCaseData(await r.json());
    } catch {}
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
      </View>

      {tab === "programs"
        ? <ProgramList auth={auth} onLaunch={onLaunch} onSignOut={onSignOut} />
        : <VisitList auth={auth} caseData={caseData} onRefresh={() => loadCase(true)} />}
    </SafeAreaView>
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
             const r = await fetch(`${SAAS_BASE}/api/me/visits/request`, {
               method: "POST",
               headers: { "Content-Type": "application/json",
                          Authorization: `Bearer ${auth.token}` },
               body: JSON.stringify({ note: note || null })
             });
             if (!r.ok) throw new Error((await r.json()).error || "Could not send");
             await onRefresh();
           } catch (e) { Alert.alert("Couldn't send", String(e.message || e)); }
           finally { setRequesting(false); }
         } }]);
  };
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(null);
  const refresh = async () => { setBusy(true); await onRefresh(); setBusy(false); };

  const accept = async id => {
    setAccepting(id);
    try {
      const r = await fetch(`${SAAS_BASE}/api/me/visits/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ id })
      });
      if (!r.ok) throw new Error((await r.json()).error || "Could not confirm");
      await onRefresh();
    } catch (e) {
      Alert.alert("Couldn't confirm", String(e.message || e));
    } finally { setAccepting(null); }
  };

  return (
    <ScrollView contentContainerStyle={s.listBody}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={C.brand} />}>
      {!caseData && <View style={s.centre}><ActivityIndicator color={C.brand} /></View>}

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
        <View style={s.centre}><Text style={s.muted}>No visits scheduled.</Text></View>
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
      const r = await fetch(`${API_BASE}/api/me/assignments`,
        { headers: { Authorization: `Bearer ${auth.token}` } });
      if (r.status === 401) return onSignOut();          // session expired
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPrograms((await r.json()).programs || []);
    } catch (e) {
      setError(`Can't reach Waypoint at ${API_BASE}. Check the server is running and that API_BASE in config.js is this machine's LAN address.`);
    } finally { setBusy(false); }
  }, [auth, onSignOut]);

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
                  {suspended ? "Resume course" : done ? "Retake course" : started ? "Continue" : "Start course"}
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
        const r = await fetch(`${API_BASE}/api/me/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json",
                     Authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({ program_id: program.program_id })
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
export default function App() {
  const [auth, setAuth] = useState(null);      // { token, person }
  const [active, setActive] = useState(null);

  const signOut = useCallback(() => { setActive(null); setAuth(null); }, []);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={C.surface} />
      {!auth
        ? <SignIn onSignedIn={setAuth} />
        : active
        ? <Player auth={auth} program={active} onExit={() => setActive(null)} />
        : <Home auth={auth} onLaunch={setActive} onSignOut={signOut} />}
    </>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

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
  pillNeutral: { backgroundColor: C.brandSoft },
  pillMuted: { backgroundColor: C.bg },
  pillText: { fontSize: 12, fontWeight: "700" },

  cta: {
    marginTop: 14, backgroundColor: C.brand, borderRadius: 10,
    paddingVertical: 12, alignItems: "center"
  },
  ctaText: { color: "#fff", fontWeight: "700", fontSize: 15 },

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
