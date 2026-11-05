// The few on-screen bits play needs, behind one small interface so the page can swap in the full HUD
// (src/ui, built with the impeccable skill) without touching the player code: help text, a use prompt,
// the pointer-lock state (crosshair) and short toasts. MinimalHud drives the page's #help and
// #crosshair; the prompt goes to an injected view (the interaction chip), timers are injected too.

export interface Hud {
  setHelp(text: string): void;
  /** What E would do now (null hides it). */
  setPrompt(text: string | null): void;
  /** Pointer locked: show the crosshair. */
  setLocked(locked: boolean): void;
  /** A short message that replaces the help text for a moment. */
  toast(text: string): void;
}

export interface HudElements { help: { textContent: string | null }; crosshair: { hidden: boolean | string } }
export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export class MinimalHud implements Hud {
  private help = '';
  private toastHandle: unknown = null;
  constructor(private el: HudElements, private prompt: { show(label: string | null): void }, private timers: Timers, private toastMs = 1600) {}

  setHelp(text: string) {
    this.help = text;
    if (this.toastHandle === null) this.el.help.textContent = text;
  }
  setPrompt(text: string | null) { this.prompt.show(text); }
  setLocked(locked: boolean) { this.el.crosshair.hidden = !locked; }
  toast(text: string) {
    if (this.toastHandle !== null) this.timers.clear(this.toastHandle);
    this.el.help.textContent = text;
    this.toastHandle = this.timers.set(() => { this.toastHandle = null; this.el.help.textContent = this.help; }, this.toastMs);
  }
}
