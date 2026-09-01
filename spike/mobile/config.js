/**
 * Where the servers are.
 *
 * Two completely different answers, decided at build time.
 *
 * **A development build asks Metro.** A device cannot reach "localhost", so it
 * needs the laptop's address on whatever network it is currently on — and that
 * changes every time the laptop moves. Office, home, hotel wifi, a phone
 * hotspot: four addresses in a day, each one previously meaning an edit and a
 * reload, usually discovered by the app silently failing to connect. Metro
 * serves this bundle from the same machine the API runs on, so Expo already
 * knows the answer and is asked for it.
 *
 * **A release build has no Metro.** It uses the deployed server, over HTTPS,
 * and there is nothing to detect. That address is written below — which makes
 * it the one thing in this file that goes stale when the server moves, so
 * SERVER_URL can override it without a rebuild.
 *
 * Ports only appear in the development case; in production Caddy answers on
 * 443 for two different hostnames.
 */

import Constants from "expo-constants";

/* ---------------------------------------------------------------- *
 * production                                                         *
 * ---------------------------------------------------------------- */

/** The deployed server. Overridable from app.json without touching this file. */
const extra = Constants.expoConfig?.extra || {};

const PROD_APP  = extra.appOrigin  || "https://app.137-184-30-181.sslip.io";
const PROD_SAAS = extra.saasOrigin || "https://nw.137-184-30-181.sslip.io";

/**
 * The front door.
 *
 * The deployed API only answers addresses that have been allowed through, so a
 * phone on a network it has not used before gets a 403 rather than a login
 * screen. The app cannot fix that itself — it is not a browser and the door is
 * a web page — so it must at least SAY so, and hand over the link.
 *
 * A 403 that reads as "the server is down" is the expensive version of this.
 */
export const DOOR_URL = extra.doorUrl || "https://access.137-184-30-181.sslip.io";

/* ---------------------------------------------------------------- *
 * development                                                        *
 * ---------------------------------------------------------------- */

const APP_PORT = 8090;
const SAAS_PORT = 8092;

/** Whatever `./spike/demo start` last detected. Used only if Expo cannot say. */
const WRITTEN_HOST = "192.168.50.212";

/**
 * The machine serving this bundle.
 *
 * Expo has moved this field between releases, so all the known places are
 * tried rather than one being guessed at: an app that cannot find its server
 * fails in a way that looks like the server being down, which is the most
 * expensive kind of wrong.
 */
function packagerHost() {
  const candidates = [
    Constants.expoConfig?.hostUri,
    Constants.expoGoConfig?.debuggerHost,
    Constants.manifest2?.extra?.expoClient?.hostUri,
    Constants.manifest?.debuggerHost,
    Constants.manifest?.hostUri
  ];
  for (const c of candidates) {
    // "192.168.1.5:8081" or "exp://192.168.1.5:8081"
    const host = String(c || "").replace(/^\w+:\/\//, "").split(":")[0];
    /* A packager on localhost means the simulator, which reaches the API on
       localhost too — so it is a perfectly good answer and is taken as one. */
    if (host) return host;
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * which one                                                          *
 * ---------------------------------------------------------------- */

/* __DEV__ is false in a release bundle. Not a hand-set flag: a switch somebody
   has to remember to flip is a switch that ships flipped the wrong way. */
export const IS_DEV = typeof __DEV__ !== "undefined" && __DEV__;

/* An origin stated in app.json wins outright, even in development.
   That is how a simulator build is pointed at the deployed server — which has
   to be provable BEFORE a release build goes anywhere near TestFlight, because
   a release build is the one place these URLs cannot be checked by hand. */
const FORCED = !!(extra.appOrigin && extra.saasOrigin);

export const USING_SERVER = FORCED || !IS_DEV;

export const HOST = USING_SERVER ? null : (packagerHost() || WRITTEN_HOST);

/** Waypoint: the LMS. Courses, launch tickets, the learner's own login. */
export const API_BASE = USING_SERVER ? PROD_APP : `http://${HOST}:${APP_PORT}`;

/** Northwood's own system. The app is a client of both. */
export const SAAS_BASE = USING_SERVER ? PROD_SAAS : `http://${HOST}:${SAAS_PORT}`;

/** Shown on the sign-in screen, so a failure to connect names the address. */
export const HOST_SOURCE = USING_SERVER
  ? "deployed"
  : (packagerHost() ? "detected" : "configured");

/** What the sign-in screen shows when it cannot reach anything. */
export const SERVER_LABEL = USING_SERVER
  ? String(PROD_SAAS).replace(/^https?:\/\//, "")
  : `${HOST} (development)`;
