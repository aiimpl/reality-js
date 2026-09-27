// 波打ち際のシェーダー。水と砂は同じ格子を使い、どちらも同じ関数から高さを出す
export const NW = 9;

export const common = /* glsl */ `
#define NW ${NW}
uniform float uT;
uniform vec4 uWave[NW];   // x: 崩れる時刻  y: 波高(m)  z: 駆け上がり(m)  w: 乱数の種
uniform vec3 uSun;        // 太陽の方向
uniform vec3 uCam;

const float ZS = 4.5;     // 静水の汀線（カメラからの距離 m）
const float SLOPE = 0.06; // 浜の勾配
const float DB = 8.3;     // 波が崩れる距離
const float CB = 2.8;     // 砕波後の段波の速さ m/s
const float KOB = 0.1;    // 斜め入射：右ほど早く着く s/m
const float ACC = 1.6;    // 遡上の減速度 m/s^2

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float n1(float x){ float i = floor(x), f = fract(x); float u = f * f * (3. - 2. * f); return mix(hash12(vec2(i, 17.3)), hash12(vec2(i + 1., 17.3)), u) * 2. - 1.; }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }

float sandY(vec2 p){ // p = (x, 距離D)
  return SLOPE * (ZS - p.y) + 0.018 * sin(p.x * 0.6 + p.y * 0.35) + 0.012 * (fbm(p * 0.9) - 0.5);
}

// 1本の波が点 p に与える寄与
// eta: 海面の盛り上がり / film: 遡上した水の厚さ / foam: 残る泡の量 / crest: 波頭の近さ / edge: 遡上の先端線
// adv: 泡の流され量 / white: 白波（崩れる波頭と段波） / swf: 遡上面の泡
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
  float xi = p.y - Dc; // 正なら前線より沖側

  // 近づいてくるうねり（前が切り立ち、後ろはなだらか）と、崩れた後の段波を時間でなめらかに混ぜる
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
    // 崩れ始め：波頭のてっぺんから白くなる（前の面はまだ透けている）
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

  // 走り去った段波の後ろに残る泡
  if (tau > 0.) {
    float age = tau - (dbL - p.y) / CB;
    if (age > 0.) {
      float keep = smoothstep(dbL + 0.6, dbL - 0.4, p.y) * smoothstep(ZS - 0.3, ZS + 0.4, p.y);
      foam += 0.32 * exp(-age / 1.0) * keep;
    }
  }

  // 遡上（汀線から砂の上へ駆け上がって、引いていく）
  float tt = tau - ts;
  if (tt > 0.) {
    float R = max(0.05, w.z * (1. + 0.35 * lat));
    float v0 = sqrt(2. * ACC * R);
    float Tt = v0 / ACC;
    float life = smoothstep(2. * Tt + 0.6, 2. * Tt - 0.2, tt);
    if (life > 0.) {
      float run = v0 * tt - 0.5 * ACC * tt * tt;
      float Ee = ZS - max(run, -0.4) + 0.13 * n1(p.x * 1.05 + sd * 2.1) + 0.05 * n1(p.x * 3.7 + sd * 4.4) + 0.015 * n1(p.x * 11. + sd);
      float up = 1. - smoothstep(0., Tt, tt);          // 駆け上がり中は 1
      float thick = clamp((p.y - Ee) * mix(0.028, 0.06, up), 0., 0.12);
      thick += 0.035 * up * exp(-pow((p.y - Ee - 0.18) / 0.22, 2.)); // 先端の盛り上がり
      thick *= step(Ee, p.y) * life;
      float fw = smoothstep(ZS + 1.6, ZS - 0.2, p.y);
      film = max(film, thick * fw + (p.y > ZS ? thick * (1. - fw) : 0.));
      float cov = exp(-tt / 1.9) * (0.88 - 0.4 * smoothstep(Tt, 2. * Tt, tt));
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
  // 沖のうねり：砕波帯より沖で、岸向きに進む長い波
  float off = smoothstep(DB - 1., DB + 4., p.y);
  eta += off * (0.07 * sin(0.72 * (p.y + 0.12 * p.x) + 2.75 * uT) + 0.05 * sin(1.05 * (p.y - 0.2 * p.x) + 3.3 * uT + 1.3) + 0.035 * sin(0.55 * (p.y + 0.35 * p.x) + 2.3 * uT + 4.1));
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

// 細かいさざ波（法線だけ）。足元ほど細かい波まで拾う
export const ripples = /* glsl */ `
// 返り値: xy = 傾き, z = 描ききれない細かい波の傾きの分散（きらめきの広がりに使う）
vec3 rippleSlope(vec2 p, float fw){
  vec2 g = vec2(0.);
  float unres = 0.;
  for (int i = 0; i < 60; i++){
    float fi = float(i);
    float lam = 6.0 * pow(0.9, fi) * (0.8 + 0.4 * hash12(vec2(fi, 9.1)));   // 6m → 約0.01m
    float spread = mix(0.9, 2.8, smoothstep(3., 0.2, lam));
    float ang = (hash12(vec2(fi, 3.1)) - 0.5) * spread + 0.15;
    vec2 d = vec2(sin(ang), -cos(ang));
    float k = 6.2831853 / lam;
    float om = sqrt(9.81 * k + 0.074 / 1000. * k * k * k);
    float stp = mix(0.14, 0.05, smoothstep(1.5, 0.08, lam)) * (0.45 + 1.1 * hash12(vec2(fi, 7.7)));
    float amp = stp / k;
    float filt = smoothstep(fw * 4., fw * 9., lam);
    float ph = k * dot(d, p) - om * uT + hash12(vec2(fi, 1.3)) * 6.2831;
    float c = cos(ph), sn = sin(ph);
    // 山を尖らせる（前後の傾きを非対称に）
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
// 晴れた空の色を仰角ごとに並べたもの（sRGB）
vec3 skyCol(vec3 d){
  float e = degrees(asin(clamp(d.y, -1., 1.)));
  vec3 c0 = srgb2lin(vec3(150, 184, 200));   // 水平線ちょうど
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
  // 太陽のまわりの明るさ
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

vec2 worley(vec2 q){
  vec2 i = floor(q), f = fract(q);
  float d1 = 8., d2 = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(x, y);
    vec2 r = o + hash22(i + o) * 0.9 + 0.05 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d1), sqrt(d2));
}

// 泡の網目。cov が小さいほど穴が広がって糸だけ残る
float lace(vec2 q, float cov){
  vec2 qq = q + 0.12 * vec2(fbm(q * 1.3), fbm(q * 1.3 + 4.3));
  float v = fbm(qq * vec2(1.7, 4.4)) * 0.62 + fbm(qq * vec2(5.5, 13.) + 2.) * 0.38;
  vec2 c = worley(qq * vec2(4.2, 5.8));
  v = v * 0.8 + 0.2 * (1. - smoothstep(0.05, 0.5, c.y - c.x)) + 0.06;
  float th = 0.47 + (0.5 - cov) * 0.62 - smoothstep(0.7, 1., cov) * 0.2;
  float f = smoothstep(th - 0.012, th + 0.05, v);
  // 泡の中の濃淡と細かい粒
  f *= 0.6 + 0.4 * smoothstep(th, th + 0.12, v);
  f *= 0.78 + 0.34 * vnoise(q * vec2(40., 55.));
  // 細かい泡粒の穴
  vec2 cb = worley(qq * vec2(30., 42.));
  f *= mix(1., smoothstep(0.02, 0.2, cb.x), 0.55 * (1. - cov));
  return clamp(f * smoothstep(0.03, 0.3, cov), 0., 1.);
}

// きらめき：面を小さな区画に分け、区画ごとに乱れた傾きを持たせて太陽を映すかを決める
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
    // Box-Muller で正規分布の傾き
    float r = sqrt(-2. * log(max(u.x, 1e-4)));
    vec2 sl = r * vec2(cos(6.2831 * u.y), sin(6.2831 * u.y)) * sigma;
    float tol = 0.08;
    float hit = exp(-dot(sl - need, sl - need) / (tol * tol));
    vec2 c = h0.xy * 0.6 + 0.2;
    float r2 = max(0.012, pow(0.5 * fw / cs, 2.));   // 画素より小さい点は取りこぼすので、半画素より小さくしない
    float spot = exp(-dot(f - c, f - c) / r2) * 0.012 / r2;
    float blink = sin(3.14159 * tf);   // 区画ごとに光っては消える
    acc += hit * spot * blink * 2.2;
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

  // 大きな形の法線（有限差分）
  float e = max(0.02, fw * 0.8);
  float hx, hz;
  vec3 col;

  if (uIsSand > 0.5) {
    if (p.y > 70.) discard;
    hx = sandY(p + vec2(e, 0.)) - s.sand;
    hz = sandY(p + vec2(0., e)) - s.sand;
    vec3 N = normalize(vec3(-hx / e, 1., hz / e));
    // 濡れた砂：灰色で、空を薄く映し、ところどころ光る
    float grain = fbm(p * 11.) * 0.5 + fbm(p * 45.) * 0.5;
    vec3 alb = srgb2lin(vec3(128, 121, 114)) * (0.93 + 0.1 * grain);
    vec3 diff = alb * (1.6 * max(dot(N, L), 0.) + 0.55);
    vec3 R = reflect(-V, N);
    float F = 0.02 + 0.98 * pow(1. - max(dot(N, V), 0.), 5.);
    col = diff * 0.62 + skyCol(R) * F * 0.35;
    vec3 Hh = normalize(L + V);
    vec2 need = vec2(-Hh.x / Hh.y, Hh.z / Hh.y) - vec2(hx / e, hz / e);
    col += vec3(1.) * glints(p * 2.4 + 5., need, fw, 0.3, 1.5) * 4.;
    gl_FragColor = vec4(col, 1.);
    return;
  }

  // 水
  if (s.film < 0.0015 && p.y < 70.) discard;
  float h0 = s.y;
  vec3 N;
  if (p.y < 70.) {
    Surf sx = surf(p + vec2(e, 0.));
    Surf sz = surf(p + vec2(0., e));
    hx = sx.y - h0; hz = sz.y - h0;
  } else { hx = 0.; hz = 0.; }
  vec3 rp = rippleSlope(p, fw);
  float calm = mix(0.55, 1., smoothstep(0.0, 0.08, s.film)); // 薄い膜はさざ波がやや弱い
  vec2 grad = vec2(hx / e, hz / e) + rp.xy * mix(0.35, 1., calm);
  N = normalize(vec3(-grad.x, 1., grad.y));

  float NV = max(dot(N, V), 0.);
  float F = 0.02 + 0.98 * pow(1. - max(NV, 0.2), 5.);
  vec3 R = reflect(-V, N);
  if (R.y < 0.) R.y = -R.y * 0.5;
  vec3 refl = skyCol(normalize(R));
  refl = mix(refl, vec3(dot(refl, vec3(0.3, 0.5, 0.2))), 0.5);

  // 水の中：浅いところは砂が透け、深いと暗い青緑
  float depth = s.film;
  float path = depth / max(0.12, NV);
  vec3 sandC = srgb2lin(vec3(118, 112, 106)) * (1.6 * max(L.y, 0.) + 0.55) * 0.62;
  vec3 absorb = vec3(3.2, 1.9, 1.8);
  vec3 trans = exp(-absorb * path * 3.2);
  vec3 turbid = mix(srgb2lin(vec3(96, 94, 84)), srgb2lin(vec3(70, 84, 60)), smoothstep(0.04, 0.2, s.film));  // 砕波帯は砂が舞って黄緑がかる
  vec3 deepC = srgb2lin(vec3(54, 78, 84));
  float surfzone = smoothstep(DB + 5., DB - 1., p.y);
  vec3 body = mix(deepC, turbid, surfzone);
  vec3 under = sandC * trans + body * (1. - trans);

  // 波頭の透け（向こうから日が差して緑に光る）
  float thin = s.crest * smoothstep(0.15, 0.6, length(grad));
  under = mix(under, srgb2lin(vec3(58, 70, 50)), smoothstep(0.1, 0.5, length(grad)) * surfzone * smoothstep(0.08, 0.2, s.film));
  under += srgb2lin(vec3(105, 125, 62)) * thin * thin * 0.55;

  F *= mix(0.3, 0.75, calm * smoothstep(1.2, 0.2, s.film)) * mix(0.7, 1., smoothstep(0.05, 0.25, s.film));
  col = under * (1. - F) + refl * F;

  // きらめき
  vec3 Hh = normalize(L + V);
  vec2 needRel = vec2(-Hh.x / Hh.y, Hh.z / Hh.y) - grad;
  float sig = sqrt(0.02 + rp.z);
  float gl = glints(p + vec2(0., uT * 0.15), needRel, fw, sig, 2.2);
  float clump = 0.25 + 1.5 * smoothstep(0.45, 0.85, vnoise(p * vec2(0.35, 0.7) + vec2(0., -uT * 0.6)));
  gl *= clump;
  col += vec3(1.) * gl * 110. * mix(0.3, 2.8, smoothstep(6., 60., dist)) * (1. - smoothstep(0.5, 1.2, s.foam));
  // 画素より細かいきらめきの平均（遠くで光の帯になる）
  float pdf = exp(-dot(needRel, needRel) / (2. * sig * sig)) / (6.2831 * sig * sig);
  col += vec3(1., 0.98, 0.94) * pdf * F * 2.2 * smoothstep(40., 400., dist) * clump;

  // 泡
  vec2 fq = vec2(p.x, p.y + s.adv);
  float patchy = 0.55 + 0.9 * fbm(p * vec2(0.9, 1.6) + 7.);
  float cov = clamp(s.foam * patchy, 0., 1.);
  float fm = lace(fq, cov);
  float wn = fbm(p * vec2(5., 7.) + vec2(0., uT * 1.3)) + 0.5 * vnoise(p * vec2(30., 40.) + uT);
  float wh = smoothstep(0.25, 0.9, s.white * (0.55 + 0.7 * wn));
  fm = max(fm, wh);
  float ed = s.edge * (0.7 + 0.3 * vnoise(p * vec2(9., 30.)));
  fm = max(fm, smoothstep(0.35, 0.8, ed));
  fm *= smoothstep(0.0015, 0.006, s.film + (p.y > ZS ? 1. : 0.));
  float fshade = clamp(0.62 + 0.9 * dot(normalize(vec3(-hx / e, 1., hz / e)), normalize(vec3(L.x, 0.9, L.z))) - 0.55, 0.8, 1.);
  vec3 foamC = srgb2lin(vec3(246, 246, 243)) * fshade * (0.9 + 0.1 * fbm(p * 20.));
  // 白波の中の陰と光：泡の塊の隙間は暗く、日の当たる頭は明るい
  vec2 wq = p * vec2(6., 9.) + vec2(0., uT * 0.9);
  float lump = fbm(wq) * 0.6 + fbm(wq * 2.3 + 3.) * 0.4;
  float crev = smoothstep(0.32, 0.5, lump);
  float wbright = mix(0.45, 1.18, crev) * (0.9 + 0.2 * vnoise(p * vec2(40., 55.)));
  foamC *= mix(1., wbright, wh);
  col = mix(col, foamC, fm * mix(0.72, 0.95, max(wh, smoothstep(0.5, 0.9, cov))));
  col += vec3(1.) * glints(p * 1.7 + 3., needRel, fw, 0.25, 4.) * (18. + 30. * wh) * fm;

  // 遠くは空気で白む
  float haze = 1. - exp(-dist / 5000.);
  col = mix(col, skyCol(vec3(0., 0.001, -1.)), haze * 0.12);

  gl_FragColor = vec4(col, 1.);
}
`;

// 縮小・露出・sRGB・レンズの縦筋
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
  // 明るすぎる所だけ周りへにじませる（スマホのレンズと圧縮で、きらめきが数画素に広がるのに合わせる）
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
  // 太陽の真下に出る薄い縦筋
  float yTop = 1. - vUv.y;
  float streak = exp(-pow((vUv.x - 0.485) / 0.006, 2.)) * smoothstep(uHorizon + 0.02, 0., yTop) * 0.012;
  c += vec3(0.6, 0.8, 1.) * streak;
  // 明るすぎる所はなだらかに白へ
  c = c / (1. + max(c - 0.75, 0.) * 1.2);
  c = pow(max(c, 0.), vec3(1. / 2.2));
  c += (h12(gl_FragCoord.xy + fract(uT) * 91.) - 0.5) / 255. * 2.;
  gl_FragColor = vec4(c, 1.);
}
`;
