---
id: KB-016
title: Suspicious email or clicked a phishing link
category: Security
tags: [phishing, suspicious email, scam, fake email, clicked link, malware, hacked, spam, gift card request]
os: [windows, macos, linux]
ticket_category: identity
priority: HIGH
action: troubleshoot
---

# Suspicious email or clicked a phishing link

Use this when an email looks fake, asks for your password, payment or gift cards, or you've already clicked a link or opened an attachment you're unsure about.

## Symptoms

- The sender's address doesn't match the name (for example "CEO" from a Gmail address)
- Urgent requests for payment, gift cards, bank changes or your password
- A link to a sign-in page that isn't {{sso_portal}}
- An unexpected attachment, especially .zip, .html or Office files asking to "enable content"

## Quick fixes

1. Don't click links, open attachments or reply. If you're unsure, it's fine to ask IT first.
2. Report it with the **Report phishing** button in Outlook (or forward it as an attachment to IT), then delete it.
3. If someone you know seems to have sent it, check with them by phone or Teams — not by replying to the email.

## Advanced steps

1. If you clicked a link but didn't enter anything, close the browser tab and run a quick scan with Microsoft Defender (Windows Security → Virus & threat protection → Quick scan).
2. If you entered your password, change it immediately at {{sso_portal}} from a device you trust, then raise a ticket.

## Escalate when

- You entered your password, an MFA code or payment details on the page — raise as CRITICAL right away
- You opened an attachment and enabled macros or content
- Your laptop is acting strangely after clicking (pop-ups, new programs, files renamed) — disconnect from Wi-Fi and raise as CRITICAL
- Money was transferred or bank details were changed because of the email
