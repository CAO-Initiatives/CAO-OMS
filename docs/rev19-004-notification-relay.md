# REV19-004 — Power Automate notification relay

**Status:** designed, and the primary design is BLOCKED ON LICENSING. Tested in
the tenant on 6 Sept 2026: saving a flow whose trigger is *When an HTTP request
is received* returns

> This flow's owner needs a Power Automate Premium license.
> This flow includes premium capabilities that require a Power Automate Premium license.

The test flow was refused and never created (My flows is empty), so nothing was
left behind. **This tenant does not have Power Automate Premium.**

Read from the connector gallery in the same session: **Office 365 Outlook and
GitHub are standard tier; every HTTP connector is premium.** That rules out both
halves of the design below — the HTTP *trigger* and the HTTP *action*.

The gateway-triggered design in this document remains the right one **if a
Premium license is obtained**, and it is written up in full because that is a
live option: it is one per-user license for whoever owns the flow, and it is the
only option that keeps the trigger URL out of a public static file. If no license
is bought, see **Options without Premium** at the end, which is where the
decision now sits.

**Acceptance criteria (from the register):** *An assignment notification reaches
the owner without a manual draft step.*

---

## What happens today

`createNotificationForTask()` already does most of the work. When a task's owner
changes and that owner has an email address on file, OMS writes a `notifications`
record carrying `recipientEmail`, `subject` and `body`, with `status:'pending'`
and `method:'outlook_draft'`.

The last step is a person. Someone opens the notification, clicks through to an
Outlook compose deeplink, and sends it. Then the record moves to
`status:'sent_by_user'` with a `sentAt` stamp. All four notifications in
canonical today are `sent_by_user`, so the path works — it just is not automatic,
and it stops entirely when nobody is at a desk.

## What has to change

Only the send. The record, the subject standard (`OMS | HIGH PRIORITY | Due … |
New assignment | … | …`, set in Rev 19) and the body are already correct and are
reused verbatim. This is a delivery mechanism, not a rewrite.

---

## Design decision: trigger from the gateway, not from the browser

A Power Automate "When an HTTP request is received" trigger produces a URL whose
`sig` query parameter **is the credential**. Anyone holding that URL can invoke
the flow, and therefore send mail from the Dean's mailbox.

`oms.html` is a public, static, unminified file served by GitHub Pages. A URL
placed in it is published to the world. So the browser must never hold it.

The gateway is the right place:

- it already runs server-side on Vercel and already holds a far more sensitive
  secret, the GitHub App private key;
- it already sees every operation, including the `notifications` create;
- Vercel environment variables are the same store the existing secrets use, so
  no new secret-management surface is introduced.

Three alternatives were considered and rejected:

| Approach | Why not |
|---|---|
| Browser calls the flow directly | Publishes the trigger URL, which is a bearer credential, in a public file. |
| Consolidator workflow (GitHub Actions) sends the mail | Would need Microsoft Graph credentials in the data repository, and would couple mail delivery to a workflow that is already the least reliable link in the chain (see OPS-025). |
| Flow polls canonical state on a schedule | Needs a GitHub PAT with read access to a private repository stored in Power Automate, adds up to a full polling interval of latency, and still needs a write path to mark records sent. |

---

## The gateway change

In `submitOperation`, after the operation file is written, fire the relay and
**do not await its success**. A relay failure must never fail a save: the record
is already durable, and the existing manual draft remains as the fallback.

```js
// after: await gh(`/repos/${owner}/${repo}/contents/${path}`, ...)

// Rev 19-004. Fire and forget, deliberately. The operation is already durable
// at this point; a mail-relay outage must not turn a successful save into a
// failed one, and must not add its latency to the user's save. Anything that
// does not relay stays visible in OMS with its Outlook draft link intact.
if (input.entityType === "notifications" && input.action === "create") {
  relayNotification(input.changes).catch(e =>
    console.error("notification relay failed (save was unaffected):", e.message));
}
```

```js
const RELAY_TIMEOUT_MS = 8000;

async function relayNotification(rec) {
  const url = process.env.OMS_RELAY_URL;          // optional: unset = feature off
  if (!url) return;
  const to = String((rec && rec.recipientEmail) || "").trim();
  if (!to) return;                                 // no address, nothing to send
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Second factor beside the URL's own sig, so a leaked URL alone is not
        // enough to send mail as the Dean.
        "X-OMS-Relay-Key": env("OMS_RELAY_KEY"),
      },
      body: JSON.stringify({
        notificationId: String((rec && rec.id) || ""),
        to,
        recipientName: String((rec && rec.recipientName) || ""),
        subject: String((rec && rec.subject) || "OMS notification"),
        body: String((rec && rec.body) || ""),
      }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`relay HTTP ${r.status}`);
  } finally {
    clearTimeout(timer);
  }
}
```

Environment variables to add in Vercel:

| Name | Value |
|---|---|
| `OMS_RELAY_URL` | the flow's HTTP POST URL, from the trigger card |
| `OMS_RELAY_KEY` | a long random string, also set in the flow's condition |

Leaving `OMS_RELAY_URL` unset disables the relay entirely and restores exactly
today's behavior. That is the rollback: unset one variable.

**This goes by PR** — CLAUDE.md: anything touching the gateway or CAO-OMS-Data
has no rollback baseline. The PR is not worth opening until the flow exists,
because it cannot be tested without a URL.

---

## The flow

Import `power-automate/oms-notification-relay.flow.json`, or build it by hand —
it is four cards.

1. **When an HTTP request is received** (trigger)
   - Request Body JSON Schema: paste from the file below.
   - *Who can trigger:* Anyone (the URL's `sig` is the gate; the header check is
     the second factor).
2. **Condition** — `triggerOutputs()?['headers']?['X-OMS-Relay-Key']` **is equal
   to** the same secret. If false, **Response 401** and terminate. Without this,
   the trigger URL on its own is enough to send mail as the Dean.
3. **Send an email (V2)** — Office 365 Outlook connector
   - *To:* `triggerBody()?['to']`
   - *Subject:* `triggerBody()?['subject']`
   - *Body:* `triggerBody()?['body']` — send as **plain text**; the body is
     newline-formatted plain text, and rendering it as HTML collapses every line
     break.
   - *From (Send as):* `deanboulware@advocatehealth.org`
   - *Reply To:* the OMS owner's address.
   - *Importance:* High when the subject contains `HIGH PRIORITY`, else Normal.
4. **Response 200** with `{"relayed": true, "notificationId": …}`.

### Sending as the Dean

The flow's Office 365 connection runs as whoever authorizes it. To send from
`deanboulware@advocatehealth.org` either:

- **authorize the connection as that mailbox** — simplest, and matches how the
  address is already used; or
- **grant Send As** on it to the account that owns the flow, then set *From
  (Send as)*. Advocate IT has to make that grant; a flow cannot self-grant it.

Confirm which before building, because it decides who must own the flow.

---

## Marking records sent

Deliberately **out of scope for phase 1**, and worth being explicit about rather
than half-doing.

Writing `status:'relayed'` back to canonical means the flow needs OMS credentials
and a route through `/api/operation`, which is a second authentication story and
a second failure mode — for a field whose only consumer is a badge.

Phase 1 therefore leaves relayed notifications reading `pending` in OMS. That is
honest: OMS genuinely does not know the mail was delivered. The manual draft link
stays, so a notification can still be sent by hand if the relay was down, at the
cost of a possible duplicate.

Phase 2, once the relay is proven, should close this by having the flow call back
to the gateway with `X-OMS-Relay-Key` and a small dedicated endpoint that stamps
`status:'relayed'` and `relayedAt`. That endpoint is a better idea than giving
Power Automate an OMS session, because it can be scoped to exactly one field on
exactly one collection.

---

## How to verify it works

1. Set `OMS_RELAY_URL` and `OMS_RELAY_KEY` in Vercel; redeploy the gateway.
2. In OMS, assign a task to yourself with an address on file.
3. Watch for **Connected** and the revision to advance — do not reload during
   *Sync pending*.
4. The mail should arrive within seconds of the operation being accepted, well
   before canonical confirmation, because the relay does not wait for the
   consolidator.
5. Check the flow's run history for a 200.
6. Negative test that actually matters: **POST to the flow URL with a wrong
   `X-OMS-Relay-Key` and confirm it returns 401 and sends nothing.** A relay that
   works is not the same as a relay that is safe.
7. Unset `OMS_RELAY_URL` and confirm saves still succeed and notifications still
   appear with their draft links — that is the rollback path, and it should be
   exercised once deliberately rather than discovered during an incident.


---

## Options without Premium

Established 6 Sept 2026. Standard-tier connectors available: **Office 365
Outlook**, **GitHub**, and the schedule/recurrence trigger. Not available: every
HTTP connector, trigger and action alike.

**A. Buy one Power Automate Premium license for the flow owner.** Roughly the
cost of a per-user add-on, and the design above then works unchanged. It is the
only option where the trigger URL never touches `oms.html`, and the only one
that needs no new credential stored outside the gateway. Recommended if the cost
is acceptable, because every alternative trades security or reliability for it.

**B. Drive the flow from the GitHub connector (standard).** The data repository
already receives a commit for every operation, so a GitHub-connector trigger on
that repository could fire the send without any HTTP action. **Needs one thing
verified before it can be recommended:** whether the connector's available
operations actually cover reading the notification content — its action set is
oriented around issues, pull requests and workflows rather than arbitrary file
content. If they do not, the notification body would have to be carried in
something the connector *can* read, which starts bending the data model around a
licensing constraint. It also puts a GitHub credential inside Power Automate,
which the primary design deliberately avoided.

**C. Send from the consolidator workflow instead, and drop Power Automate.**
GitHub Actions can send mail directly with Microsoft Graph or SMTP credentials
held as repository secrets. No license, no connector. The cost is that mail
delivery becomes coupled to the workflow that OPS-025 has just shown to be the
least reliable link in the chain, and it puts mail-sending credentials in the
data repository, which currently holds none and has no release gate (OPS-001).

**D. Keep the manual draft step.** It works today, every notification in
canonical was delivered this way, and the only thing it costs is that a person
must be at a desk. Legitimate as a deliberate choice rather than a default.

The decision is A versus D, with B worth checking only if A is refused and D is
unacceptable. C is listed for completeness and is not recommended while OPS-025
and OPS-001 are open.
