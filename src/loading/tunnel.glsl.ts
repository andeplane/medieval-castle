// Fragment shader for the loading screen: a vaulted rubble-stone tunnel under the moat, lit only by
// wall torches. Everything is analytic (ray vs. floor, walls, barrel vault and end wall), so it
// compiles and runs in a few milliseconds before the castle's own textures exist. Masonry numbers
// (course heights, stone lengths, joint width, grey palette) mirror the `rubble` set in texgen.ts.
import { N_TORCH } from './model';

export const VERT = /* glsl */ `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform float uI[${N_TORCH}];   // torch intensities 0..1 (ignition ramp included)
uniform float uFill;            // final soft fill light 0..1
uniform vec2 uLook;             // small mouse parallax
uniform float uMotion;          // 0 when the user prefers reduced motion
uniform vec3 uStone[6];         // rubble palette (linear)
uniform vec3 uMortar;
uniform float uDay;             // daylight leaking through the far grille 0..1

// Matches the castle's tunnels (interior-shell branch): barrel vault ~2.1 m wide, crown ~2.65 m,
// rubble walls and vault, dressed springer course and dressed flagstones.
const float W = 1.05;   // half width
const float H = 1.6;    // springing height of the vault
const float L = 27.0;   // distance to the grille on the far bank
const float PI = 3.14159265;
const vec3 FIRE = vec3(1.0, 0.52, 0.2);

float h11(float n) { return fract(sin(n * 127.1 + 3.7) * 43758.5453); }
float h21(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

vec3 torchPos(int i) {
  float side = (i % 2 == 0) ? -1.0 : 1.0;
  return vec3(side * (W - 0.14), 1.62, -2.2 - float(i) * 3.05);
}
float flick(int i) {
  float t = uTime * (1.0 + 0.25 * uMotion);
  float f = float(i) * 7.3;
  return 0.82 + uMotion * (0.1 * sin(t * 9.0 + f) + 0.06 * sin(t * 23.0 + f * 1.7) + 0.05 * (vnoise(vec2(t * 6.0, f)) - 0.5));
}

// Rubble masonry. p.x runs along the courses, p.y across them (metres).
// Returns height (0 mortar .. ~1 stone face), mortar mask, stone id.
vec3 masonry(vec2 p, float ch0, float ch1, float l0, float l1, float joint) {
  vec2 q = p + (vec2(vnoise(p * 1.7), vnoise(p * 1.7 + 7.3)) - 0.5) * 0.11;
  // courses of varying height: boundaries jittered per course (ch0..ch1)
  float ch = 0.5 * (ch0 + ch1), jit = (ch1 - ch0) / ch * 0.5;
  float k = floor(q.y / ch);
  float b0 = (k + (h11(k) - 0.5) * jit) * ch, b1 = (k + 1.0 + (h11(k + 1.0) - 0.5) * jit) * ch;
  if (q.y < b0) { b1 = b0; k -= 1.0; b0 = (k + (h11(k) - 0.5) * jit) * ch; }
  else if (q.y >= b1) { b0 = b1; k += 1.0; b1 = (k + 1.0 + (h11(k + 1.0) - 0.5) * jit) * ch; }
  // stones along the course: lengths l0..l1, boundaries jittered per stone
  float len = 0.5 * (l0 + l1), lj = (l1 - l0) / len * 0.45;
  float x = q.x + h11(k * 7.7) * len * 3.0;
  float c = floor(x / len);
  float a0 = (c + (h21(vec2(k, c)) - 0.5) * lj) * len, a1 = (c + 1.0 + (h21(vec2(k, c + 1.0)) - 0.5) * lj) * len;
  if (x < a0) { a1 = a0; c -= 1.0; a0 = (c + (h21(vec2(k, c)) - 0.5) * lj) * len; }
  else if (x >= a1) { a0 = a1; c += 1.0; a1 = (c + 1.0 + (h21(vec2(k, c + 1.0)) - 0.5) * lj) * len; }
  float id = h21(vec2(k, c) + 11.0);
  float ex = min(x - a0, a1 - x), ey = min(q.y - b0, b1 - q.y);
  // some stones are two thinner ones stacked, the way rubble is packed
  if (id > 0.72) {
    float m = mix(b0, b1, 0.35 + 0.3 * h11(id * 91.0));
    ey = min(ey, abs(q.y - m));
    id = h21(vec2(k, c) + step(m, q.y) * 5.1 + 23.0);
  }
  float e = min(ex, ey);
  float j = joint * (0.55 + 0.9 * vnoise(p * 6.0 + id * 4.0));
  // rough, pitted, slightly tilted faces rather than pillows
  float face = 0.7 + 0.7 * (fbm(p * 3.5 + id * 9.0) - 0.5) + 0.22 * vnoise(p * 17.0 + id) + 0.08 * vnoise(p * 55.0);
  face += (h11(id * 13.0) - 0.5) * 0.6 * (q.x - 0.5 * (a0 + a1)) + (h11(id * 17.0) - 0.5) * 0.6 * (q.y - 0.5 * (b0 + b1));
  float edge = smoothstep(j, j + 0.02 + 0.05 * h11(id * 5.0), e + 0.012 * (vnoise(p * 31.0) - 0.5));
  return vec3(edge * face, 1.0 - smoothstep(j, j + 0.01, e), id);
}

vec3 stoneCol(float id, vec2 p) {
  int k = int(floor(id * 5.999));
  vec3 c = uStone[k];
  c *= 0.72 + 0.5 * h11(id * 71.0);                       // stone-to-stone shade
  c *= 0.8 + 0.4 * fbm(p * 3.0 + id * 31.0);
  c = mix(c, c * vec3(0.92, 0.95, 1.0), step(0.85, h11(id * 3.0)));  // the odd bluer stone
  c *= 0.75 + 0.25 * smoothstep(0.2, 0.7, fbm(p * 0.6 + 2.0));       // broad grime
  return c;
}

struct Hit { float t; vec3 n; vec3 alb; float rough; float ao; float wet; };

// Masonry surface: parameter (along, across), tangent axes, base normal.
void masonrySurface(vec2 uv, vec3 ta, vec3 tb, vec3 nb, float ch0, float ch1, float l0, float l1, float joint, float bump, inout Hit h) {
  vec3 m = masonry(uv, ch0, ch1, l0, l1, joint);
  float e = 0.01;
  float hx = masonry(uv + vec2(e, 0), ch0, ch1, l0, l1, joint).x;
  float hy = masonry(uv + vec2(0, e), ch0, ch1, l0, l1, joint).x;
  vec2 g = vec2(hx - m.x, hy - m.x) / e * bump;
  h.n = normalize(nb - g.x * ta - g.y * tb);
  vec3 c = mix(stoneCol(m.z, uv), uMortar * (0.85 + 0.3 * vnoise(uv * 13.0)), m.y);
  h.alb = c;
  h.ao = mix(1.0, 0.45, m.y) * (0.75 + 0.25 * m.x);
  h.rough = mix(0.82, 0.95, m.y);
}

Hit trace(vec3 ro, vec3 rd) {
  Hit h; h.t = 1e9; h.wet = 0.0; h.ao = 1.0; h.rough = 0.9;
  int kind = -1;
  // floor
  if (rd.y < 0.0) { float t = -ro.y / rd.y; if (t > 0.0 && t < h.t) { h.t = t; kind = 0; } }
  // side walls up to the springing line, else the vault
  if (abs(rd.x) > 1e-5) {
    float t = (sign(rd.x) * W - ro.x) / rd.x;
    float y = ro.y + rd.y * t;
    if (t > 0.0 && y <= H && t < h.t) { h.t = t; kind = 1; }
  }
  {
    vec2 o = ro.xy - vec2(0.0, H), d = rd.xy;
    float a = dot(d, d), b = dot(o, d), c = dot(o, o) - W * W;
    float disc = b * b - a * c;
    if (disc > 0.0 && a > 1e-8) {
      float t = (-b + sqrt(disc)) / a;
      if (t > 0.0 && ro.y + rd.y * t > H && t < h.t) { h.t = t; kind = 2; }
    }
  }
  // end wall
  if (rd.z < 0.0) { float t = (-L - ro.z) / rd.z; if (t > 0.0 && t < h.t) { h.t = t; kind = 3; } }

  vec3 P = ro + rd * h.t;
  if (kind == 0) {
    // flagstones laid across the tunnel, a worn centre and puddles of seep water from the moat above
    masonrySurface(vec2(P.x * 1.0 + 40.0, P.z), vec3(1, 0, 0), vec3(0, 0, 1), vec3(0, 1, 0), 0.5, 0.7, 0.45, 0.95, 0.02, 0.018, h);
    float pud = smoothstep(0.5, 0.62, fbm(P.xz * vec2(0.9, 0.35) + 3.0) + 0.18 * (1.0 - smoothstep(0.2, 1.1, abs(P.x))));
    h.wet = pud;
    h.alb *= mix(0.95, 0.45, pud);
    h.rough = mix(h.rough, 0.06, pud);
    h.n = normalize(mix(h.n, vec3(0, 1, 0), pud));
    // gutter damp along the wall foot
    h.alb *= mix(1.0, 0.7, smoothstep(W - 0.35, W, abs(P.x)));
  } else if (kind == 1 || kind == 2) {
    // one continuous course parameter from the left floor, over the vault, down to the right floor
    float s; vec3 nb, tb;
    if (kind == 1) {
      s = P.x < 0.0 ? P.y : H * 2.0 + W * PI - P.y;
      nb = vec3(-sign(P.x), 0, 0);
      tb = P.x < 0.0 ? vec3(0, 1, 0) : vec3(0, -1, 0);
    } else {
      float phi = atan(P.y - H, P.x);
      s = H + W * (PI - phi);
      nb = -normalize(vec3(P.x, P.y - H, 0.0));
      tb = vec3(-sin(phi), cos(phi), 0.0) * -1.0;
    }
    float sp = min(abs(s - H + 0.13), abs(s - (H + W * PI) - 0.13));
    if (sp < 0.15) {
      // dressed springer course where the vault starts: tighter joints, paler, squarer stones
      masonrySurface(vec2(P.z, s - H + 0.28), vec3(0, 0, 1), tb, nb, 0.28, 0.3, 0.55, 0.95, 0.01, 0.014, h);
      h.alb *= 1.22;
    } else {
      masonrySurface(vec2(P.z, s), vec3(0, 0, 1), tb, nb, 0.16, 0.4, 0.18, 0.75, 0.03, 0.022, h);
    }
    // damp, greener base; white lime seeping through the vault joints from the moat
    float base = 1.0 - smoothstep(0.0, 0.9 + 0.5 * vnoise(P.zz * 0.7), P.y);
    h.alb = mix(h.alb, h.alb * vec3(0.55, 0.62, 0.48), base * 0.8);
    float lime = smoothstep(0.62, 0.78, fbm(vec2(P.z * 1.3, s * 0.18) + 5.0)) * smoothstep(H - 0.2, H + 1.0, P.y);
    h.alb = mix(h.alb, vec3(0.52, 0.52, 0.49), lime * 0.55);
    float drip = smoothstep(0.55, 0.8, fbm(vec2(P.z * 3.0, s * 0.06)));
    h.rough = mix(h.rough, 0.25, drip * (1.0 - base) * 0.6);
    h.wet = drip * 0.3;
    h.alb *= 1.0 - 0.25 * drip;
  } else if (kind == 3) {
    // far end: an iron grille in a dressed arch, daylight from the moat bank behind it
    vec2 q = P.xy;
    float arch = (q.y < 1.25) ? abs(q.x) - 0.62 : length(q - vec2(0, 1.25)) - 0.62;
    if (arch < 0.0) {
      vec2 g = abs(fract(q / vec2(0.16, 0.24) + 0.5) - 0.5) * vec2(0.16, 0.24);
      float bar = 1.0 - smoothstep(0.012, 0.02, min(g.x, q.y < 0.15 || q.y > 1.8 ? 0.0 : g.y));
      h.alb = mix(vec3(-1.0), vec3(0.025, 0.022, 0.02), bar);   // negative albedo flags open sky
      h.rough = 0.5; h.n = vec3(0, 0, 1); h.ao = 1.0;
    } else {
      masonrySurface(q, vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), 0.16, 0.4, 0.18, 0.75, 0.03, 0.022, h);
      if (arch < 0.2) { h.alb *= 1.2; h.ao *= 0.9; }
    }
  }
  return h;
}

// light from every torch flame seen along a ray: hot core, soft halo and in-scattering in the damp air
vec3 flames(vec3 ro, vec3 rd, float tmax, float haze) {
  vec3 c = vec3(0);
  for (int i = 0; i < ${N_TORCH}; i++) {
    float I = uI[i];
    if (I <= 0.001) continue;
    I *= flick(i);
    vec3 F = torchPos(i) + vec3(0.0, 0.18, 0.0);
    F.x += uMotion * 0.015 * sin(uTime * 7.0 + float(i));
    vec3 d = F - ro;
    float b = dot(d, rd);
    vec3 closest = ro + rd * clamp(b, 0.0, tmax) - F;
    float h2 = dot(closest, closest);
    // in-scattering: analytic integral of 1/r^2 along the ray up to the hit
    float hh = sqrt(max(dot(d, d) - b * b, 1e-4));
    float scat = (atan((tmax - b) / hh) + atan(b / hh)) / hh;
    c += FIRE * I * scat * haze;
    if (b > 0.0 && b < tmax) {
      vec3 q = ro + rd * b - F;
      q.y *= 0.5;                                     // taller than wide
      float r2 = dot(q, q);
      c += vec3(1.0, 0.75, 0.45) * I * (exp(-r2 / 0.0018) * 6.0 + 0.0035 / (r2 + 0.003));
    }
  }
  return c;
}

vec3 shade(Hit h, vec3 P, vec3 V) {
  if (h.alb.r < 0.0) return vec3(1.3, 1.35, 1.3) * uDay + vec3(0.002);
  // daylight spilling through the grille: falls off down the tunnel, strongest on the floor
  vec3 G = vec3(0.0, 0.9, -L);
  vec3 Gd = G - P;
  float gd2 = dot(Gd, Gd);
  float gl = max(dot(h.n, normalize(Gd)), 0.0) * max(dot(normalize(-Gd), vec3(0, 0, 1)), 0.0);
  vec3 c = h.alb * h.ao * vec3(0.75, 0.8, 0.85) * uDay * gl * 3.0 / (1.0 + gd2 * 0.08);
  c += h.alb * h.ao * uFill * (0.55 + 0.45 * max(h.n.y, 0.0) + 0.2) * vec3(0.62, 0.64, 0.7) * 1.4;
  float spec0 = mix(0.03, 0.06, h.wet);
  for (int i = 0; i < ${N_TORCH}; i++) {
    float I = uI[i];
    if (I <= 0.001) continue;
    I *= flick(i);
    vec3 Lp = torchPos(i) + vec3(0, 0.12, 0);
    vec3 Ld = Lp - P;
    float d2 = dot(Ld, Ld);
    vec3 l = Ld * inversesqrt(d2);
    float ndl = max(dot(h.n, l), 0.0);
    vec3 hv = normalize(l + V);
    float sh = mix(8.0, 300.0, 1.0 - h.rough);
    float sp = pow(max(dot(h.n, hv), 0.0), sh) * (sh + 8.0) / 25.0 * spec0;
    float att = 1.0 / (0.25 + d2 * 0.9);
    // the iron sconce keeps a dark patch just under each torch
    float sconce = 1.0 - 0.6 * smoothstep(0.35, 0.0, length((P - torchPos(i)) * vec3(1, 0.6, 1))) * step(P.y, torchPos(i).y);
    c += FIRE * I * att * (h.alb * h.ao * ndl + sp * ndl) * 3.0 * sconce;
  }
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * uMotion;
  vec3 ro = vec3(0.08 * sin(t * 0.21), 1.5 + 0.015 * sin(t * 0.9), 1.6 - 0.9 * smoothstep(0.0, 40.0, t));
  vec3 fw = normalize(vec3(0.06 * sin(t * 0.13) + uLook.x * 0.08, -0.03 + uLook.y * 0.05, -1.0));
  vec3 rt = normalize(cross(fw, vec3(0, 1, 0))), up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.25 + uv.x * rt + uv.y * up);

  Hit h = trace(ro, rd);
  vec3 P = ro + rd * h.t;
  vec3 V = -rd;
  vec3 col = shade(h, P, V);
  // torch shafts: short charred staves leaning out of iron rings on the wall
  for (int i = 0; i < ${N_TORCH}; i++) {
    vec3 T = torchPos(i);
    float side = T.x < 0.0 ? 1.0 : -1.0;
    vec3 a = T + vec3(side * 0.02, 0.12, 0.0), b = T + vec3(-side * 0.08, -0.3, 0.0);
    // closest approach between the ray and segment a-b
    vec3 ba = b - a, oa = ro - a;
    float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa);
    float den = baba - bard * bard;
    float tt = (bard * baoa - baba * rdoa) / max(den, 1e-6);
    float u = clamp((baoa + bard * tt) / baba, 0.0, 1.0);
    vec3 cp = a + ba * u;
    float ts = max(dot(cp - ro, rd), 0.0);
    float d = length(ro + rd * ts - cp);
    float r = mix(0.03, 0.022, u);
    if (ts < h.t && d < r) {
      float lit = (uI[i] > 0.001 ? uI[i] * flick(i) : 0.0);
      vec3 wood = mix(vec3(0.02, 0.015, 0.01), vec3(0.09, 0.06, 0.04), u);
      col = wood * (lit * FIRE * 0.9 * (1.0 - u * 0.6) + uFill * 0.4) + FIRE * lit * 0.6 * smoothstep(0.25, 0.0, u);
      h.t = ts;
    }
  }
  col += flames(ro, rd, h.t, 0.012);
  // puddles and wet stone mirror the flames
  if (h.wet > 0.01) {
    vec3 rr = reflect(rd, h.n);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(h.n, V), 0.0), 5.0);
    col += flames(P + h.n * 0.01, rr, 40.0, 0.0) * h.wet * mix(0.25, 1.0, fres) * 0.6;
  }
  // tone map (exponential), vignette, dither so the dark stays smooth
  col = 1.0 - exp(-col * 1.1);
  col *= 1.0 - 0.35 * dot(uv, uv);
  col = pow(col, vec3(1.0 / 2.2));
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;
