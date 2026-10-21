// Resolves once the element has a width and a height. A page loaded into a 0×0 window (an embed in
// a display:none iframe, a hidden browser pane) lays everything out at zero size until it's shown.
// Without ResizeObserver (Safari before 13.1) it doesn't wait.
export function whenSized(el, Observer = globalThis.ResizeObserver) {
  const sized = () => el.clientWidth > 0 && el.clientHeight > 0;
  if (sized() || !Observer) return Promise.resolve();
  return new Promise((resolve) => {
    const ro = new Observer(() => {
      if (!sized()) return;
      ro.disconnect();
      resolve();
    });
    ro.observe(el);
  });
}
