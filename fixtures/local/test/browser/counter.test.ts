import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { mountCounter } from "#src/counter.ts";

it("counts clicks in Chromium", async () => {
  mountCounter(document.body);
  const button = page.getByRole("button");
  await button.click();
  await expect.element(button).toHaveTextContent("Clicked 1 times");
});
