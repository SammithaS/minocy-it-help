import { expect, test } from "@playwright/test";
import { signIn, USERS } from "./helpers";

test.describe("employee portal", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USERS.employee);
  });

  test("home: hero, quick actions and the docked chat", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "What's not working today?" })).toBeVisible();
    for (const tile of ["Reset password", "Request access", "Wi-Fi & VPN", "Raise a ticket"]) {
      await expect(page.getByRole("button", { name: new RegExp(tile) })).toBeVisible();
    }
    // The launcher opens the dock; Esc minimises it.
    await page.getByRole("button", { name: /Ask IT|Continue chat/ }).last().click();
    const dock = page.getByRole("dialog", { name: "Ask IT" });
    await expect(dock).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dock).toBeHidden();
  });

  test("a quick-action tile routes straight to the Access agent (rules, no model)", async ({ page }) => {
    await page.getByRole("button", { name: /Request access/ }).click();
    const dock = page.getByRole("dialog", { name: "Ask IT" });
    await expect(dock.getByText("I need access to an app")).toBeVisible();
    // The hand-off chip is written before the model replies.
    await expect(dock.getByText("Access agent", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(dock.getByText(/needs the app name/)).toBeVisible();
  });

  test("a troubleshooting chip starts the guide with a step card", async ({ page }) => {
    await page.getByRole("button", { name: "VPN timeout" }).click();
    const dock = page.getByRole("dialog", { name: "Ask IT" });
    await expect(dock.getByText("Knowledge agent", { exact: true })).toBeVisible({ timeout: 60_000 });
    // The step card needs one supervisor model call (Gemini / Workers AI).
    await expect(dock.getByText(/Step 1 of \d+/)).toBeVisible({ timeout: 90_000 });
    await expect(dock.getByRole("button", { name: "That fixed it" })).toBeVisible();
  });

  test("my tickets & requests page", async ({ page }) => {
    await page.getByRole("link", { name: "My tickets" }).first().click();
    await expect(page.getByRole("heading", { name: /My tickets/ })).toBeVisible();
  });
});
