# Notice to send before merging CAO-OMS-Gateway OMS-053

**Status: drafted, not sent.** Sending is yours — I have not contacted anyone.

The decision was *enforce, and tell them first*, so this goes out **before**
`oms-053-enforce-password-change` is merged. Rev 41 is already live, so the
on-screen message described below is in place today; only the refusal itself is
still pending.

---

## Who it goes to

The five accounts that currently carry `mustChangePassword: true`. Read live
from `auth/users.json` on `CAO-OMS-Data@main`:

| Name | Address | Password issued |
|---|---|---|
| Maggie Scirica | margaret.scirica@advocatehealth.org | 6 Sept 2026, 09:16Z |
| Ari Ball | ariana.ball@advocatehealth.org | 6 Sept 2026, 09:16Z |
| Rachel Woodside | rachel.woodside@advocatehealth.org | 6 Sept 2026, 09:16Z |
| Victoria Ozokwelu | victoria.ozokwelu@advocatehealth.org | 6 Sept 2026, 09:16Z |
| Katie Darling | katie.darling@advocatehealth.org | 6 Sept 2026, 09:16Z |

Hossam Elsaie is not affected — that account already has its own password.

**Worth re-reading the list before sending.** If anyone has signed in and set a
password since this was written, their flag is already cleared and the notice
does not apply to them. Re-run the check in the appendix.

---

## Subject

    OMS | Action needed before you can save | Set your OMS password

---

## Body

> You were issued a starting password for OMS. It follows a pattern — your
> surname, then a fixed ending — so it is easy to say over the phone, and just
> as easy for someone else to guess. It was always meant to be replaced the
> first time you signed in.
>
> **From [DATE], OMS will not let an account save changes until that starting
> password has been replaced.** You will still be able to open OMS and read
> everything as usual. Only saving is affected.
>
> **It takes about twenty seconds.**
>
> 1. Sign out of OMS if you are signed in.
> 2. Sign in again at the usual address.
> 3. OMS will ask you to set a new password. It needs to be at least twelve
>    characters and different from the one you were given.
> 4. That is all — you are taken straight into OMS.
>
> **If you are already signed in when the change takes effect**, a save will be
> refused with a message reading *Password change required*. Nothing you typed
> is lost: it stays on the screen. Sign out, set the password, sign back in, and
> make the change again.
>
> **If you have already set your own password**, this does not apply to you and
> you need do nothing.
>
> Nobody, including an administrator, can look up an existing password — OMS
> stores a one-way scramble of it, so a forgotten one is reissued rather than
> recovered. If you get stuck, reply to this message and I will reissue.

---

## Notes for whoever sends it

- **Fill in `[DATE]`.** Give people a working day at least. The enforcement is a
  pull request merge, so the date is whenever you choose to merge it.
- **The subject carries `OMS`** per the standing rule, and states the action
  rather than the mechanism.
- The body deliberately does **not** say "for security reasons" or explain the
  guessable-pattern problem twice. It says what changes, when, and what to do.
- It does not mention that the flag was previously unenforced. That is true and
  it is in the revision log, but a notice asking five people for twenty seconds
  of their time is not the place to raise a question it does not answer.

---

## Appendix — re-check the list immediately before sending

```bash
cd CAO-OMS-Data && git pull
python -c "
import json
for a in json.load(open('auth/users.json',encoding='utf-8')):
    if a.get('mustChangePassword'): print(a['displayName'], a['id'])
"
```

Anyone still listed needs the notice. Anyone who has dropped off has already
set their password.
