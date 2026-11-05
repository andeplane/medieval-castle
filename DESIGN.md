---
name: Moated Castle
description: A first-person walk through a generated grey-stone castle; the world leads and the interface recedes.
colors:
  ink: "#1b1e22"
  bone: "#ddd6c6"
  bone-dim: "#b3ac9d"
  brass: "#c2a56a"
  chip: "rgba(18, 20, 23, 0.82)"
  panel: "rgba(17, 19, 22, 0.92)"
  line: "rgba(221, 214, 198, 0.2)"
  line-strong: "rgba(221, 214, 198, 0.38)"
  brass-line: "rgba(194, 165, 106, 0.62)"
  brass-hi: "#d6c08f"
  night: "#000000"
  shade: "rgba(0, 0, 0, 0.6)"
typography:
  display:
    fontFamily: "IM Fell English SC, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(30px, 4.4vw, 52px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.05em"
  title:
    fontFamily: "IM Fell English SC, Iowan Old Style, Georgia, serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.03em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  control:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.08em"
  keycap:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.03em"
rounded:
  sm: "3px"
  md: "6px"
spacing:
  gutter: "12px"
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
components:
  keycap:
    backgroundColor: "rgba(194, 165, 106, 0.08)"
    textColor: "{colors.brass}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    height: "22px"
    padding: "0 6px"
  hud-chip:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.bone}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
  tools-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.bone}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    width: "252px"
    padding: "10px 12px 14px"
  segment-on:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    height: "30px"
  list-button:
    backgroundColor: "rgba(221, 214, 198, 0.05)"
    textColor: "{colors.bone}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "4px 8px"
  primary-button:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "0 18px"
---

<!-- Documented by an agent (impeccable `document`, scan mode) from index.html's original tokens and the HUD built on them in src/ui/ui.css. The north star and colour names are the agent's reading, not yet confirmed by Anders. -->

# Design System: Moated Castle

## Overview

**Creative North Star: "Torchlight on Stone"**

The castle is the page. Every pixel of the viewport belongs to the rendered world: grey, weathered, massive stone, water and sky. The interface is a few small marks laid over it, the way a torch bracket or an iron ring sits on a wall: dark ink grounds, bone text, and brass only where something can be pressed or used. Nothing frames the world, and nothing stays on screen that the player is not using right now.

Two voices. A worn early-modern book face (IM Fell English SC) speaks only in titles: the name on the loading screen, the Controls card, the tools panel heading. Everything the player reads at a glance (prompts, keys, help, tool labels) is set in the system sans, small and calm, so it stays legible over bright sky and dark stone alike.

The loading screen is the one place the UI takes the stage, and even there the tunnel carries the progress: torches strike one by one as loading advances, and the caption only names the step and the percentage.

**Key Characteristics:**
- Experience mode: the world leads, the UI recedes; dev tools are hidden while walking.
- Ink and bone with a single brass accent for keys, the active state and focus.
- Small type (11–14px) on translucent ink chips, never bare text over the scene.
- Keyboard first: every control has a key or is reachable by Tab; keycaps show keys.
- One authored motion per surface (title settling in, ring opening, card fading).

## Colors

A cold, nearly neutral dark with warm bone text and one muted metal accent, taken from the stone and iron of the castle itself.

### Primary
- **Brass** (#c2a56a): keycaps, the crosshair ring and dot on a usable target, the selected camera mode, focus rings, titles in the display face. Rare by rule.

### Neutral
- **Ink** (#1b1e22): page ground behind the canvas, text on brass, select fields.
- **Bone** (#ddd6c6): all primary text on chips and panels.
- **Dim Bone** (#b3ac9d): secondary text: tool group labels, fps, loading step.
- **Chip Ink** (rgba 18,20,23 at 82 %): backing for anything floating over the scene (prompt, help line, toast, tools toggle).
- **Panel Ink** (rgba 17,19,22 at 92 %): the tools panel and the Controls card, which carry more text.
- **Hairline** (bone at 20 %, 38 % for hover): the only borders.
- **Night** (#000000): the loading tunnel's ground before the first torch.
- **Shade** (black at 60 %): the ring that keeps the crosshair visible, and the loading caption's shadow.
- **Bright Brass** (#d6c08f): hover on the one brass-filled button.

### Named Rules
**The Brass Is Iron Rule.** Brass marks only what you can act on (a key, a target, the current choice, focus). Never use it for decoration or body text.

**The No Bare Text Rule.** Text over the 3D scene always sits on Chip Ink or Panel Ink, except the loading caption, which sits on the tunnel's dark floor with a shadow.

## Typography

**Display Font:** IM Fell English SC (self-hosted, `src/ui/fonts/`, OFL), falling back to Iowan Old Style and Georgia.
**Body Font:** the platform UI sans (ui-sans-serif, system-ui).

**Character:** A rough, ink-spread small-caps face from 17th-century English printing, used sparingly against a neutral modern sans, so the period shows in the names and the instructions stay crisp.

### Hierarchy
- **Display** (400, clamp(30px, 4.4vw, 52px), 1): the loading screen title only.
- **Title** (400, 19–21px, 1): tools panel heading, Controls card heading.
- **Body** (400–500, 14px, 1.4): the use prompt, help line, toasts.
- **Control** (400, 13px, 1.2): tool buttons, segmented control, select; numbers tabular.
- **Label** (600, 11px, 0.08em, uppercase): tool group labels ("Camera", "Time of day", "Views").
- **Keycap** (600, 11px, 0.03em): keys inside `kbd`.

### Named Rules
**The Titles Only Rule.** The display face never sets instructions, numbers or anything smaller than 19px.

## Layout

The viewport is the scene; UI pins to its edges and centre with a 12px gutter plus safe-area insets.

- **Centre:** crosshair dot; the use prompt 24px below it; the Controls card 72px below it.
- **Bottom centre:** the help line (wraps on narrow screens), toasts 52px above it.
- **Top right:** the rendering stats chip (I), when shown.
- **Top left:** the tools panel (252px wide, scrolls inside itself) or, while it is shut, the small Tools toggle.
- Below 560px wide the tools panel spans the top between the gutters, caps at 52vh and its buttons grow to 36px.
- Spacing steps: 4, 8, 14, 20px; groups inside the panel are 14px apart, items inside a group 4–6px.

## Elevation & Depth

Flat. Depth comes from translucency over the scene, not shadows: chips at 82 % and panels at 92 % ink, each with a single hairline. The only shadows are text shadows on the loading caption and a 1px dark ring that keeps the crosshair visible on any background.

## Shapes

Small, quiet corners: 3px on keys, buttons and fields, 6px on chips, cards and panels. Keycaps have a 2px bottom border so they read as keys. The crosshair is a 4px dot; its target ring is a 20px circle with a 1.5px brass stroke.

## Components

### Keycap
Brass text in a brass hairline box with a thicker bottom edge, 22px tall. Used in the help line, the prompt and the Controls card. Slash-separated keys (E/Q) become two caps.

### Crosshair and use prompt
- **Idle:** a 4px bone dot with a dark ring, shown only while the mouse is captured.
- **On target:** the dot turns brass and a brass ring opens round it (0.2s ease-out); the prompt chip ("E Open door") fades in under it. Prompt text is announced politely to screen readers.

### Help line
A Chip Ink bar at the bottom centre with key + action pairs, shown only while the mouse is free. While walking it ends with `H controls`, `` ` tools`` and `I stats`.

### Controls card
Panel Ink card with a display-face "Controls" title and a two-column list of keycaps and actions. Appears on the first pointer lock, holds 4.5s and fades over 0.6s; H shows it again.

### Tools panel (review)
- **Header:** display-face title, fps in tabular figures, a close button (inline SVG cross).
- **Choice:** segmented row with a hairline frame; the pressed segment is filled brass with ink text (`aria-pressed`).
- **Range:** native slider tinted brass, with its value printed beside the uppercase label.
- **Actions:** two-column grid of quiet list buttons (5 % bone fill, hairline on hover).
- **Select:** native picker on Ink.
- Toggled with the backquote key (`` ` ``), closed with Esc; opening it while the mouse is captured releases the mouse and focuses the first control. Open by default for orbit and fly bookmarks, shut when you start out walking.

### Rendering stats (I)
A Chip Ink box in the top-right corner, hidden until I is pressed (or `?stats` / `?bench`): a two-column list of uppercase dim labels and right-aligned bone values in tabular figures (fps, frame time, CPU, GPU, draws, triangles, render size, API), redrawn four times a second. It takes no pointer events. Under the numbers a brass line shows benchmark progress, then the benchmark table in monospace, which can be selected and copied.

### Boot error
Centred on Ink: a display-face headline naming what failed, one line of advice, the browser's message in code, and a single brass Reload button that takes focus.

## Do's and Don'ts

### Do:
- **Do** put every floating text on Chip Ink (rgba 18,20,23 at 82 %) or Panel Ink.
- **Do** show keys as keycaps and name the action in plain words ("Open door", "release the mouse").
- **Do** hide everything under `body.shot`; use `?ui=locked,tools,card` to keep the HUD in a capture.
- **Do** keep the tools out of the way while walking and reachable in one key.

### Don't:
- **Don't** add panels, badges or persistent text to the walking view beyond the crosshair and prompt.
- **Don't** use brass for decoration, or the display face for instructions or numbers.
- **Don't** use emoji or Unicode glyphs as icons; draw icons as inline SVG.
- **Don't** add drop shadows to chips or panels; one hairline is the whole edge.
