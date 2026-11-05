// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createHud } from '../../src/ui/hud';
import { wireGameHud } from '../../src/ui/gameHud';
import { fakeRig, hudDeps, type FakeView } from './fakes';

const VIEWS: FakeView[] = [{ name: 'hero', label: 'Hero', mode: 'orbit' }, { name: 'gate', label: 'Gate', mode: 'walk' }];
const keys = () => [...document.querySelectorAll('#help kbd')].map((k) => k.textContent);
const pressed = () => document.querySelector('.tools-seg [aria-pressed=true]')?.textContent;

describe('wireGameHud', () => {
  it('starts with the tools shut when walking, help for the mode, and follows the lock', () => {
    const hud = createHud(hudDeps());
    const rig = fakeRig('walk');
    const ui = wireGameHud(hud, { rig, views: VIEWS });
    expect(hud.toolsOpen).toBe(false);
    expect(keys()).toEqual(['Click', 'WASD', 'Shift', 'Space', 'C', 'E', 'H', '`']);
    expect(pressed()).toBe('Walk');
    expect(document.querySelector('.tools h2')?.textContent).toBe('Tools');
    expect(document.querySelector('input[type=range]')).toBeNull(); // no time given
    rig.locked = true;
    ui.sync();
    expect(hud.locked).toBe(true);
    expect(document.querySelectorAll('.hud-card li')).toHaveLength(6);
    ui.sync(); // unchanged: cheap no-op
    ui.setFps(59.6);
    expect(document.querySelector('.tools-stat')?.textContent).toBe('60 fps');
    expect(ui.panel.el.id).toBe('hud-tools');
  });

  it('switches mode, goes to the gate when walking from high up, and follows bookmarks', () => {
    const hud = createHud(hudDeps());
    const rig = fakeRig('orbit');
    let y = 100, hours = 15.5;
    wireGameHud(hud, { rig, views: VIEWS, modes: ['orbit', 'walk'], title: 'Door test', time: { get: () => hours, set: (h) => { hours = h; } }, walkFrom: { above: 30, view: 'gate', height: () => y } });
    expect(hud.toolsOpen).toBe(true); // review camera: open
    expect(document.querySelector('.tools h2')?.textContent).toBe('Door test');
    expect(document.querySelectorAll('.tools-seg button')).toHaveLength(2);
    expect(keys()[0]).toBe('Drag');
    const seg = document.querySelectorAll<HTMLButtonElement>('.tools-seg button');
    seg[1].click();
    expect(rig.log).toEqual(['mode walk', 'go gate']);
    expect(keys()[1]).toBe('WASD');
    y = 2;
    seg[0].click(); seg[1].click();
    expect(rig.log.slice(2)).toEqual(['mode orbit', 'mode walk']);
    document.querySelectorAll<HTMLButtonElement>('.tools-list button')[0].click();
    expect(rig.log.at(-1)).toBe('go hero');
    expect(pressed()).toBe('Orbit');
    const range = document.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(document.querySelector('output')?.textContent).toBe('15:30');
    range.value = '7'; range.dispatchEvent(new Event('input'));
    expect(hours).toBe(7);
    expect(range.min).toBe('6.5');
  });

  it('skips the gate jump when the bookmark is missing', () => {
    const rig = fakeRig('fly');
    wireGameHud(createHud(hudDeps()), { rig, views: VIEWS, walkFrom: { above: 30, view: 'nope', height: () => 99 } });
    document.querySelectorAll<HTMLButtonElement>('.tools-seg button')[2].click();
    expect(rig.log).toEqual(['mode walk']);
  });

  it('honours the ?ui= review flags', () => {
    const hud = createHud(hudDeps());
    wireGameHud(hud, { rig: fakeRig('orbit'), views: VIEWS, search: '?shot&ui=locked,notools,card' });
    expect(hud.locked).toBe(true);
    expect(hud.toolsOpen).toBe(false);
    expect(document.querySelector<HTMLElement>('.hud-card')!.hidden).toBe(false);
    const h2 = createHud(hudDeps());
    wireGameHud(h2, { rig: fakeRig('walk'), views: VIEWS, search: '?ui=tools' });
    expect(h2.toolsOpen).toBe(true);
  });
});
