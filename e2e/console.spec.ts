import { expect, test } from "@playwright/test";
import { signIn, USERS } from "./helpers";

test.describe("IT console", () => {
  test("agent: filter the queue, open a ticket, add an internal note", async ({ page }) => {
    await signIn(page, USERS.networkAgent);
    await page.goto("/console");
    await expect(page.getByRole("heading", { name: "IT console" })).toBeVisible();

    // Raise a fresh ticket through the API as the agent's team would see it… instead, use the portal form path:
    // the queue may be empty after a db reset, so assert the filters work either way.
    await page.getByLabel("Priority").selectOption("HIGH");
    await expect(page).toHaveURL(/priority=HIGH/);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/priority=/);

    const first = page.locator("a[href^='/tickets/INC-']").first();
    if (!(await first.count())) test.skip(true, "No tickets in the Network queue after a fresh seed");
    await first.click();
    await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible();
    const note = `e2e note ${Date.now()}`;
    await page.getByLabel("Reply or add a note").fill(note);
    await page.getByLabel("Internal note (IT only)").check();
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText(note)).toBeVisible();
    await expect(page.getByText("internal note").last()).toBeVisible();
  });

  test("admin: analytics, settings, knowledge base and Connect Claude", async ({ page }) => {
    await signIn(page, USERS.admin);

    await page.goto("/console/analytics");
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await expect(page.getByText("Solved by the assistant")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    await page.goto("/console/settings");
    await expect(page.getByRole("heading", { name: "Routing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await page.goto("/console/knowledge?tab=articles");
    await page.getByRole("link", { name: /KB-002/ }).click();
    await expect(page.getByText(/Looks good · \d+ steps?/)).toBeVisible();
    // Breaking the structure is caught before saving.
    const body = page.getByLabel(/Guide \(markdown/);
    await body.fill((await body.inputValue()).replace("## Symptoms", "## Signs"));
    await expect(page.getByText(/sections must be/)).toBeVisible();

    await page.goto("/console/connect");
    await expect(page.getByRole("heading", { name: /Connect Claude/ })).toBeVisible();
    await expect(page.getByText(/claude mcp add --transport http minocy-itops/)).toBeVisible();
  });
});
