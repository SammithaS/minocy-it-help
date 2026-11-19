---
id: KB-004
title: Forgot password or account locked
category: Accounts
tags: [password, forgot password, reset password, locked out, account locked, expired password, sign in, login, password bhool gaya]
os: [windows, macos, linux]
ticket_category: identity
priority: HIGH
action: password_reset
---

# Forgot password or account locked

Use this when you can't sign in to your {{company}} account because you forgot your password, it expired, or the account is locked after too many attempts.

**IT will never ask for your password or MFA code — not in chat, email or on the phone.**

## Symptoms

- "Your account has been locked" or "Too many sign-in attempts"
- "Your password has expired" at sign-in
- You've forgotten your password
- Your password works on one device but not another

## Quick fixes

1. Check Caps Lock and your keyboard language (for example, English vs Hindi input) before trying again.
2. If your account is locked, wait 15 minutes — it unlocks automatically. Don't keep retrying, as that resets the timer.
3. Reset your password yourself at {{sso_portal}} → "Forgot password". You'll verify with your Authenticator app or a code sent to your registered phone.
4. After resetting, sign in on your laptop first while connected to {{wifi_ssid}} or {{vpn_name}}, so the laptop learns the new password.
5. Update the new password on your phone's email and Wi-Fi settings, or they'll keep locking your account with the old one.

## Advanced steps

1. If you're working remotely and the laptop still wants the old password, sign in with the old one, connect to {{vpn_name}}, then lock (Windows + L) and unlock with the new password.
2. Check for old saved passwords: Credential Manager on Windows, or Keychain Access on Mac — remove entries for {{email_domain}} and sign in again.

## Escalate when

- You can't use self-service reset because you no longer have your registered phone or Authenticator app
- The account locks again within minutes of unlocking (something is still using the old password)
- You see sign-in alerts you don't recognise — treat as a security issue and raise as HIGH
- You're locked out and need access urgently for a customer or deadline
