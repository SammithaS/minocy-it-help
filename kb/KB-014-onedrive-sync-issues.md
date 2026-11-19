---
id: KB-014
title: OneDrive or SharePoint files not syncing
category: Collaboration
tags: [onedrive, sharepoint, sync, files not syncing, sync pending, red x, cloud files, backup, file conflict, storage full]
os: [windows, macos]
ticket_category: collaboration
priority: MEDIUM
action: troubleshoot
---

# OneDrive or SharePoint files not syncing

Use this when files show a red X or "Sync pending", changes don't appear for colleagues, or OneDrive says it's full.

## Symptoms

- Red X or circular arrows on files and folders that never finish
- Changes you made don't appear on the web or for colleagues
- Duplicate files with your laptop name added to the file name
- "OneDrive is full" or "Can't sync this file"

## Quick fixes

1. Click the OneDrive cloud icon in the taskbar (Windows) or menu bar (Mac) and read the message — it usually names the problem file.
2. If OneDrive is paused, click **Resume syncing**.
3. Close the file in every app (Excel, Word) — files that are open can't sync.
4. Rename files with very long names or characters like `" * : < > ? / \ |` and move them out of very deep folders.
5. Quit OneDrive (cloud icon → Settings/gear → Quit OneDrive), open it again from the Start menu or Applications, and sign in with your {{company}} account if asked.

## Advanced steps

1. Check you're signed in with your @{{email_domain}} account, not a personal Microsoft account.
2. Free up space: right-click big folders → **Free up space** so they stay in the cloud only.
3. If you see duplicate "conflict" copies, open both, keep the right one, and delete the other.

## Escalate when

- Files you saved are missing on the web and on your laptop (don't delete anything — raise as HIGH)
- OneDrive storage is full and you need more space
- Sync is stuck for more than a day after the steps above
- You're asked to restore files that were deleted or overwritten
