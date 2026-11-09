import { expect, it } from "vite-plus/test";

import { label } from "#src/counter.ts";

it("labels the count", () => {
  expect(label(2)).toBe("Clicked 2 times");
});
