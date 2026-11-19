---
id: KB-008
title: Printer not printing, paper jam or scan to email
category: Printing
tags: [printer, printing, print queue, paper jam, offline printer, scanner, scan to email, toner, printer nahi chal raha]
os: [windows, macos]
ticket_category: hardware
priority: LOW
action: troubleshoot
---

# Printer not printing, paper jam or scan to email

Use this when jobs get stuck in the queue, the printer shows as offline, paper jams, or scan to email doesn't arrive.

## Symptoms

- The job sits in the queue and never prints
- The printer shows "Offline" on your laptop
- Paper jam message on the printer screen
- Scans to email don't arrive

## Quick fixes

1. Check the printer's own screen for messages like paper empty, toner low or a jam, and fix what it says.
2. For a jam, open the doors the screen points to and gently pull the paper out in the direction it travels. Don't use tools or pull torn pieces hard.
3. Make sure your laptop is on {{wifi_ssid}} — office printers can't be reached from {{guest_wifi_ssid}} or from home without {{vpn_name}}.
4. Cancel stuck jobs and print again: Settings → Bluetooth & devices → Printers & scanners → your printer → Open print queue → Cancel all (Windows), or open the printer from the Dock and delete the jobs (Mac).
5. Release your job at the printer by tapping your ID card — secure printing holds jobs until you're there.

## Advanced steps

1. Remove the printer and add it again from {{software_centre}} (Windows) or Self Service (Mac) using the printer name on its label.
2. Restart the Print Spooler on Windows by restarting the laptop, then try a one-page test print.
3. For scan to email, check your spam/junk folder and make sure you typed your full @{{email_domain}} address.

## Escalate when

- The printer itself shows an error code or won't turn on
- The jam keeps coming back or paper is torn inside where you can't reach it
- Nobody can print to that printer
- Toner or supplies need replacing and there's no spare nearby
