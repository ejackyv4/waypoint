/**
 * Which servers this build talks to.
 *
 * Everything static lives in app.json; this file adds the one thing that is not
 * static — the origins — and only when the build is meant for the demo box.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SWITCH AND NOT A CONSTANT
 *
 * The origins used to sit in app.json unconditionally, and `config.js` treats a
 * stated origin as FORCING: given one, it uses it whether or not this is a
 * development build. That was deliberate and correct for one specific job —
 * proving the deployed server worked from the simulator BEFORE a release build
 * went to TestFlight, because a release build is the one place these URLs
 * cannot be checked by hand.
 *
 * It is wrong for every other day. Left in place it means `npx expo start`
 * points the simulator at DigitalOcean, so local changes appear to do nothing,
 * and the pre-prod demo quietly collects development traffic.
 *
 * So the same capability is kept and made deliberate:
 *
 *   npx expo start                        the laptop. The default, because it
 *                                         is what you want ninety-nine days in
 *                                         a hundred.
 *
 *   WAYPOINT_TARGET=demo npx expo start   the DigitalOcean demo, from the
 *                                         simulator. The pre-TestFlight check.
 *
 *   eas build --profile production        the demo, set in eas.json so nobody
 *                                         has to remember it.
 *
 * A release build is safe either way: `config.js` falls back to its own
 * hardcoded production origins when `__DEV__` is false, so a build made without
 * the variable still reaches the demo rather than looking for a laptop that
 * is not there.
 * ---------------------------------------------------------------------------
 */

const DEMO = {
  appOrigin:  "https://app.137-184-30-181.sslip.io",
  saasOrigin: "https://nw.137-184-30-181.sslip.io",
  doorUrl:    "https://access.137-184-30-181.sslip.io"
};

const target = process.env.WAYPOINT_TARGET || "local";

export default ({ config }) => {
  const origins = target === "demo" ? DEMO : {};

  /* Printed because a build pointed at the wrong server is invisible until
     something fails in a way that looks like a different bug entirely — which
     is exactly how an evening went once. */
  console.log(`  Waypoint: building for \x1b[1m${target}\x1b[0m`
            + (target === "demo" ? ` (${DEMO.saasOrigin})` : " (this machine)"));

  return {
    ...config,
    extra: { ...config.extra, ...origins, target }
  };
};
