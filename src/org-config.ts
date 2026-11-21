/**
 * Organisation constants. Used by the seed script and to fill KB placeholders
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

/** `{{placeholder}}` values substituted into kb/*.md at ingestion time. */
export const kbPlaceholders: Record<string, string> = {
  company: org.company,
  email_domain: org.emailDomain,
  helpdesk_phone: org.helpdeskPhone,
  wifi_ssid: org.wifiSsid,
  guest_wifi_ssid: org.guestWifiSsid,
  vpn_name: org.vpnName,
  sso_portal: org.ssoPortal,
  software_centre: org.softwareCentre,
};

export function fillPlaceholders(text: string): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => kbPlaceholders[key] ?? match);
}

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
