// What a page shows when booting fails: what happened, the browser's message, and a way to retry.
// The document and reload are injected so it is tested without a browser.

export function showBootError(doc: Document, err: unknown, reload: () => void, what = 'The castle'): HTMLElement {
  const box = doc.createElement('div');
  box.className = 'boot-error';
  box.setAttribute('role', 'alert');
  const h = doc.createElement('h1');
  h.textContent = `${what} did not load`;
  const p = doc.createElement('p');
  const msg = err instanceof Error ? err.message : String(err);
  p.append('Reload to try again. If it keeps failing, try another browser, or add ?webgl to the address to use WebGL2. ');
  const code = doc.createElement('code');
  code.textContent = msg;
  p.append(code);
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = 'Reload';
  b.onclick = () => reload();
  box.append(h, p, b);
  doc.body.append(box);
  b.focus();
  return box;
}
