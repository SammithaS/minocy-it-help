---
id: KB-003
title: VPN won't connect or times out
category: Network
tags: [vpn, remote access, work from home, timeout, connection failed, secure connect, vpn nahi lag raha]
os: [windows, macos]
ticket_category: network
priority: MEDIUM
action: troubleshoot
---

# VPN won't connect or times out

Use this when **{{vpn_name}}** fails with a timeout, keeps asking you to sign in, or connects but internal sites won't open.

## Symptoms

- "Connection timed out" or "Unable to reach the gateway" when connecting
- The VPN connects, then drops after a few minutes
- Connected, but internal sites and shared drives don't load
- Sign-in loops back to the login screen

## Quick fixes

1. Check your home internet first: open any public website. If that fails, restart your router — the VPN can't connect without internet.
2. Quit {{vpn_name}} completely (right-click its icon → Quit / Exit) and open it again, then connect.
3. Make sure your laptop's date and time are correct and set automatically. A wrong clock makes VPN sign-in fail.
4. Try a different network, such as a phone hotspot. Some hotel, café and home routers block VPN traffic.
5. Restart your laptop and connect to {{vpn_name}} before opening other apps.

## Advanced steps

1. Approve the sign-in prompt on your Authenticator app quickly — the VPN times out if MFA isn't approved within about 60 seconds. Never share the code with anyone, including IT.
2. Update {{vpn_name}} from {{software_centre}} (Windows) or Self Service (Mac) and reconnect.
3. Turn off other VPNs or security tools you installed yourself (personal VPNs, ad-blocking DNS) and try again.
4. If internal sites don't load while connected, disconnect and reconnect once, then try opening the site by its full address.

## Escalate when

- You've tried a different network and the VPN still times out
- The error says your account or device "is not authorised" or "not compliant"
- Many remote colleagues report the same problem at the same time (raise as HIGH)
- You can't work at all and have a deadline today — say so in the ticket
