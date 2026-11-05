// Types for the meshoptimizer simplifier bundled with three's addons (no @types entry upstream).
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    simplify(indices: Uint32Array, positions: Float32Array, stride: number, targetIndexCount: number, targetError: number, flags?: string[]): [Uint32Array, number];
  };
}
