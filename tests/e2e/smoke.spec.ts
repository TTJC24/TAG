import { test, expect } from "@playwright/test";

test("home page renders the Phase 1 scaffold marker", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /L10 meeting platform/i }),
  ).toBeVisible();
});
