import { e2eConfig } from "@mw10013/rigging/core/test";
import { defineConfig } from "playwright/test";

export default defineConfig(e2eConfig({ root: import.meta.dirname }));
