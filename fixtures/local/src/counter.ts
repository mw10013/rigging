export const label = (count: number) => `Clicked ${String(count)} times`;

export const mountCounter = (parent: HTMLElement) => {
  let count = 0;
  const button = document.createElement("button");
  button.textContent = label(count);
  button.addEventListener("click", () => {
    count += 1;
    button.textContent = label(count);
  });
  parent.append(button);
  return button;
};
