// The castle page's HUD wiring: help for the current camera mode and lock state, and the review
// tools (camera mode, time of day, bookmarks, fps). The rig is anything with a mode, a lock state
// and bookmarks, so the physics player (or an NPC camera later) can stand in for CameraRig.
import type { Hud } from './hud';
import type { ToolsPanel, ToolsSection } from './tools';
import { clockText, helpFor, uiFlags, type HelpMode } from './help';

export interface RigLike<V extends { name: string; label: string; mode: HelpMode }> {
  readonly mode: HelpMode;
  readonly locked: boolean;
  setMode(m: HelpMode): void;
  go(v: V): void;
}

export interface GameHudOptions<V extends { name: string; label: string; mode: HelpMode }> {
  rig: RigLike<V>;
  views: readonly V[];
  modes?: readonly HelpMode[];
  /** time of day in hours; omit to leave the slider out */
  time?: { get(): number; set(h: number): void; min?: number; max?: number };
  /** when switching to walk from high up, go to this bookmark first */
  walkFrom?: { above: number; view: string; height(): number };
  /** location.search, for the ?ui= review flags */
  search?: string;
  title?: string;
}

export interface GameHud {
  /** Re-read mode and lock state (rig.onLockChange; also safe to call every frame). */
  sync(): void;
  setFps(fps: number): void;
  readonly panel: ToolsPanel;
}

const LABEL: Record<HelpMode, string> = { orbit: 'Orbit', fly: 'Fly', walk: 'Walk' };

export function wireGameHud<V extends { name: string; label: string; mode: HelpMode }>(hud: Hud, o: GameHudOptions<V>): GameHud {
  const { rig } = o;
  const flags = uiFlags(o.search ?? '');
  let last = '';
  const sync = () => {
    const locked = rig.locked || flags.locked;
    // cheap when nothing changed, so callers may run it every frame
    if (last === `${rig.mode} ${locked}`) return;
    last = `${rig.mode} ${locked}`;
    hud.setHelp(helpFor(rig.mode, locked));
    hud.setLocked(locked);
    panel.set('mode', rig.mode);
  };
  const sections: ToolsSection[] = [{
    kind: 'choice', id: 'mode', label: 'Camera', value: rig.mode,
    options: (o.modes ?? ['orbit', 'fly', 'walk']).map((m) => ({ id: m, label: LABEL[m] })),
    onChange: (id) => {
      const m = id as HelpMode;
      rig.setMode(m);
      const w = o.walkFrom;
      if (m === 'walk' && w && w.height() > w.above) { const v = o.views.find((x) => x.name === w.view); if (v) rig.go(v); }
      sync();
    },
  }];
  if (o.time) {
    const t = o.time;
    sections.push({ kind: 'range', id: 'time', label: 'Time of day', min: t.min ?? 6.5, max: t.max ?? 19.8, step: 0.1, value: t.get(), format: clockText, onInput: (h) => t.set(h) });
  }
  sections.push({ kind: 'actions', id: 'views', label: 'Views', options: o.views.map((v) => ({ id: v.name, label: v.label })), onPick: (id) => { rig.go(o.views.find((v) => v.name === id)!); sync(); } });
  // the tools start open for review cameras and closed when you start out walking
  const panel = hud.tools({ title: o.title ?? 'Tools', sections }, flags.tools ?? rig.mode !== 'walk');
  sync();
  if (flags.card) hud.showControls(Infinity);
  return { sync, setFps: (fps) => panel.setStat(`${Math.round(fps)} fps`), panel };
}
