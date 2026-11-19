---
id: KB-019
title: Can't open a shared or mapped network drive
category: Network
tags: [shared drive, network drive, mapped drive, file server, s drive, finance drive, path not found, smb]
os: [windows, macos]
ticket_category: network
priority: MEDIUM
action: troubleshoot
---

# Can't open a shared or mapped network drive

Use this when a mapped drive (like S: or the Finance drive) shows a red X, says "path not found", or asks for a password repeatedly.

## Symptoms

- A mapped drive shows a red X in File Explorer
- "Windows cannot access \\files\…" or "The network path was not found"
- On Mac, "There was a problem connecting to the server"
- The drive keeps asking for your username and password

## Quick fixes

1. Make sure you're on {{wifi_ssid}} in the office, or connected to {{vpn_name}} at home — shared drives only work on the {{company}} network.
2. Open File Explorer and double-click the drive; a red X often clears once you open it.
3. Restart your laptop while connected to the office network or VPN, so drives map again at sign-in.
4. If it asks for a password, sign in with your full {{company}} email address and your normal password.

## Advanced steps

1. Reconnect the drive on Windows: File Explorer → This PC → right-click the drive → Disconnect, then Map network drive with the path your team uses.
2. On Mac, open Finder → Go → Connect to Server and enter the smb:// path your team uses.
3. Clear saved credentials for the file server in Credential Manager (Windows) or Keychain Access (Mac), then connect again.

## Escalate when

- Colleagues can open the same drive but you get "Access denied" (raise an access request instead — see the access request guide)
- Nobody in your team can reach the drive (raise as HIGH)
- Files or folders you had yesterday are missing
