import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "@react-email/components";

/** Option B colours, inlined for email clients. */
const C = {
  brand: "#0B6E76",
  brand50: "#E3F2F1",
  brand800: "#08555B",
  sun: "#FFB547",
  ink: "#17262A",
  muted: "#55666B",
  line: "#E8EEED",
  canvas: "#F3F6F5",
  critical: "#B91C1C",
  criticalBg: "#FEE2E2",
};

export interface EmailButton {
  label: string;
  href: string;
  tone?: "primary" | "sun" | "outline";
}

export interface TicketEmailProps {
  preview: string;
  /** Small label above the heading, e.g. "INC-1031 · High · Network". */
  eyebrow?: string;
  heading: string;
  paragraphs: string[];
  /** Key/value rows (Requester, Device, Priority, SLA due…). */
  details?: [string, string][];
  stepsTried?: { text: string; result: string }[];
  callout?: { tone: "critical" | "info"; text: string };
  buttons?: EmailButton[];
  footer?: string;
  appUrl: string;
}

const button = (tone: EmailButton["tone"] = "primary") => ({
  display: "inline-block",
  padding: "12px 22px",
  borderRadius: "999px",
  fontWeight: 700,
  fontSize: "14px",
  textDecoration: "none",
  marginRight: "8px",
  marginBottom: "8px",
  ...(tone === "sun"
    ? { background: C.sun, color: C.ink }
    : tone === "outline"
      ? { background: "#FFFFFF", color: C.ink, border: `1px solid ${C.line}` }
      : { background: C.brand, color: "#FFFFFF" }),
});

/** Strips the KB's **bold** markers for plain email text. */
const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

export function TicketEmail(p: TicketEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{p.preview}</Preview>
      <Body style={{ background: C.canvas, fontFamily: "'Plus Jakarta Sans', Segoe UI, Arial, sans-serif", margin: 0, padding: "24px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "0 16px" }}>
          <Section style={{ background: C.brand, borderRadius: "22px 22px 0 0", padding: "18px 24px" }}>
            <Text style={{ color: "#FFFFFF", fontWeight: 800, fontSize: "16px", margin: 0 }}>Minocy IT Help</Text>
          </Section>
          <Section style={{ background: "#FFFFFF", borderRadius: "0 0 22px 22px", padding: "24px", border: `1px solid ${C.line}`, borderTop: "none" }}>
            {p.eyebrow && <Text style={{ color: C.brand800, fontSize: "12px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", margin: "0 0 6px" }}>{p.eyebrow}</Text>}
            <Heading as="h1" style={{ color: C.ink, fontSize: "22px", lineHeight: "1.3", margin: "0 0 12px" }}>
              {p.heading}
            </Heading>
            {p.callout && (
              <Text
                style={{
                  background: p.callout.tone === "critical" ? C.criticalBg : C.brand50,
                  color: p.callout.tone === "critical" ? C.critical : C.brand800,
                  borderRadius: "14px",
                  padding: "12px 14px",
                  fontSize: "14px",
                  fontWeight: 600,
                  margin: "0 0 14px",
                }}
              >
                {p.callout.text}
              </Text>
            )}
            {p.paragraphs.map((t, i) => (
              <Text key={i} style={{ color: C.ink, fontSize: "15px", lineHeight: "1.6", margin: "0 0 12px", whiteSpace: "pre-line" }}>
                {plain(t)}
              </Text>
            ))}
            {p.details && p.details.length > 0 && (
              <Section style={{ background: C.canvas, borderRadius: "14px", padding: "12px 16px", margin: "4px 0 14px" }}>
                {p.details.map(([k, v]) => (
                  <Text key={k} style={{ fontSize: "14px", color: C.ink, margin: "4px 0" }}>
                    <span style={{ color: C.muted }}>{k}: </span>
                    {v}
                  </Text>
                ))}
              </Section>
            )}
            {p.stepsTried && p.stepsTried.length > 0 && (
              <>
                <Text style={{ fontSize: "14px", fontWeight: 700, color: C.ink, margin: "8px 0 4px" }}>Already tried with the assistant</Text>
                {p.stepsTried.map((s, i) => (
                  <Text key={i} style={{ fontSize: "14px", color: C.ink, margin: "2px 0" }}>
                    {s.result === "worked" ? "✓" : "✗"} {plain(s.text)}
                  </Text>
                ))}
              </>
            )}
            {p.buttons && p.buttons.length > 0 && (
              <Section style={{ margin: "18px 0 4px" }}>
                {p.buttons.map((b) => (
                  <Button key={b.href} href={b.href} style={button(b.tone)}>
                    {b.label}
                  </Button>
                ))}
              </Section>
            )}
            <Hr style={{ borderColor: C.line, margin: "18px 0 12px" }} />
            <Text style={{ fontSize: "12px", color: C.muted, margin: 0 }}>
              {p.footer ?? "Reply to this email to add a comment to the ticket."}{" "}
              <Link href={p.appUrl} style={{ color: C.brand }}>
                Minocy IT Help
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
