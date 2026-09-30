import * as THREE from 'three';
import { NW, vert, frag, skyVert, skyFrag, postFrag } from './shaders.js';
import { STEP, SKY, HORIZON, ROLL } from './track.js';

// ---- settings ----
const params = new URLSearchParams(location.search);
const OFFLINE = params.has('render');           // export mode (high quality, time is passed in from outside)
const W = OFFLINE ? 1920 : Math.min(innerWidth * devicePixelRatio, 1920);
const H = OFFLINE ? 1080 : Math.round(W * 9 / 16);
const SS = OFFLINE ? 2 : 1;                      // render at 2x and downsample
const SUB = OFFLINE ? 3 : 1;                     // sub-frames averaged per frame
const SHUTTER = 1 / 120;
const VFOV = 42;
const CAM_Y = 0.24 + 0.92;                       // 0.92 m above the sand at the camera
const LOOP = 21.2;

// wave list: break time (at screen center), wave height, run-up distance, random seed
// placed so the run-up reaches the camera (about 3.3 m) at 2.2 / 5.6 / 8.0 / 9.7 / 13.2 / 17.7 s
const WAVES = [
  [-3.61, 0.34, 2.3, 0.11],
  [0.18, 0.39, 3.3, 0.37],
  [3.43, 0.30, 2.6, 0.59],
  [5.96, 0.37, 3.1, 0.83],
  [7.66, 0.37, 3.1, 0.23],
  [11.18, 0.41, 3.2, 0.71],
  [15.68, 0.39, 3.2, 0.47],
  [19.45, 0.37, 2.9, 0.91],
  [22.89, 0.34, 2.3, 0.15],
];

const sunElev = THREE.MathUtils.degToRad(20);
const sunAz = THREE.MathUtils.degToRad(-1.5);
const sun = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunElev), Math.sin(sunElev), -Math.cos(sunAz) * Math.cos(sunElev));

// ---- renderer setup ----
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(VFOV, W / H, 0.05, 20000);
camera.rotation.order = 'YXZ';
camera.position.set(0, CAM_Y, 0);

const uniforms = {
  uT: { value: 0 },
  uWave: { value: WAVES.map((w) => new THREE.Vector4(...w)) },
  uSun: { value: sun },
  uCam: { value: camera.position },
};
if (WAVES.length !== NW) throw new Error('wave count does not match NW');

// grid shared by water and sand: finer near the camera, reaching past the horizon
function makeGrid(rows, cols, dMin, dMax) {
  const pos = new Float32Array(rows * cols * 3);
  const r = Math.pow(dMax / dMin, 1 / (rows - 1));
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const d = dMin * Math.pow(r, j);
    const half = d * 0.8 + 1.2;
    for (let i = 0; i < cols; i++) {
      pos[k++] = (i / (cols - 1) * 2 - 1) * half;
      pos[k++] = 0;
      pos[k++] = d;
    }
  }
  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  k = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = c;
    idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}
const grid = OFFLINE ? makeGrid(1100, 620, 0.6, 9000) : makeGrid(700, 360, 0.6, 9000);

const scene = new THREE.Scene();
const mk = (isSand) => new THREE.ShaderMaterial({
  vertexShader: vert, fragmentShader: frag,
  uniforms: { ...uniforms, uIsSand: { value: isSand ? 1 : 0 } },
  extensions: { derivatives: true },
  polygonOffset: !isSand, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});
const sand = new THREE.Mesh(grid, mk(true));
const water = new THREE.Mesh(grid, mk(false));
sand.frustumCulled = water.frustumCulled = false;
water.renderOrder = 1;
scene.add(sand, water);

const skyMat = new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms, depthWrite: false, side: THREE.BackSide });
const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), skyMat);
sky.renderOrder = -1;
sky.frustumCulled = false;
scene.add(sky);

// render at high resolution and accumulate sub-frames
const rtOpt = { type: THREE.HalfFloatType, depthBuffer: true };
const rtScene = new THREE.WebGLRenderTarget(W * SS, H * SS, { ...rtOpt, samples: OFFLINE ? 4 : 0 });
const rtAcc = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.FloatType, depthBuffer: false });
const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
const accMat = new THREE.ShaderMaterial({
  vertexShader: quadVert,
  fragmentShader: 'uniform sampler2D uTex; uniform float uW; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uW, 1.); }',
  uniforms: { uTex: { value: rtScene.texture }, uW: { value: 1 / SUB } },
  blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
});
const postMat = new THREE.ShaderMaterial({
  vertexShader: quadVert, fragmentShader: postFrag,
  uniforms: { uTex: { value: rtAcc.texture }, uTexel: { value: new THREE.Vector2(1 / (W * SS), 1 / (H * SS)) }, uExposure: { value: 1 }, uHorizon: { value: 0.3 }, uT: uniforms.uT },
  depthTest: false, depthWrite: false,
});
const quadScene = new THREE.Scene();
const quad = new THREE.Mesh(quadGeo, accMat);
quad.frustumCulled = false;
quadScene.add(quad);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// camera orientation and exposure (interpolated from the table in track.js)
function track(arr, t) {
  const f = Math.min(Math.max(t / STEP, 0), arr.length - 1.001);
  const i = Math.floor(f);
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}
function setCamera(t) {
  const h = track(HORIZON, t);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(VFOV / 2));
  const pitch = Math.atan((1 - 2 * h) * tanHalf);
  camera.rotation.x = -pitch;
  camera.rotation.y = 0;
  camera.rotation.z = THREE.MathUtils.degToRad(track(ROLL, t));
  camera.updateMatrixWorld();
  const sky = track(SKY, t);
  postMat.uniforms.uExposure.value = Math.pow(sky / 157, 2.2);
  postMat.uniforms.uHorizon.value = h;
}

function renderAt(t) {
  renderer.setRenderTarget(rtAcc);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  for (let s = 0; s < SUB; s++) {
    const ts = t + (SUB > 1 ? (s / (SUB - 1) - 0.5) * SHUTTER : 0);
    uniforms.uT.value = ts;
    setCamera(ts);
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(rtAcc);
    quad.material = accMat;
    renderer.render(quadScene, ortho);
  }
  uniforms.uT.value = t;
  setCamera(t);
  renderer.setRenderTarget(null);
  quad.material = postMat;
  renderer.render(quadScene, ortho);
}

window.renderAt = (t) => {
  renderAt(t);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait until rendering finishes
  return true;
};
window.ready = true;

if (!OFFLINE) {
  const t0 = performance.now();
  const start = Number(params.get('t') || 0);
  const loop = () => {
    renderAt((start + (performance.now() - t0) / 1000) % LOOP);
    requestAnimationFrame(loop);
  };
  loop();
}
