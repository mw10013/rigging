import { mountCounter } from "./counter.ts";

const app = document.querySelector<HTMLElement>("#app");
if (app !== null) mountCounter(app);
