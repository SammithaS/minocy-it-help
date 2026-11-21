import { createElement } from "react";
import type { AppEnv } from "../env";
import type { OutgoingEmail } from "./send";
import { TicketEmail } from "./templates/ticket-email";

/** 24 h after the assistant fixed something: "Is it still working?" with a link back to the chat. */
export function chatFollowUp(env: AppEnv, to: string, name: string, topic: string, sessionId: string): OutgoingEmail {
  const chat = `${env.APP_URL}/chat/${sessionId}`;
  return {
    channel: "email_employee",
    kind: "chat_followup",
    to,
    subject: `Is ${topic} still working?`,
    element: createElement(TicketEmail, {
      appUrl: env.APP_URL,
      preview: "A quick check from IT Help",
      eyebrow: "Follow-up",
      heading: `Is ${topic} still working?`,
      paragraphs: [
        `Hi ${name.split(" ")[0]}, yesterday the IT assistant helped you fix this. Just checking it's held up.`,
        `If it's acting up again, open the chat — I'll pick up where we left off and can raise a ticket with everything we already tried.`,
      ],
      buttons: [{ label: "Open the chat", href: chat }],
      footer: "No need to reply if all is well.",
    }),
  };
}
