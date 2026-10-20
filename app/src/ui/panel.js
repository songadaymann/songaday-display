// The left sidebar: search results, and lists from the crypto module. It slides over the wall
// (the wall never resizes). Opening new content closes the old one, calling its onClose.
export function createPanel(el) {
  const title = el.querySelector('.panel-title');
  const body = el.querySelector('.panel-body');
  let onClose = null;

  function close() {
    if (!el.classList.contains('open')) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    const cb = onClose;
    onClose = null;
    body.replaceChildren();
    cb?.();
  }

  function open(text, content, opts = {}) {
    if (el.classList.contains('open')) {
      const cb = onClose;
      onClose = null;
      cb?.();
    }
    title.textContent = text;
    body.replaceChildren(content);
    el.scrollTop = 0;
    body.scrollTop = 0;
    onClose = opts.onClose || null;
    el.inert = false;
    el.removeAttribute('aria-hidden');
    el.classList.add('open');
    return {
      el: body,
      close: () => body.contains(content) && close(),
      setTitle: (t) => body.contains(content) && (title.textContent = t),
    };
  }

  el.querySelector('.panel-close').addEventListener('click', close);
  el.inert = true;
  return {
    open,
    close,
    get isOpen() {
      return el.classList.contains('open');
    },
  };
}
