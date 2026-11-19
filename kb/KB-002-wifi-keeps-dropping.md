---
id: KB-002
title: Wi-Fi keeps dropping or won't connect
category: Network
tags: [wifi, wi-fi, wireless, disconnecting, dropping, no internet, slow internet, signal, wifi nahi chal raha, internet band]
os: [windows, macos]
ticket_category: network
priority: MEDIUM
action: troubleshoot
---

# Wi-Fi keeps dropping or won't connect

Use this when your laptop disconnects from office Wi-Fi, shows "No internet", or won't join **{{wifi_ssid}}** at all.

## Symptoms

- Wi-Fi disconnects every few minutes and reconnects on its own
- Connected, but the icon shows "No internet" or a yellow warning
- {{wifi_ssid}} doesn't appear in the list, or joining fails
- Video calls freeze while colleagues next to you are fine

## Quick fixes

1. Turn Wi-Fi off, wait 10 seconds, and turn it back on from the Wi-Fi icon in the taskbar (Windows) or menu bar (Mac).
2. Check you're on **{{wifi_ssid}}**, not **{{guest_wifi_ssid}}** or a phone hotspot. Guest Wi-Fi blocks internal sites.
3. Move closer to an open area or a meeting room, away from metal cabinets and lift lobbies, and see if the drops stop.
4. Restart your laptop. A full restart (not sleep) clears most stuck network adapters.
5. Forget the network and join again: on Windows go to Settings → Network & internet → Wi-Fi → Manage known networks → {{wifi_ssid}} → Forget; on Mac go to System Settings → Wi-Fi → (i) next to {{wifi_ssid}} → Forget This Network. Then reconnect and sign in with your {{company}} account.

## Advanced steps

1. Turn off power saving for Wi-Fi on Windows: Device Manager → Network adapters → your Wi-Fi adapter → Properties → Power Management → untick "Allow the computer to turn off this device to save power".
2. Run the network troubleshooter on Windows (Settings → System → Troubleshoot → Other troubleshooters → Network and Internet), or Wireless Diagnostics on Mac (hold Option, click the Wi-Fi icon → Open Wireless Diagnostics).
3. Install pending updates: Windows Update on Windows, or System Settings → General → Software Update on Mac. Wi-Fi driver fixes usually come this way.
4. If you use the VPN in the office, disconnect {{vpn_name}} — it isn't needed on {{wifi_ssid}} and can cause drops.

## Escalate when

- Several people in the same area lose Wi-Fi at the same time (raise as HIGH — likely an access point problem)
- Other devices work fine on {{wifi_ssid}} but your laptop still drops after all the steps above
- The Wi-Fi adapter is missing from the list or shows an error in Device Manager
- You were told your device certificate has expired or "authentication failed" keeps appearing
