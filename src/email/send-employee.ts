import type { AppEnv } from "../env";

export interface EmployeeEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends an email to an employee through Resend.
 * Without RESEND_API_KEY (local dev) the email is logged instead, so the OTP is visible in the terminal.
 */
export async function sendEmployeeEmail(env: AppEnv, email: EmployeeEmail): Promise<"sent" | "logged"> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${email.to} subject="${email.subject}"\n${email.text}`);
    return "logged";
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  }
  return "sent";
}
