/**
 * Staff sign-in.
 *
 * Two credentials, ONE session row: a browser gets an httpOnly cookie it
 * cannot read from JavaScript, a native app gets the same token as a bearer.
 * Signing out revokes the row, so it kills both — two independent session
 * mechanisms would mean signing out of one and staying signed into the other.
 *
 * Subjects have no account here. They authenticate to Waypoint and Northwood
 * asks who they are; see me.mjs.
 */

import {
  officerByEmail, recordLoginFailure, clearLoginFailures,
  createStaffSession, revokeStaffSession
} from "../db/northwood.mjs";
import { verifyPassword, newStaffToken, hashToken, STAFF_TTL_MS,
         staffCookie, clearStaffCookie } from "../auth.mjs";
import { SAAS_ORIGIN } from "../config.mjs";
import { readJson } from "../http.mjs";
import { saasJson } from "./shared.mjs";

export const routes = {

  "POST /auth/login": async (req, res) => {
    const b = await readJson(req);
    const officer = b.email ? officerByEmail(String(b.email)) : null;

    if (officer?.locked_until && new Date(officer.locked_until) > new Date())
      return saasJson(res, 429, {
        error: "Too many attempts. Try again in a few minutes." });

    // Identical answer whether the account is unknown or the password is
    // wrong, so this cannot be used to discover who has an account.
    const good = officer && verifyPassword(String(b.password || ""), officer.password_hash);
    if (!good) {
      if (officer) recordLoginFailure(officer.id);
      return saasJson(res, 401, { error: "Incorrect email or password" });
    }

    clearLoginFailures(officer.id);
    const token = newStaffToken();
    createStaffSession({
      token_hash: hashToken(token), officer_id: officer.id, ttl_ms: STAFF_TTL_MS,
      ip: req.socket.remoteAddress, user_agent: req.headers["user-agent"] });

    const body = JSON.stringify({
      user: { name: officer.name, email: officer.email,
              role: officer.role, officer_id: officer.id },
      must_change: !!officer.must_change,
      // The browser uses the httpOnly cookie below and ignores this. A native
      // app cannot rely on cookies, so it carries this as a bearer token. Both
      // resolve to the SAME session row, so signing out kills either one.
      token });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Set-Cookie": staffCookie(token, { secure: SAAS_ORIGIN.startsWith("https") })
    });
    return res.end(body);
  },

  "POST /auth/logout": async (req, res, ctx) => {
    // Revoked server-side, not just cleared in the browser. A cookie the
    // client throws away is still a valid session to anyone who copied it.
    if (ctx.rawToken) revokeStaffSession(hashToken(ctx.rawToken));
    res.writeHead(200, { "Content-Type": "application/json",
                         "Set-Cookie": clearStaffCookie(), "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true }));
  },

  "ALL /auth/me": async (req, res, ctx) => {
    if (!ctx.session) return saasJson(res, 401, { error: "not signed in" });
    return saasJson(res, 200, {
      user: { name: ctx.session.name, email: ctx.session.email,
              role: ctx.session.role, officer_id: ctx.session.officer_id } });
  }
};
