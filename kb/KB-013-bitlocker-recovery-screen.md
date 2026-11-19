---
id: KB-013
title: BitLocker recovery screen at startup
category: Security
tags: [bitlocker, recovery key, blue screen recovery, encryption, enter recovery key, startup locked, filevault]
os: [windows]
ticket_category: identity
priority: HIGH
action: troubleshoot
---

# BitLocker recovery screen at startup

Use this when your Windows laptop starts on a blue **BitLocker recovery** screen asking for a 48-digit recovery key.

**Never paste or type your recovery key into chat, email or a ticket. IT will never ask you to share it.**

## Symptoms

- A blue screen saying "BitLocker recovery — Enter the recovery key for this drive"
- It appeared after a BIOS update, a new dock, or a change in startup settings
- It appears every time you restart

## Quick fixes

1. Unplug docks, USB drives and external keyboards, then restart. A connected device can trigger recovery mode.
2. On another device, sign in to {{sso_portal}} → **Devices** → your laptop's name ({{company}} asset tag) → **View BitLocker keys**. Check the Key ID on the blue screen matches the first characters shown.
3. Type the 48-digit key on the laptop yourself — don't send it to anyone.
4. Once Windows starts, restart once more. It should start normally.

## Advanced steps

1. If recovery appears after every restart, let pending Windows and BIOS updates finish, then restart twice.

## Escalate when

- You can't find the key at {{sso_portal}}, or the Key ID doesn't match
- The key is rejected
- Recovery keeps coming back after every restart
- You need to work urgently and don't have another device to look up the key — call {{helpdesk_phone}}
