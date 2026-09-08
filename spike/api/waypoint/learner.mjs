/** Subject-facing learner list and course-launch routes. */
import { personById, assignmentsFor, openRegistration, issueTicket } from "../db/waypoint.mjs";
import { requireLearner } from "../learner-session.mjs";
import { CONTENT_ORIGIN } from "../config.mjs";
const auth = (req, res, ctx) => { const who = requireLearner(req); return who.error ? [ctx.json(res, who.status, { error: who.error }), null] : [null, who]; };
export const routes = {
  "GET /api/me": async (req, res, ctx) => { const [e,w]=auth(req,res,ctx); if(e)return; const p=personById(w.person_id); return ctx.json(res,200,{person:{subject_id:p.subject_id,name:p.name,email:p.email}}); },
  "GET /api/me/assignments": async (req,res,ctx) => { const [e,w]=auth(req,res,ctx); if(e)return; const p=personById(w.person_id); return ctx.json(res,200,{subject_id:p.subject_id,name:p.name,programs:assignmentsFor(p.subject_id)}); },
  "POST /api/me/launch": async (req,res,ctx) => { const [e,w]=auth(req,res,ctx); if(e)return; const b=await ctx.readJson(req),p=personById(w.person_id); const a=assignmentsFor(p.subject_id).find(x=>x.program_id===b.program_id); if(!a)return ctx.json(res,403,{error:"that program is not assigned to you"}); const registration=openRegistration({person_id:p.id,content_version_id:a.content_version_id}),ticket=issueTicket(registration.id); return ctx.json(res,200,{launch_url:`${CONTENT_ORIGIN}/player?ticket=${ticket.token}`,registration_id:registration.id,expires_in:ticket.expires_in}); }
};
