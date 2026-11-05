// In-game HUD (impeccable, Experience mode: the world leads, the UI recedes). One root element over
// the canvas with: a centre dot that rings when something usable is under it, the use prompt, a
// help line while the mouse is free, a controls card that shows once on the first pointer lock and
// fades, toasts, and the review tools panel (` toggles it, H shows the controls again).
// The document, key source and timers are injected, so tests drive it with happy-dom and fakes.
import type { HelpItem } from './help';
import { parseHelp } from './help';
import { createToolsPanel, type ToolsConfig, type ToolsPanel } from './tools';

/** Where key presses come from (window in the browser). */
export interface KeySource {
  addEventListener(type: 'keydown', l: (e: KeyLike) => void): void;
  removeEventListener(type: 'keydown', l: (e: KeyLike) => void): void;
}
export interface KeyLike { code: string; repeat?: boolean; target?: unknown; preventDefault?(): void }
export interface Timers { set(f: () => void, ms: number): number; clear(id: number): void }

export interface HudDeps {
  doc: Document;
  keys: KeySource;
  timers: Timers;
  reducedMotion?: boolean;
  /** Where the HUD mounts; default doc.body. */
  parent?: HTMLElement;
}

export interface HudOptions {
  /** Called when the tools open from the keyboard while the mouse is captured (release it there). */
  onToolsOpen?: () => void;
  /** How long the controls card stays before it fades (ms). */
  cardMs?: number;
}

/** The interaction module's view contract (src/game/interact.ts PromptView). */
export interface PromptSink { show(label: string | null): void; dispose(): void }

export interface Hud {
  readonly root: HTMLElement;
  /** Controls for the current mode, as key + action items or a "WASD walk · E use" string. */
  setHelp(help: string | readonly HelpItem[]): void;
  /** The use prompt under the crosshair ("Open door"), or null to hide it. */
  setPrompt(text: string | null, key?: string): void;
  /** Mouse captured: show the crosshair, hide the help line, and the first time show the controls card. */
  setLocked(locked: boolean): void;
  /** A short message near the bottom that fades by itself. */
  toast(text: string, ms?: number): void;
  /** Show the controls card now (H); it fades after `holdMs` (default cardMs), never if Infinity. */
  showControls(holdMs?: number): void;
  /** Mount the review tools panel (replaces any earlier one). */
  tools(config: ToolsConfig, open?: boolean): ToolsPanel;
  setToolsOpen(open: boolean): void;
  readonly toolsOpen: boolean;
  readonly locked: boolean;
  /** Adapter for createInteraction({ view }). */
  readonly promptView: PromptSink;
  dispose(): void;
}

const FADE_MS = 600;

function keycaps(doc: Document, parent: HTMLElement, items: readonly HelpItem[], tag: 'span' | 'li') {
  parent.textContent = '';
  for (const it of items) {
    const row = doc.createElement(tag);
    row.className = 'hint';
    if (it.keys) {
      const keys = doc.createElement('span');
      keys.className = 'hint-keys';
      row.append(keys);
      for (const [i, k] of it.keys.split('/').entries()) {
        if (i) keys.append(doc.createTextNode('/'));
        const kbd = doc.createElement('kbd');
        kbd.textContent = k;
        if (/^[^A-Za-z0-9]$/.test(k)) kbd.className = 'glyph';
        keys.append(kbd);
      }
    }
    const a = doc.createElement('span');
    a.className = 'hint-action';
    a.textContent = it.action;
    row.append(a);
    parent.append(row);
  }
}

export function createHud(d: HudDeps, o: HudOptions = {}): Hud {
  const { doc, timers } = d;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
    const e = doc.createElement(tag); e.className = cls; parent.append(e); return e;
  };
  const root = doc.createElement('div');
  root.id = 'hud';
  root.className = 'hud';
  (d.parent ?? doc.body).append(root);

  // the ids #crosshair and #help are kept so older code that looks them up still finds them
  const xhair = el('div', 'hud-xhair', root); xhair.id = 'crosshair'; xhair.setAttribute('aria-hidden', 'true');
  const prompt = el('div', 'hud-prompt', root); prompt.setAttribute('role', 'status'); prompt.setAttribute('aria-live', 'polite');
  const promptKey = el('kbd', '', prompt); const promptText = el('span', '', prompt);
  const toastEl = el('div', 'hud-toast', root); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
  const help = el('div', 'hud-help', root); help.id = 'help';
  const card = el('section', 'hud-card', root); card.setAttribute('aria-label', 'Controls'); card.hidden = true;
  el('h2', '', card).textContent = 'Controls';
  const cardList = el('ul', '', card);
  const toggle = el('button', 'hud-toggle', root);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.hidden = true;
  toggle.innerHTML = '<kbd>`</kbd><span>Tools</span>';

  let items: readonly HelpItem[] = [];
  let locked = false, toolsOpen = false, cardSeen = false, panel: ToolsPanel | null = null;
  let shownPrompt: string | null = null;
  const cardTimers: number[] = [];
  let toastTimer: number | null = null;

  const sync = () => {
    root.classList.toggle('is-locked', locked);
    xhair.hidden = !locked;
    help.hidden = locked || items.length === 0;
    toggle.hidden = !panel || toolsOpen || locked;
    toggle.setAttribute('aria-expanded', String(toolsOpen));
    if (panel) panel.el.hidden = !toolsOpen;
  };

  const clearCard = () => { while (cardTimers.length) timers.clear(cardTimers.pop()!); };
  const showControls = (hold = o.cardMs ?? 4500) => {
    if (!items.length) return;
    keycaps(doc, cardList, items, 'li');
    clearCard();
    card.hidden = false;
    card.classList.remove('is-out');
    if (hold === Infinity) return;
    cardTimers.push(timers.set(() => {
      card.classList.add('is-out');
      cardTimers.push(timers.set(() => { card.hidden = true; card.classList.remove('is-out'); }, d.reducedMotion ? 0 : FADE_MS));
    }, hold));
  };

  const setToolsOpen = (open: boolean) => {
    if (!panel || open === toolsOpen) return;
    toolsOpen = open;
    sync();
    if (open) panel.first()?.focus();
    else if (panel.el.contains(doc.activeElement)) (doc.activeElement as HTMLElement).blur();
  };
  toggle.onclick = () => setToolsOpen(true);

  const typing = (t: unknown) => { const n = (t as { tagName?: string } | null)?.tagName; return n === 'INPUT' && (t as HTMLInputElement).type !== 'range' || n === 'TEXTAREA'; };
  const onKey = (e: KeyLike) => {
    if (e.repeat || typing(e.target)) return;
    if (e.code === 'Backquote' && panel) {
      e.preventDefault?.();
      const open = !toolsOpen;
      if (open && locked) o.onToolsOpen?.();
      setToolsOpen(open);
    } else if (e.code === 'Escape' && toolsOpen) setToolsOpen(false);
    else if (e.code === 'KeyH') showControls();
  };
  d.keys.addEventListener('keydown', onKey);

  const setPrompt = (text: string | null, key = 'E') => {
    if (text === shownPrompt) return;
    shownPrompt = text;
    root.classList.toggle('has-target', !!text);
    prompt.classList.toggle('is-on', !!text);
    if (text) { promptKey.textContent = key; promptText.textContent = text; }
  };

  const hud: Hud = {
    root,
    get toolsOpen() { return toolsOpen; },
    get locked() { return locked; },
    setHelp(h) {
      items = typeof h === 'string' ? parseHelp(h) : h;
      keycaps(doc, help, items, 'span');
      sync();
    },
    setPrompt,
    setLocked(l) {
      if (l === locked) return;
      locked = l;
      if (l && toolsOpen) setToolsOpen(false);
      if (l && !cardSeen && items.length) { cardSeen = true; showControls(); }
      sync();
    },
    toast(text, ms = 2600) {
      toastEl.textContent = text;
      toastEl.classList.add('is-on');
      if (toastTimer !== null) timers.clear(toastTimer);
      toastTimer = timers.set(() => { toastEl.classList.remove('is-on'); toastTimer = null; }, ms);
    },
    showControls,
    tools(config, open = false) {
      panel?.el.remove();
      panel = createToolsPanel(doc, config, { id: 'hud-tools', onClose: () => setToolsOpen(false) });
      panel.el.classList.add('hud-tools');
      toggle.setAttribute('aria-controls', panel.el.id);
      root.append(panel.el);
      toolsOpen = open;
      sync();
      return panel;
    },
    setToolsOpen,
    promptView: { show: (l) => setPrompt(l), dispose: () => setPrompt(null) },
    dispose() {
      d.keys.removeEventListener('keydown', onKey);
      clearCard();
      if (toastTimer !== null) timers.clear(toastTimer);
      root.remove();
    },
  };
  sync();
  return hud;
}

/* v8 ignore start -- browser bindings, exercised by the captures */
export const browserHudDeps = (): HudDeps => ({
  doc: document,
  keys: window,
  timers: { set: (f, ms) => window.setTimeout(f, ms), clear: (id) => window.clearTimeout(id) },
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
});
/* v8 ignore stop */
