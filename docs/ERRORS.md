# Errors and emergency controls

## What people see when something goes wrong

NavShiksha never shows a blank page or the browser's own error. Every problem gets a designed page
or message with:

- a **number** they can quote, such as `NS-404`;
- a plain sentence saying what happened and what to do next;
- for an unexpected fault, a **reference**, such as `E-MH2K9Q1-7F2A` (made on the server) or
  `C-MH2K9Q1-X3B1` (made in the browser). The helpdesk finds it under **Emergency controls → Error log**.

| Number | Meaning | What the person is told |
|---|---|---|
| NS-000 | The server could not be reached (no internet, or the server is down) | Check the connection and try again; nothing typed is lost |
| NS-400 | The request could not be read | Go back and try again |
| NS-401 | The session ended | They are taken back to sign-in, with the reason |
| NS-403 | Not part of their role or outside their schools | Ask the principal or NES for the duty |
| NS-404 | No such page or record | Use the menu |
| NS-409 | Clashes with something already saved (for example, someone else changed it first) | Reload and try again |
| NS-422 | Some details are not valid | The fields that need attention are named |
| NS-423 | Read only is on (an emergency control) | They can look but not change; what they typed stays on screen |
| NS-429 | Too many tries | Wait a minute |
| NS-500 | An unexpected fault on the server; nothing was saved | Try again; if it repeats, raise a ticket quoting the reference |
| NS-503 | Paused by an emergency control (maintenance, stopped, payments, sign-ins or public pages) | Nothing is lost; try again later |
| NS-APP | A screen crashed in the browser | Reload; the rest of the app keeps working |

The server's error replies always have the same shape:

```json
{ "error": { "code": "not_found", "number": "NS-404", "message": "…", "details": [], "ref": "E-…" } }
```

`code` is for programs (for example `read_only`, `payments_paused`, `forbidden`), `number` is for
people, and `ref` appears only on unexpected faults.

**Report the problem.** On an unexpected fault the page has a *Report the problem* button that opens
a help ticket with the number, reference and page already filled in.

## Emergency controls (kill switches)

NES opens **Rules → Emergency controls**. No control deletes or changes data; each stops new work at
the door, so anything already being saved finishes and nothing is half-saved. Each needs a reason,
which users see and the history keeps for good.

| Control | What stops | What still works |
|---|---|---|
| Maintenance | Everyone sees a maintenance page | NES can sign in and check the system |
| Read only | Every change is refused (NS-423) | Looking at everything; the bank's payment confirmations |
| Pause payments | No new fee or application payment starts | Payments already made are still confirmed |
| Pause public pages | School websites, Careers, alumni portal show a maintenance page | Staff and parent apps |
| Pause sign-ins | Nobody new can sign in | People already signed in carry on |
| Hold outgoing messages | Emails and SMS wait in the queue | They go out when this is turned off |
| Sign everyone out | Ends every session except yours | Saved work is kept |
| **Stop all traffic** | Every page and request, for everyone, including NES | Only the health check and the bank's confirmations of payments already made |

Background jobs (reminders, the message queue) wait during maintenance and while stopped.

### Stop all traffic (lockdown)

For an attack. NES types STOP to confirm. The stop is a file named `LOCKDOWN` beside the database
folder (`server/data/LOCKDOWN`, or beside `NES_DATA_DIR` if that is set, or wherever
`NES_LOCKDOWN_FILE` points). It can be lifted **only on the server**:

```bash
npm run unlock
```

so a stolen NES password cannot undo it. The operator can also stop everything without the app by
creating that file, or by starting the server with `NES_LOCKDOWN=1`. Within two seconds of
`npm run unlock`, NavShiksha takes traffic again.

When stopping a server for an update, always stop it with Ctrl+C (or `SIGTERM`): the database is
closed cleanly first. Never kill it hard, and never run two servers on the same database folder.

## After an update

The page itself is never kept by browsers (`cache-control: no-cache`); the app's files carry their
content in their names and are kept for good. So after an update everyone gets the new version on
their next visit. A tab left open from before the update that asks for an old file gets a 404 for
that file, never a page in its place. If the app cannot start at all, the page shows "NavShiksha
could not start" (NS-APP) with a Reload button after eight seconds, instead of staying blank.

## What each person sees

Every screen shows only the actions the person may take. The server sends each signed-in person
their permissions (`GET /me` → `can`), taken from the same table it checks on every request
(`server/src/modules/access.ts`): those from the role hold in all their schools, those from a duty
only at that school. The server still checks every request, so a hidden button is never the only
protection.
