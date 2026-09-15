# Organization terminology

## Purpose

Different corrections organizations use different language for the same
workflow. One organization may call an officer interaction a **Visit**; another
may call it a **Contact**. Waypoint should adapt the words shown to each
organization without changing the underlying data model or API.

## Core rule

`visit` remains the canonical technical term. It is used in:

- database tables and columns;
- API paths, request fields and response fields;
- internal JavaScript variables and functions;
- audit records and integrations.

Only presentation text is configurable. This keeps integrations stable and
prevents a terminology preference from becoming a data migration.

## Initial terminology contract

Each organization receives a terminology object. These are labels, not arbitrary
sentences or HTML:

```json
{
  "visit": "Visit",
  "visit_plural": "Visits",
  "contact_history": "Contact history",
  "start_visit": "Start visit",
  "complete_visit": "Complete visit"
}
```

The default is the current Waypoint language:

```json
{
  "visit": "Visit",
  "visit_plural": "Visits",
  "contact_history": "Visit history",
  "start_visit": "Start visit",
  "complete_visit": "Complete visit"
}
```

An organization that prefers “Contact” can configure:

```json
{
  "visit": "Contact",
  "visit_plural": "Contacts",
  "contact_history": "Contact history",
  "start_visit": "Start contact",
  "complete_visit": "Complete contact"
}
```

The application should always have a complete default object. Missing values in
an organization override fall back to the default rather than rendering
`undefined` or a blank button.

## Ownership and delivery

Terminology belongs to the organization, not to an individual user or subject.
The server is the source of truth. Clients receive it as part of the signed-in
organization context or from a small organization-settings endpoint. The mobile
and web clients must use the same response.

The server must validate overrides:

- values are strings;
- values are short display labels, not markup;
- unsupported keys are ignored;
- empty values fall back to defaults.

## Client implementation

Each client should have one helper rather than scattered conditionals:

```js
const term = (key, fallback) => terminology[key] || fallback;
```

Use it for visible labels only:

```js
term("visit_plural", "Visits")
term("start_visit", "Start visit")
```

Do not use it to construct API paths. This is correct:

```js
POST /api/visits/start
```

This is not:

```js
POST /api/contacts/start
```

## Rollout plan

1. Add default terminology on the server and expose it with the organization
   context.
2. Add the same default object and helper to web and mobile as a safe fallback.
3. Replace visible visit labels in the officer profile first, beginning with
   **Contact history**.
4. Replace labels in scheduling, active-visit, dashboard, alerts, reports and
   subject screens.
5. Add an organization settings control after the label inventory is complete.
6. Test both “Visit” and “Contact” configurations end to end.

## Label inventory

Before enabling organization editing, search all user-facing surfaces for:

- Visit / Visits;
- Start visit;
- Complete visit;
- Schedule visit;
- Visit history;
- visit request;
- visit notes, photographs and recordings.

Technical names, comments, API documentation examples and database identifiers
do not need translation unless they are displayed to a user.

## What not to do

- Do not rename the `visits` table or `/api/visits` routes.
- Do not store organization-specific labels in each mobile build.
- Do not infer terminology from a user’s language or role.
- Do not allow arbitrary HTML or long free-form copy in terminology values.
- Do not change historical audit text when an organization changes its labels;
  historical records retain their facts and can be rendered with current labels.

## Acceptance criteria

The feature is ready when an organization configured for “Contact” sees that
word consistently in the officer and subject web/mobile interfaces, while API
traffic, database records, audit identifiers and an organization configured for
“Visit” remain unchanged.
