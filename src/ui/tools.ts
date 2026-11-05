// The review tools panel: a titled column of small control groups (a choice, a slider, a list of
// actions, a picker) shared by the castle page, the test scenes and props.html. The document is
// injected; every control is a real button, input or select, so it works from the keyboard.

export interface ToolOption { id: string; label: string }

export type ToolsSection =
  /** one of a few, shown as a segmented row (camera mode) */
  | { kind: 'choice'; id: string; label: string; options: ToolOption[]; value: string; onChange(id: string): void }
  /** a slider with its value printed beside the label (time of day) */
  | { kind: 'range'; id: string; label: string; min: number; max: number; step: number; value: number; format(v: number): string; onInput(v: number): void }
  /** a grid of one-shot buttons (camera bookmarks) */
  | { kind: 'actions'; id: string; label: string; options: ToolOption[]; onPick(id: string): void }
  /** a long list behind a native picker (every prop kind) */
  | { kind: 'select'; id: string; label: string; placeholder: string; options: ToolOption[]; onPick(id: string): void };

export interface ToolsConfig { title: string; sections: ToolsSection[] }

export interface ToolsPanel {
  readonly el: HTMLElement;
  /** Reflect a value changed elsewhere (mode switched by a bookmark, time set by a hook). */
  set(id: string, value: string | number): void;
  /** Short status text in the header (fps). */
  setStat(text: string): void;
  /** The first control, for focus when the panel opens from the keyboard. */
  first(): HTMLElement | null;
}

/**
 * A mouse click leaves focus on the button, and the next Space (fly up) or Enter would press it
 * again; drop focus after mouse clicks but keep it for keyboard presses (their click has detail 0).
 */
const settle = (b: HTMLElement, e: MouseEvent) => { if (e.detail > 0) b.blur(); };

const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';

export function createToolsPanel(doc: Document, config: ToolsConfig, opts: { id?: string; onClose?: () => void } = {}): ToolsPanel {
  const el = doc.createElement('aside');
  el.className = 'tools';
  el.id = opts.id ?? 'tools';
  el.setAttribute('aria-label', config.title);
  const head = doc.createElement('header');
  head.className = 'tools-head';
  const title = doc.createElement('h2');
  title.textContent = config.title;
  const stat = doc.createElement('span');
  stat.className = 'tools-stat';
  head.append(title, stat);
  if (opts.onClose) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'tools-close';
    close.setAttribute('aria-label', `Close ${config.title.toLowerCase()} (\`)`);
    close.innerHTML = CLOSE_ICON;
    close.onclick = opts.onClose;
    head.append(close);
  }
  el.append(head);

  const setters = new Map<string, (v: string | number) => void>();
  let firstControl: HTMLElement | null = null;
  const note = (c: HTMLElement) => { firstControl ??= c; };

  for (const s of config.sections) {
    const group = doc.createElement('div');
    group.className = `tools-group tools-${s.kind}`;
    const label = doc.createElement('div');
    label.className = 'tools-label';
    label.id = `${el.id}-${s.id}`;
    label.textContent = s.label;
    group.append(label);
    if (s.kind === 'choice') {
      const row = doc.createElement('div');
      row.className = 'tools-seg';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-labelledby', label.id);
      const buttons = s.options.map((o) => {
        const b = doc.createElement('button');
        b.type = 'button'; b.textContent = o.label; b.dataset.id = o.id;
        b.onclick = (e) => { mark(o.id); s.onChange(o.id); settle(b, e); };
        note(b); row.append(b);
        return b;
      });
      const mark = (id: string | number) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.id === id)); };
      mark(s.value);
      setters.set(s.id, mark);
      group.append(row);
    } else if (s.kind === 'range') {
      const out = doc.createElement('output');
      out.className = 'tools-value';
      label.append(out);
      const input = doc.createElement('input');
      input.type = 'range';
      input.min = String(s.min); input.max = String(s.max); input.step = String(s.step);
      input.setAttribute('aria-labelledby', label.id);
      const show = (v: number) => { out.textContent = s.format(v); input.setAttribute('aria-valuetext', s.format(v)); };
      input.oninput = () => { const v = Number(input.value); show(v); s.onInput(v); };
      setters.set(s.id, (v) => { input.value = String(v); show(Number(v)); });
      input.value = String(s.value); show(s.value);
      note(input); group.append(input);
    } else if (s.kind === 'actions') {
      const grid = doc.createElement('div');
      grid.className = 'tools-list';
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-labelledby', label.id);
      for (const o of s.options) {
        const b = doc.createElement('button');
        b.type = 'button'; b.textContent = o.label;
        b.onclick = (e) => { s.onPick(o.id); settle(b, e); };
        note(b); grid.append(b);
      }
      group.append(grid);
    } else {
      const sel = doc.createElement('select');
      sel.setAttribute('aria-labelledby', label.id);
      const ph = doc.createElement('option');
      ph.value = ''; ph.textContent = s.placeholder;
      sel.append(ph);
      for (const o of s.options) { const op = doc.createElement('option'); op.value = o.id; op.textContent = o.label; sel.append(op); }
      sel.onchange = () => { if (sel.value) s.onPick(sel.value); };
      setters.set(s.id, (v) => { sel.value = String(v); });
      note(sel); group.append(sel);
    }
    el.append(group);
  }

  return {
    el,
    set(id, value) { setters.get(id)?.(value); },
    setStat(text) { stat.textContent = text; },
    first: () => firstControl,
  };
}
