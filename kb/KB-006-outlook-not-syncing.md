---
id: KB-006
title: Outlook not sending, receiving or syncing email
category: Email
tags: [outlook, email, not receiving email, stuck in outbox, mailbox full, sync, disconnected, emails not coming, mail nahi aa raha]
os: [windows, macos]
ticket_category: collaboration
priority: MEDIUM
action: troubleshoot
---

# Outlook not sending, receiving or syncing email

Use this when new emails don't arrive, messages sit in the Outbox, or Outlook says "Disconnected" or "Working offline".

## Symptoms

- No new emails for a while, but colleagues have received theirs
- Emails stuck in the Outbox
- "Disconnected", "Working offline" or "Trying to connect" at the bottom of Outlook
- "Your mailbox is full" warning

## Quick fixes

1. Check whether email works in the browser at outlook.office.com with your {{company}} account. If it does, the problem is only on your laptop.
2. Make sure Outlook isn't set to offline: Send/Receive tab → turn off **Work Offline** (classic Outlook), or check the status bar in new Outlook.
3. Close Outlook fully and open it again. If it won't close, restart the laptop.
4. If a message is stuck in the Outbox, open it, remove very large attachments (over 25 MB — share a OneDrive link instead) and send again.
5. If your mailbox is full, empty Deleted Items and Junk, and delete large old emails with attachments.

## Advanced steps

1. Check your Junk folder and the Other tab in the Focused inbox for missing emails.
2. Look for rules that move emails away: File → Manage Rules & Alerts (classic) or Settings → Mail → Rules.
3. Install pending Office updates from {{software_centre}} (Windows) or Microsoft AutoUpdate (Mac), then restart Outlook.

## Escalate when

- Email doesn't work in the browser either (likely an account or service problem)
- Several people in your team aren't receiving email (raise as HIGH)
- Outlook keeps asking for your password even after you sign in
- Your mailbox is full and you can't free enough space
