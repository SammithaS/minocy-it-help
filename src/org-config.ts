/**
 * Organisation constants. Used by the seed script and (Phase 2) to fill KB placeholders
 * such as {{company}}, {{vpn_name}} or {{helpdesk_phone}}. All dummy data.
 */
export const org = {
  company: "Minocy",
  emailDomain: "minocy.example",
  helpdeskPhone: "+91 80 4000 1234 (ext. 411)",
  wifiSsid: "Minocy-Corp",
  guestWifiSsid: "Minocy-Guest",
  vpnName: "Minocy Secure Connect",
  ssoPortal: "https://sso.minocy.example",
  softwareCentre: "Minocy Software Centre",
  timezone: "Asia/Kolkata",
  /** Working hours used for LOW-priority SLA (2 working days). */
  workingHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5] },
} as const;

export const TEAMS = [
  { id: "team-network", name: "Network", category: "network" },
  { id: "team-hardware", name: "Hardware", category: "hardware" },
  { id: "team-software", name: "Software", category: "software" },
  { id: "team-identity", name: "Identity & Access", category: "identity" },
  { id: "team-collab", name: "Collaboration", category: "collaboration" },
] as const;

export const TICKET_CATEGORIES = [
  "network",
  "hardware",
  "software",
  "identity",
  "collaboration",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
