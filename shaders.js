// shoreline shaders. Water and sand share one grid and get their heights from the same function
export const NW = 9;

export const common = /* glsl */ `
#define NW ${NW}
uniform float uT;
uniform vec4 uWave[NW];   // x: break time  y: wave height (m)  z: run-up (m)  w: random seed
uniform vec3 uSun;        // sun direction
uniform vec3 uCam;

const float ZS = 4.5;     // still-water shoreline (distance from camera, m)
const float SLOPE = 0.06; // beach slope
const float DB = 8.3;     // breaking distance
const float CB = 2.8;     // speed of the bore after breaking, m/s
const float KOB = 0.1;    // oblique arrival: the right side arrives earlier, s/m
const float ACC = 1.6;    // run-up deceleration, m/s^2

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float n1(float x){ float i = floor(x), f = fract(x); float u = f * f * (3. - 2. * f); return mix(hash12(vec2(i, 17.3)), hash12(vec2(i + 1., 17.3)), u) * 2. - 1.; }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }

float sandY(vec2 p){ // p = (x, distance D)
  return SLOPE * (ZS - p.y) + 0.018 * sin(p.x * 0.6 + p.y * 0.35) + 0.012 * (fbm(p * 0.9) - 0.5);
}

// contribution of one wave at point p
// eta: sea surface elevation / film: run-up water thickness / foam: residual foam / crest: closeness to the crest / edge: run-up leading edge
// adv: foam advection / white: whitewater (breaking crest and bore) / swf: foam on the swash
void waveAt(int i, vec2 p, inout float eta, inout float film, inout float foam, inout float crest, inout float edge, inout float adv, inout float white, inout float swf){
  vec4 w = uWave[i];
  if (w.y <= 0.) return;
  float sd = w.w;
  float lat = n1(p.x * 0.16 + sd * 13.1) * 0.55 + n1(p.x * 0.47 + sd * 7.7) * 0.25;
  float H = w.y * (1. + 0.45 * lat);
  float tau = uT - w.x + KOB * p.x + 0.22 * n1(p.x * 0.33 + sd * 3.3);
  float dbL = DB + 1.1 * n1(p.x * 0.21 + sd * 5.9) + 0.4 * n1(p.x * 0.7 + sd);
  float ts = (dbL - ZS) / CB;
  float Dc = dbL - CB * tau;
  float xi = p.y - Dc; // positive = seaward of the front

  // blend smoothly over time between the approaching swell (steep front, gentle back) and the bore after breaking
  float bw = smoothstep(-0.15, 0.35, tau);
  if (tau < 0.6) {
    float k = smoothstep(-3.2, 0., min(tau, 0.));
    float A = H * (0.3 + 0.7 * k);
    float wf = mix(1.5, 0.3, k * k);
    float wb = mix(2.8, 1.9, k);
    float pr = xi < 0. ? exp(-xi * xi / (wf * wf)) : exp(-xi * xi / (wb * wb));
    float pre = A * pr - 0.16 * A * exp(-pow((xi + 1.8) / 1.1, 2.));
    eta += pre * (1. - bw);
    crest = max(crest, k * pr * step(-0.9, xi) * step(xi, 0.45) * (1. - bw));
    // start of breaking: the crest whitens from the top (the front face is still translucent)
    float br = smoothstep(-0.7, 0., tau);
    float seg = smoothstep(-0.3, 0.4, n1(p.x * 0.9 + sd * 11.) + br * 0.8);
    white += br * seg * 1.6 * exp(-pow((xi - 0.06 - 0.06 * br) / (0.06 + 0.1 * br), 2.)) * (1. - bw);
  }
  if (tau > -0.15 && tau < ts + 0.25) {
    float dec = exp(-max(tau, 0.) * 0.3);
    float A = H * mix(0.95, 0.62, smoothstep(0., 0.6, tau)) * dec;
    float pr = xi < 0. ? exp(-xi * xi / 0.09) : (0.5 + 0.5 * exp(-xi * xi / 0.3)) * exp(-xi / 3.2);
    float fade = smoothstep(ts + 0.25, ts - 0.1, tau);
    eta += A * pr * fade * bw;
    crest = max(crest, 0.5 * dec * exp(-xi * xi / 0.12) * fade * bw);
    float brk = smoothstep(-0.5, 0.5, n1(p.x * 1.4 + sd * 9. + tau * 0.6)) * 0.55 + 0.45;
    white += 1.6 * dec * exp(-pow((xi - 0.3) / (0.35 + 0.25 * smoothstep(0., 1., tau)), 2.)) * fade * bw * (0.75 + 0.25 * lat) * brk;
    foam += 0.6 * dec * exp(-pow((xi - 0.45) / 0.4, 2.)) * fade * bw;
  }

  // foam left behind the passing bore
  if (tau > 0.) {
    float age = tau - (dbL - p.y) / CB;
    if (age > 0.) {
      float keep = smoothstep(dbL + 0.6, dbL - 0.4, p.y) * smoothstep(ZS - 0.3, ZS + 0.4, p.y);
      foam += 0.32 * exp(-age / 1.0) * keep;
    }
  }

  // run-up (climbs the sand from the shoreline, then drains back)
  float tt = tau - ts;
  if (tt > 0.) {
    float R = max(0.05, w.z * (1. + 0.35 * lat));
    float v0 = sqrt(2. * ACC * R);
    float Tt = v0 / ACC;
    float life = smoothstep(2. * Tt + 0.6, 2. * Tt - 0.2, tt);
    if (life > 0.) {
      float run = v0 * tt - 0.5 * ACC * tt * tt;
      float Ee = ZS - max(run, -0.4) + 0.13 * n1(p.x * 1.05 + sd * 2.1) + 0.05 * n1(p.x * 3.7 + sd * 4.4) + 0.015 * n1(p.x * 11. + sd);
      float up = 1. - smoothstep(0., Tt, tt);          // 1 while running up
      float thick = clamp((p.y - Ee) * mix(0.028, 0.06, up), 0., 0.12);
      thick += 0.035 * up * exp(-pow((p.y - Ee - 0.18) / 0.22, 2.)); // bulge at the leading edge
      thick *= step(Ee, p.y) * life;
      float fw = smoothstep(ZS + 1.6, ZS - 0.2, p.y);
      film = max(film, thick * fw + (p.y > ZS ? thick * (1. - fw) : 0.));
      float cov = (1.25 * exp(-tt / 1.1) + 0.22 * exp(-tt / 5.)) * (0.9 - 0.3 * smoothstep(Tt, 2. * Tt, tt));   // right after run-up the swash is covered in foam, it thins to threads in about 1 s, and a sparse lace lingers
      float inside = smoothstep(Ee - 0.01, Ee + 0.06, p.y) * smoothstep(ZS + 0.9, ZS - 0.1, p.y) * life;
      swf = max(swf, cov * inside);
      white += 1.3 * up * smoothstep(0.9 * Tt, 0.1, tt) * exp(-pow((p.y - Ee - 0.28) / 0.3, 2.)) * life;
      edge = max(edge, exp(-pow((p.y - Ee - 0.03) / 0.045, 2.)) * life * (0.55 + 0.45 * up));
      adv += (ZS - Ee) * inside * 0.75;
    }
  }
}

struct Surf { float y; float sand; float film; float foam; float crest; float edge; float adv; float white; };

Surf surf(vec2 p){
  float eta = 0., film = 0., foam = 0., crest = 0., edge = 0., adv = 0., white = 0., swf = 0.;
  for (int i = 0; i < NW; i++) waveAt(i, p, eta, film, foam, crest, edge, adv, white, swf);
  foam = max(foam, swf) + 0.3 * min(foam, swf);
  // offshore swell: long waves travelling shoreward beyond the surf zone
  float off = smoothstep(DB - 1., DB + 4., p.y);
  // shallow water, so speed is set by depth (1.3-1.6 m/s; deep-water speed looks more than twice too fast)
  eta += off * (0.07 * sin(0.72 * (p.y + 0.12 * p.x) + 0.72 * 1.4 * uT) + 0.05 * sin(1.05 * (p.y - 0.2 * p.x) + 1.05 * 1.3 * uT + 1.3) + 0.035 * sin(0.55 * (p.y + 0.35 * p.x) + 0.55 * 1.6 * uT + 4.1));
  float rollerN = fbm(p * vec2(2.2, 3.4) + vec2(0., uT * 0.8)) * 0.7 + fbm(p * vec2(7., 10.) - uT * 0.5) * 0.3;
  float lumps = fbm(p * vec2(7., 9.) + vec2(0., uT * 1.1)) + 0.5 * fbm(p * vec2(16., 20.) - uT * 0.7);
  eta += smoothstep(0.15, 1.1, white) * (0.06 + 0.16 * rollerN + 0.1 * lumps) * (0.6 + 0.4 * n1(p.x * 1.3 + 4.));
  float sy = sandY(p);
  Surf s;
  s.sand = sy;
  float sea = eta;
  float sheet = sy + film;
  s.y = max(sea, sheet);
  s.film = s.y - sy;
  s.foam = foam;
  s.crest = crest;
  s.edge = edge;
  s.adv = adv;
  s.white = white;
  return s;
}
`;

// fine ripples (normals only). Finer ripples are included closer to the camera
export const ripples = /* glsl */ `
// returns xy = slope, z = slope variance of unresolved sub-pixel ripples (widens the glints)
vec3 rippleSlope(vec2 p, float fw){
  vec2 g = vec2(0.);
  float unres = 0.;
  for (int i = 0; i < 60; i++){
    float fi = float(i);
    float lam = 6.0 * pow(0.9, fi) * (0.8 + 0.4 * hash12(vec2(fi, 9.1)));   // 6 m down to about 0.01 m
    float spread = mix(0.9, 2.8, smoothstep(3., 0.2, lam));
    float ang = (hash12(vec2(fi, 3.1)) - 0.5) * spread + 0.15;
    vec2 d = vec2(sin(ang), -cos(ang));
    float k = 6.2831853 / lam;
    float hd = clamp(SLOPE * (p.y - ZS), 0.08, 4.);   // water depth: in shallow water longer waves slow down
    float om = sqrt((9.81 * k + 0.074 / 1000. * k * k * k) * tanh(k * hd));
    float stp = mix(0.14, 0.05, smoothstep(1.5, 0.08, lam)) * (0.45 + 1.1 * hash12(vec2(fi, 7.7)));
    float amp = stp / k;
    float filt = smoothstep(fw * 4., fw * 9., lam);
    float ph = k * dot(d, p) - om * uT + hash12(vec2(fi, 1.3)) * 6.2831;
    float c = cos(ph), sn = sin(ph);
    // sharpen the crests (asymmetric front and back slopes)
    float slope = amp * k * c * (1. + 0.8 * sn);
    g += d * slope * filt;
    unres += (amp * k) * (amp * k) * 0.5 * (1. - filt);
  }
  float rough = 0.6 + 0.8 * vnoise(p * 0.09 + vec2(uT * 0.03, 0.));
  return vec3(g * rough, unres * rough * rough);
}

`
export const vert = /* glsl */ `
${common}
uniform float uIsSand;
varying vec2 vP;
varying vec3 vW;
void main(){
  vec2 p = vec2(position.x, position.z);
  float y;
  if (p.y < 70.) {
    Surf s = surf(p);
    y = uIsSand > 0.5 ? s.sand : (s.film > 0.002 ? s.y : s.sand - 0.03);
  } else {
    y = uIsSand > 0.5 ? -5. : 0.;
  }
  vP = p;
  vec3 w = vec3(p.x, y, -p.y);
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
}
`;

export const skyFn = /* glsl */ `
vec3 srgb2lin(vec3 c){ return pow(c / 255., vec3(2.2)); }
// clear-sky colors by elevation angle (sRGB)
vec3 skyCol(vec3 d){
  float e = degrees(asin(clamp(d.y, -1., 1.)));
  vec3 c0 = srgb2lin(vec3(150, 184, 200));   // at the horizon
  vec3 c1 = srgb2lin(vec3(134, 177, 204));   // 2°
  vec3 c2 = srgb2lin(vec3(104, 159, 203));   // 6°
  vec3 c3 = srgb2lin(vec3(66, 127, 188));    // 13°
  vec3 c4 = srgb2lin(vec3(46, 100, 174));    // 30°
  vec3 c5 = srgb2lin(vec3(38, 88, 170));     // 70°
  vec3 c = mix(c0, c1, smoothstep(0., 2., e));
  c = mix(c, c2, smoothstep(2., 6., e));
  c = mix(c, c3, smoothstep(6., 13., e));
  c = mix(c, c4, smoothstep(13., 30., e));
  c = mix(c, c5, smoothstep(30., 70., e));
  // glow around the sun
  float cs = max(dot(d, uSun), 0.);
  c += srgb2lin(vec3(90, 110, 120)) * pow(cs, 60.) * 0.5;
  if (e < 0.) c = c0 * 0.9;
  return c;
}
`;

export const skyFrag = /* glsl */ `
uniform vec3 uSun;
uniform float uT;
varying vec3 vDir;
${skyFn}
void main(){
  gl_FragColor = vec4(skyCol(normalize(vDir)), 1.);
}
`;

export const skyVert = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.);
  gl_Position = p.xyww;
}
`;

export const frag = /* glsl */ `
${common}
${ripples}
${skyFn}
uniform float uIsSand;
varying vec2 vP;
varying vec3 vW;

// foam lace. The smaller cov is, the wider the holes, until only threads remain
// backwash foam: a lace of thin threads, stretched into streaks by the draining flow,
// changing shape as it is churned, threads breaking until it fades away
float laceLayer(vec2 q, float cov, float t, float seed){
  vec2 qs = vec2(q.x * 5.5, q.y * 6.5) + seed;   // a fine lace: on screen it reads as thin, wavy horizontal threads
  vec2 qq = qs + 0.6 * vec2(fbm(qs * 0.5 + vec2(1.3, t * 0.35)), fbm(qs * 0.5 + vec2(8.1 - t * 0.3, 0.))) - 0.3;
  qq += 0.15 * vec2(fbm(qq * 3. + vec2(0., t * 0.8)), fbm(qq * 3. + vec2(4.3 + t * 0.7, 0.))) - 0.07;
  // threads: noise contours (1-|2n-1|). Thickness follows the amount of foam
  float n1v = fbm(qq * 1.6 + 5.) * 0.65 + fbm(qq * 3.7 + 11.) * 0.35;
  float r = 1. - abs(2. * n1v - 1.);
  float n2v = fbm(qq * 3.1 + 17.);
  float r2 = 1. - abs(2. * n2v - 1.);
  float fz = vnoise(qq * vec2(18., 18.)) * 0.6 + vnoise(qq * vec2(45., 45.)) * 0.4 - 0.5;
  float w1 = 0.05 + 0.16 * cov, w2 = 0.04 + 0.12 * cov;
  float thread = max(smoothstep(1. - w1, 1. - w1 * 0.7, r + fz * 0.06), smoothstep(1. - w2, 1. - w2 * 0.7, r2 + fz * 0.06) * 0.85);
  // where there is a lot of foam it becomes a sheet (holes of uneven size)
  float b = fbm(qq * 1.2 + 2.) * 0.6 + fbm(qq * 2.9 + 7.) * 0.4 + fz * 0.05;
  float th = 0.6 + (0.55 - cov) * 0.5;   // only very dense foam becomes a sheet; the rest is threads
  float sheet = smoothstep(th - 0.01, th + 0.02, b);
  // threads break more as the foam thins
  float brk = smoothstep(0.62 - 0.45 * cov, 0.8 - 0.45 * cov, vnoise(qq * vec2(2.2, 2.2) + 7. + t * 0.2));
  return max(sheet, thread * mix(0.15, 1., brk)) * smoothstep(0.02, 0.12, cov);
}
float lace(vec2 q, float cov){
  // two layers offset in time: each one fades out and returns with a new pattern, so the lace never stops re-forming
  float f = 0.;
  for (int k = 0; k < 2; k++){
    float ph = uT / 2.2 + float(k) * 0.5;
    float fr = fract(ph);
    float wk = 1. - abs(2. * fr - 1.);
    vec2 off = hash22(vec2(floor(ph), float(k) * 7.3)) * 40.;
    // the fading layer's threads thin and break while the next layer's threads thicken in (no cross-blur, so threads stay crisp)
    f = max(f, laceLayer(q + off, cov * smoothstep(0., 0.5, wk), uT, 0.));
  }
  // fine grain inside the foam, and pinholes where it is thin
  f *= 0.88 + 0.16 * vnoise(q * vec2(40., 55.) + uT * 0.5);
  f *= mix(1., smoothstep(0.15, 0.4, vnoise(q * vec2(60., 80.) + uT * 0.7)), 0.5 * (1. - cov));
  return clamp(f * smoothstep(0.03, 0.3, cov), 0., 1.);
}

// glints: split the surface into small cells, give each a random slope, and light the ones that reflect the sun
float glints(vec2 p, vec2 need, float fw, float sigma, float rate){
  float acc = 0.;
  for (int l = 0; l < 2; l++){
    float cs = max(l == 0 ? 0.03 : 0.07, fw * 1.2);
    vec2 q = p / cs + float(l) * 17.3;
    vec2 id = floor(q);
    vec2 f = fract(q);
    vec3 h0 = hash32(id);
    float tt = uT * rate + h0.z * 7.;
    float tf = fract(tt);
    vec3 hr = hash32(id + floor(tt) * 1.618);
    vec2 u = hr.xy;
    // normally distributed slope via Box-Muller
    float r = sqrt(-2. * log(max(u.x, 1e-4)));
    vec2 sl = r * vec2(cos(6.2831 * u.y), sin(6.2831 * u.y)) * sigma;
    float tol = 0.08;
    float hit = exp(-dot(sl - need, sl - need) / (tol * tol));
    vec2 c = h0.xy * 0.6 + 0.2;
    float r2 = max(0.0006, pow(0.5 * fw / cs, 2.));   // dots smaller than a pixel get missed, so keep at least half a pixel
    float spot = exp(-dot(f - c, f - c) / r2) * 0.012 / r2;
    float blink = pow(sin(3.14159 * tf), 4.) * 2.67;   // each cell flashes briefly (mean 1)
    float gain = 0.2 + 2.4 * hr.z * hr.z;              // brightness varies; only a few flash strongly (mean 1)
    acc += hit * spot * blink * gain * 2.2;
  }
  return acc;
}

void main(){
  vec2 p = vP;
  float dist = length(vW - uCam);
  float fw = max(length(fwidth(p)), 1e-4);
  Surf s = surf(p);
  vec3 V = normalize(uCam - vW);
  vec3 L = uSun;

  // large-scale normal (finite differences)
  float e = max(0.02, fw * 0.8);
  float hx, hz;
  vec3 col;

  if (uIsSand > 0.5) {
    if (p.y > 70.) discard;
    hx = sandY(p + vec2(e, 0.)) - s.sand;
    hz = sandY(p + vec2(0., e)) - s.sand;
    vec3 N = normalize(vec3(-hx / e, 1., hz / e));
    // wet sand: grey, faintly reflects the sky
    float grain = fbm(p * 11.) * 0.5 + fbm(p * 45.) * 0.5;
    vec3 alb = srgb2lin(vec3(128, 121, 114)) * (0.93 + 0.1 * grain);
    vec3 diff = alb * (1.6 * max(dot(N, L), 0.) + 0.55);
    vec3 R = reflect(-V, N);
    float F = 0.02 + 0.98 * pow(1. - max(dot(N, V), 0.), 5.);
    col = diff * 0.62 + skyCol(R) * F * 0.35;
    gl_FragColor = vec4(col, 1.);
    return;
  }

  // water
  if (s.film < 0.0015 && p.y < 70.) discard;
  float h0 = s.y;
  vec3 N;
  if (p.y < 70.) {
    Surf sx = surf(p + vec2(e, 0.));
    Surf sz = surf(p + vec2(0., e));
    hx = sx.y - h0; hz = sz.y - h0;
  } else { hx = 0.; hz = 0.; }
  vec3 rp = rippleSlope(p, fw);
  float calm = mix(0.55, 1., smoothstep(0.0, 0.08, s.film)); // ripples are a little weaker on thin films
  vec2 grad = vec2(hx / e, hz / e) + rp.xy * mix(0.35, 1., calm);
  N = normalize(vec3(-grad.x, 1., grad.y));

  float NV = max(dot(N, V), 0.);
  float F = 0.02 + 0.98 * pow(1. - max(NV, 0.2), 5.);
  vec3 R = reflect(-V, N);
  if (R.y < 0.) R.y = -R.y * 0.5;
  vec3 refl = skyCol(normalize(R));
  refl = mix(refl, vec3(dot(refl, vec3(0.3, 0.5, 0.2))), 0.5);

  // under the surface: sand shows through where shallow, dark blue-green where deep
  float depth = s.film;
  float path = depth / max(0.12, NV);
  vec3 sandC = srgb2lin(vec3(118, 112, 106)) * (1.6 * max(L.y, 0.) + 0.55) * 0.62;
  vec3 absorb = vec3(3.2, 1.9, 1.8);
  vec3 trans = exp(-absorb * path * 3.2);
  vec3 turbid = mix(srgb2lin(vec3(96, 94, 84)), srgb2lin(vec3(70, 84, 60)), smoothstep(0.04, 0.2, s.film));  // the surf zone turns yellow-green with stirred-up sand
  vec3 deepC = srgb2lin(vec3(54, 78, 84));
  float surfzone = smoothstep(DB + 5., DB - 1., p.y);
  vec3 body = mix(deepC, turbid, surfzone);
  vec3 under = sandC * trans + body * (1. - trans);

  // translucent crests (backlit by the sun, glowing green)
  float thin = s.crest * smoothstep(0.15, 0.6, length(grad));
  under = mix(under, srgb2lin(vec3(58, 70, 50)), smoothstep(0.1, 0.5, length(grad)) * surfzone * smoothstep(0.08, 0.2, s.film));
  under += srgb2lin(vec3(105, 125, 62)) * thin * thin * 0.55;

  F *= mix(0.3, 0.75, calm * smoothstep(1.2, 0.2, s.film)) * mix(0.7, 1., smoothstep(0.05, 0.25, s.film));
  col = under * (1. - F) + refl * F;

  // glints: cells are fixed to the surface and flash in place (if they drift, the white dots appear to march toward the beach)
  vec3 Hh = normalize(L + V);
  vec2 needRel = vec2(-Hh.x / Hh.y, Hh.z / Hh.y) - grad;
  float sig = sqrt(0.02 + rp.z);
  float gl = glints(p, needRel, fw, sig, 0.9);   // slow twinkle
  float clump = 0.25 + 1.5 * smoothstep(0.45, 0.85, vnoise(p * vec2(0.35, 0.7) + vec2(0., -uT * 0.3)));
  gl *= clump;
  col += vec3(1.) * gl * 110. * mix(0.3, 2.8, smoothstep(6., 60., dist)) * (1. - smoothstep(0.15, 0.6, s.foam)) * (0.35 + 0.65 * smoothstep(1.5, 6., dist));   // fewer glints on foamy water
  // average of sub-pixel glints (becomes a band of light far away)
  float pdf = exp(-dot(needRel, needRel) / (2. * sig * sig)) / (6.2831 * sig * sig);
  col += vec3(1., 0.98, 0.94) * pdf * F * 2.2 * smoothstep(40., 400., dist) * clump;

  // foam
  vec2 fq = vec2(p.x, p.y + s.adv);
  float patchy = 0.55 + 0.9 * fbm(p * vec2(0.9, 1.6) + 7.);
  float cov = clamp(s.foam * patchy * 1.25, 0., 1.);
  float fm = lace(fq, cov);
  float fl = fm;   // lace foam only (excluding whitewater)
  float wn = fbm(p * vec2(5., 7.) + vec2(0., uT * 1.3)) + 0.5 * vnoise(p * vec2(30., 40.) + uT);
  float wh = smoothstep(0.25, 0.9, s.white * (0.55 + 0.7 * wn));
  fm = max(fm, wh);
  float ed = s.edge * (0.7 + 0.3 * vnoise(p * vec2(9., 30.)));
  fm = max(fm, smoothstep(0.35, 0.8, ed));
  fm *= smoothstep(0.0015, 0.006, s.film + (p.y > ZS ? 1. : 0.));
  float fshade = clamp(0.62 + 0.9 * dot(normalize(vec3(-hx / e, 1., hz / e)), normalize(vec3(L.x, 0.9, L.z))) - 0.55, 0.8, 1.);
  vec3 foamC = srgb2lin(vec3(246, 246, 243)) * fshade * (0.9 + 0.1 * fbm(p * 20.));
  // shading inside the whitewater: gaps between lumps are dark, sunlit tops are bright
  vec2 wq = p * vec2(6., 9.) + vec2(0., uT * 0.9);
  float lump = fbm(wq) * 0.6 + fbm(wq * 2.3 + 3.) * 0.4;
  float crev = smoothstep(0.32, 0.5, lump);
  float wbright = mix(0.45, 1.18, crev) * (0.9 + 0.2 * vnoise(p * vec2(40., 55.)));
  foamC *= mix(1., wbright, wh);
  // shadows on the lace foam (not applied to whitewater)
  // (1) thread shading: where foam thickness increases toward the top of the screen (farther away), the edge faces the camera and is backlit, so it is darker
  float laceW = (1. - wh) * smoothstep(0.0015, 0.006, s.film + (p.y > ZS ? 1. : 0.));
  float gy = dFdy(fl);
  float selfSh = 1. - 0.35 * smoothstep(0., 0.25, gy) + 0.06 * smoothstep(0., 0.25, -gy);
  foamC *= mix(1., selfSh, laceW);
  // (2) shadows cast on the water and sand: the sun is behind the waves 20° up, so each thread's shadow falls a few cm toward the camera
  float fsh = lace(fq + vec2(0., 0.045), cov);
  float castS = smoothstep(0.1, 0.6, fsh) * (1. - smoothstep(0.2, 0.7, fl));
  col *= 1. - 0.28 * castS * laceW;
  col = mix(col, foamC, fm * mix(0.88, 0.95, max(wh, smoothstep(0.5, 0.9, cov))));
  col += vec3(1.) * glints(p * 1.7 + 3., needRel, fw, 0.25, 4.) * (18. + 30. * wh) * fm;

  // aerial haze in the distance
  float haze = 1. - exp(-dist / 5000.);
  col = mix(col, skyCol(vec3(0., 0.001, -1.)), haze * 0.12);

  gl_FragColor = vec4(col, 1.);
}
`;

// downsample, exposure, sRGB, lens streak
export const postFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uHorizon;
uniform float uT;
varying vec2 vUv;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  vec3 c = vec3(0.);
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2( 0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5,  0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25 * uExposure;
  // bloom only the brightest spots (phone lenses and compression spread glints over a few pixels)
  vec3 bl = vec3(0.);
  float wsum = 0.;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++){
    vec2 o = vec2(x, y);
    float w = exp(-dot(o, o) / 4.5);
    vec3 v = texture2D(uTex, vUv + uTexel * o * 1.6).rgb * uExposure;
    bl += max(v - 1.2, 0.) * w;
    wsum += w;
  }
  c += min(bl / wsum, vec3(1.5)) * 1.3;
  // faint vertical streak below the sun
  float yTop = 1. - vUv.y;
  float streak = exp(-pow((vUv.x - 0.485) / 0.006, 2.)) * smoothstep(uHorizon + 0.02, 0., yTop) * 0.012;
  c += vec3(0.6, 0.8, 1.) * streak;
  // roll bright values off smoothly toward white
  c = c / (1. + max(c - 0.75, 0.) * 1.2);
  c = pow(max(c, 0.), vec3(1. / 2.2));
  c += (h12(gl_FragCoord.xy + fract(uT) * 91.) - 0.5) / 255. * 2.;
  gl_FragColor = vec4(c, 1.);
}
`;
