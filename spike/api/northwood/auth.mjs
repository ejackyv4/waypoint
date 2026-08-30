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
  officerByEmail, officerById, saveOfficer, emailTakenBy, setOfficerPassword,
  recordLoginFailure, clearLoginFailures,
  createStaffSession, revokeStaffSession
} from "../db/northwood.mjs";
import { verifyPassword, hashPassword, newStaffToken, hashToken, STAFF_TTL_MS,
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
    const o = officerById(ctx.session.officer_id);
    return saasJson(res, 200, {
      user: { name: ctx.session.name, email: ctx.session.email,
              role: ctx.session.role, officer_id: ctx.session.officer_id,
              /* The extra profile fields, so the console can show and edit them
                 without a second round trip on every page load. */
              phone: o?.phone ?? null, badge: o?.badge ?? null,
              office_id: o?.office_id ?? null } });
  },

  /**
   * An officer editing their own profile.
   *
   * WHOSE profile comes from the session, never from the payload. An id in a
   * request body is a value the client chose, and this system already has a
   * rule about treating that as proof of identity — it is the same bug as the
   * customer id in a URL.
   *
   * `role` and `active` are not editable here at all: letting somebody change
   * their own role is privilege escalation with a form around it.
   */
  "POST /api/officer/profile": async (req, res, ctx) => {
    const b = await readJson(req);
    const id = ctx.session.officer_id;

    const name = String(b.name || "").trim();
    if (!name) return saasJson(res, 400, { error: "A name is required." });

    const email = String(b.email || "").trim();
    if (!email) return saasJson(res, 400, { error: "An email is required." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return saasJson(res, 400, { error: "That does not look like an email address." });
    /* Sign-in is by email, so a duplicate would make one of the two accounts
       unreachable — a silent lockout rather than an error. */
    if (emailTakenBy(email, id))
      return saasJson(res, 409, {
        error: "Another officer already signs in with that email." });

    const officer = saveOfficer(id, {
      name, email,
      phone: String(b.phone || "").trim() || null,
      badge: String(b.badge || "").trim() || null,
      office_id: b.office_id ? Number(b.office_id) : null
    });
    return saasJson(res, 200, {
      officer: { name: officer.name, email: officer.email, phone: officer.phone,
                 badge: officer.badge, office_id: officer.office_id,
                 role: officer.role, officer_id: officer.id } });
  },

  /**
   * Changing your own password.
   *
   * The current one is required even though the session already proves who
   * they are: a session is a device left unlocked, and "knows the old password"
   * is what stops somebody at an unattended desk locking the real officer out
   * of their own account.
   */
  "POST /api/officer/password": async (req, res, ctx) => {
    const b = await readJson(req);
    const officer = officerById(ctx.session.officer_id);
    if (!officer) return saasJson(res, 404, { error: "no such officer" });

    if (!verifyPassword(String(b.current || ""), officer.password_hash))
      return saasJson(res, 403, { error: "That is not your current password." });

    const next = String(b.password || "");
    if (next.length < 8)
      return saasJson(res, 400, { error: "Use at least 8 characters." });
    if (next === String(b.current || ""))
      return saasJson(res, 400, { error: "The new password matches the old one." });

    setOfficerPassword(officer.id, hashPassword(next));
    return saasJson(res, 200, { ok: true });
  }
};
