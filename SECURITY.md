# Security policy

## Reporting a vulnerability

Email **security@YOUR-DOMAIN** (replace before publishing; until then,
use the repository owner's address) with what you found and how to
reproduce it. Please don't open a public issue or test against other
people's accounts.

What happens next:

- You'll get an acknowledgement within 3 working days.
- We'll confirm whether it's real and agree on a fix timeline: critical
  issues (account takeover, reading other users' data) within 7 days,
  others within 30.
- We'll tell you when it's fixed and credit you in the changelog if you'd
  like.

We won't pursue legal action over good-faith research that stays within
your own account, avoids degrading the service, and gives us reasonable
time to fix the problem before you disclose it.

## What's in place

See OPERATIONS.md ("Security controls") for the current list, and the
backend test suite (`backend/test/`) for the behaviour that's enforced in CI.
