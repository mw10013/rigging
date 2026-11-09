import { expect, test } from "playwright/test";

test("the served page counts clicks", async ({ page }) => {
  await page.goto("/");
  const button = page.getByRole("button");
  await button.click();
  await expect(button).toHaveText("Clicked 1 times");
});
