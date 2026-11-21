import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEV_LOG } from "../playwright.config";

/** Seeded accounts (scripts/seed.ts). */
export const USERS = {
  employee: "ananya.sharma@minocy.example",
  networkAgent: "arjun.mehta@minocy.example",
  admin: "admin@minocy.example",
} as const;

function latestCode(email: string): string | null {
  let log: string;
  try {
    log = readFileSync(DEV_LOG, "utf8");
  } catch {
    return null;
  }
  const lines = log.split(/\r?\n/).filter((l) => l.includes(`to=${email}`) && /sign-in code: (\d{6})/.test(l));
  return lines.at(-1)?.match(/sign-in code: (\d{6})/)?.[1] ?? null;
}

/** Email-OTP sign-in, reading the code the dev server logs (no real email). */
export async function signIn(page: Page, email: string) {
  const before = latestCode(email);
  await page.goto("/login");
  await page.getByPlaceholder("you@minocy.example").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  let code: string | null = null;
  await expect
    .poll(
      () => {
        code = latestCode(email);
        return code && code !== before ? code : null;
      },
      { timeout: 20_000, message: `sign-in code for ${email} in ${DEV_LOG}` },
    )
    .not.toBeNull();
  await page.getByLabel("Sign-in code").fill(code!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}
