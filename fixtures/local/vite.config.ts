import { browserProject } from "@mw10013/rigging/core/browser-test";
import { serverEndpoint } from "@mw10013/rigging/core/server-endpoint";
import {
  TEST_RESULTS_GLOB,
  testRun,
  unitProject,
} from "@mw10013/rigging/core/test";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [serverEndpoint()],
  server: { watch: { ignored: [TEST_RESULTS_GLOB] } },
  test: {
    ...testRun(import.meta.dirname),
    projects: [unitProject(), browserProject()],
  },
});
