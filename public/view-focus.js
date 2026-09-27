export function revealWithInitialFocus(view, focusTarget) {
  const firstEntry = view.classList.contains("hidden");
  view.classList.remove("hidden");
  if (firstEntry) focusTarget.focus();
  return firstEntry;
}
