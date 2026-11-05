# Agent skills in this repo

`.claude/skills/` holds the skills every agent working on this game should load. Start with `game-dev-index` and `game-direction-workflow`.

| Source | Skills | Licence |
| --- | --- | --- |
| [andeplane/gamevibing](https://github.com/andeplane/gamevibing) | all 19 `game-*` skills | owner's repo |
| [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills) | 13 `threejs-*` API skills (fundamentals, materials, shaders, lighting, postprocessing, …) | MIT |
| [majidmanzarpour/threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills) | game director, AAA graphics builder, QA/release, debug profiler, 3D/image/audio generators, gameplay systems, game UI | MIT |
| [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills) | game-feel, procedural-gen, level-design, physics-tuning, shader-programming, performance-optimization, camera-systems, audio-design, create-game-assets, input-systems (engine-agnostic disciplines only) | Apache-2.0 |

Not vendored (no licence file), install per machine:

```bash
npx skills add dgreenheck/webgpu-claude-skill     # TSL / WebGPU / compute
```

Update everything:

```bash
npx skills add andeplane/gamevibing --skill '*' -a claude-code -y --copy
npx skills add CloudAI-X/threejs-skills --skill '*' -a claude-code -y --copy
npx skills add majidmanzarpour/threejs-game-skills --skill '*' -a claude-code -y --copy
```
