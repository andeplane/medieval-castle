// Look-and-use (input-systems: one named "interact" action, bound to E and to a click while the
// pointer is locked). A centre dot, and a prompt chip when the nearest interactable within reach is
// under it. Input and the on-screen view are injected (defaults: DOM), so tests drive it with fakes.
import * as THREE from 'three/webgpu';
import type { Interactable } from '../castle/interior/types';

export const REACH = 2.2;

/** Distance to the first solid surface along the ray (walls between you and a door), or null. */
export type Occluder = (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, id: string) => number | null;

/** Where "interact" presses come from. Returns an unsubscribe function. */
export interface UseInput { subscribe(onUse: (source: 'key' | 'click') => void): () => void }
/** What shows the crosshair and prompt. */
export interface PromptView { show(label: string | null): void; dispose(): void }

export interface InteractOptions {
  occluder?: Occluder;
  /** Return false to ignore the E key (e.g. while flying, where E is up). Clicks still work. */
  enabled?: () => boolean;
  input?: UseInput;
  view?: PromptView;
  reach?: number;
}

export interface Interaction {
  update(): void;
  dispose(): void;
  /** Use whatever is under the crosshair now; true if something was used. */
  use(): boolean;
  target(): { id: string; label: string; dist: number } | null;
}

/** The nearest interactable the ray hits within reach and with nothing solid in front of it. */
export function pickTarget(ray: THREE.Ray, items: Interactable[], reach = REACH, occluder?: Occluder): { item: Interactable; dist: number } | null {
  let best: { item: Interactable; dist: number } | null = null;
  for (const it of items) {
    const t = it.hit(ray, reach);
    if (t === null || t > reach || (best && t >= best.dist)) continue;
    if (occluder) { const w = occluder(ray.origin, ray.direction, t, it.id); if (w !== null && w < t - 0.05) continue; }
    best = { item: it, dist: t };
  }
  return best;
}

const CSS = `
#xhair { position: fixed; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: var(--bone); box-shadow: 0 0 0 1px rgba(0,0,0,.55); opacity: .7; pointer-events: none; z-index: 6; transition: transform .12s, background .12s, opacity .12s; }
#xhair.on { background: var(--brass); opacity: 1; transform: scale(1.6); }
#useprompt { position: fixed; left: 50%; top: calc(50% + 22px); transform: translateX(-50%); display: flex; gap: 8px; align-items: center; padding: 5px 10px 5px 6px; background: var(--chip); border: 1px solid var(--chip-line); border-radius: 4px; color: var(--bone); font: 13px/1.2 var(--ui); white-space: nowrap; pointer-events: none; z-index: 6; opacity: 0; transition: opacity .12s; }
#useprompt.on { opacity: 1; }
#useprompt kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 4px; box-sizing: border-box; border: 1px solid var(--brass); border-radius: 3px; color: var(--brass); font: 600 12px/1 var(--ui); }
body.shot #xhair, body.shot #useprompt { display: none; }
@media (prefers-reduced-motion: reduce) { #xhair, #useprompt { transition: none; } }
`;

/** Default view: a dot and a prompt chip styled with the page's tokens (index.html), hidden in body.shot. */
export function domPromptView(doc: Document = document): PromptView {
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const dot = doc.createElement('div'); dot.id = 'xhair';
  const prompt = doc.createElement('div'); prompt.id = 'useprompt'; prompt.setAttribute('role', 'status'); prompt.setAttribute('aria-live', 'polite');
  const key = doc.createElement('kbd'); key.textContent = 'E';
  const text = doc.createElement('span');
  prompt.append(key, text);
  doc.body.append(dot, prompt);
  let shown: string | null = null;
  return {
    show(label) {
      if (label === shown) return;
      dot.classList.toggle('on', !!label); prompt.classList.toggle('on', !!label);
      if (label) text.textContent = label;
      shown = label;
    },
    dispose() { dot.remove(); prompt.remove(); style.remove(); },
  };
}

/** Default input: E on the window, left click on `dom` while the pointer is locked to it. */
export function domUseInput(dom: HTMLElement, win: Window = window, enabled: () => boolean = () => true): UseInput {
  return {
    subscribe(onUse) {
      const onKey = (e: KeyboardEvent) => {
        if (e.code !== 'KeyE' || e.repeat || (e.target as HTMLElement | null)?.tagName === 'INPUT' || !enabled()) return;
        onUse('key');
      };
      const onDown = (e: PointerEvent) => { if (e.button === 0 && dom.ownerDocument.pointerLockElement === dom) onUse('click'); };
      win.addEventListener('keydown', onKey);
      dom.addEventListener('pointerdown', onDown);
      return () => { win.removeEventListener('keydown', onKey); dom.removeEventListener('pointerdown', onDown); };
    },
  };
}

export function createInteraction(camera: THREE.Camera, dom: HTMLElement, items: () => Interactable[], opts: InteractOptions = {}): Interaction {
  const view = opts.view ?? domPromptView(dom.ownerDocument);
  const input = opts.input ?? domUseInput(dom, dom.ownerDocument.defaultView ?? window, opts.enabled);
  const reach = opts.reach ?? REACH;
  const ray = new THREE.Ray(), from = new THREE.Vector3(), dir = new THREE.Vector3();
  let current: { item: Interactable; dist: number } | null = null;

  const pick = () => {
    camera.updateMatrixWorld();
    camera.getWorldPosition(from); camera.getWorldDirection(dir);
    ray.set(from, dir);
    return pickTarget(ray, items(), reach, opts.occluder);
  };
  const render = () => view.show(current ? current.item.label() : null);
  const use = () => {
    current = pick();
    if (current) current.item.use();
    render();
    return !!current;
  };
  const unsubscribe = input.subscribe(() => { use(); });

  return {
    update() { current = pick(); render(); },
    use,
    target: () => (current ? { id: current.item.id, label: current.item.label(), dist: Math.round(current.dist * 100) / 100 } : null),
    dispose() { unsubscribe(); view.dispose(); },
  };
}
