---
id: KB-005
title: MFA / Authenticator not working or new phone
category: Accounts
tags: [mfa, 2fa, authenticator, new phone, lost phone, verification code, approve sign in, otp not coming]
os: [windows, macos, linux]
ticket_category: identity
priority: HIGH
action: troubleshoot
---

# MFA / Authenticator not working or new phone

Use this when sign-in prompts don't arrive, codes are rejected, or you've changed or lost your phone.

**Never share an MFA code or approve a prompt you didn't start — not even for IT.**

## Symptoms

- No approval notification arrives on your phone
- The 6-digit code is rejected as invalid
- You've got a new phone and the Authenticator app is empty
- You've lost your phone

## Quick fixes

1. Open the Authenticator app directly — the prompt is often waiting inside even when no notification appeared.
2. Make sure your phone has internet (mobile data or Wi-Fi) and isn't in Do Not Disturb or battery-saver mode.
3. Check your phone's time is set automatically. Codes are time-based and fail if the clock is off.
4. If you still have your old phone, sign in at {{sso_portal}} → Security info → Add sign-in method, add the Authenticator on the new phone, then remove the old one.

## Advanced steps

1. Choose "Sign in another way" at the prompt and use a text message or call to your registered number, if you set one up.
2. Remove and re-add your {{company}} account in the Authenticator app using {{sso_portal}} → Security info.

## Escalate when

- You've lost your phone or it was stolen — raise as HIGH so IT can block old sign-in methods
- You no longer have any registered sign-in method
- You received an approval prompt you didn't start — deny it and raise as HIGH (possible account attack)
- Codes fail even with the correct phone time
