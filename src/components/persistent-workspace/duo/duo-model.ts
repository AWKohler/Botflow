// The iPhone Duo as a three.js object, built from primitives — no model file.
// Building it here keeps the download to nothing, lets the inner panel bend
// with the hinge as one sheet, and means every surface the user can touch
// (two screens, three buttons) is something this code placed and can map back
// to the simulator exactly.
//
// Everything is in the device frame described in duo-geometry.ts (millimetres,
// camera half fixed, cover half turning about the hinge).

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  DUO,
  HINGE_AXIS_Z,
  INNER_FACE_Z,
  innerFacePoint,
  type DuoDisplay,
} from "./duo-geometry";

export type DuoButton = "lock" | "volumeUp" | "volumeDown";

export interface DuoFinish {
  /** Brushed metal band around each half. */
  frame: number;
  /** Frosted glass back of the camera half and the camera plateau. */
  back: number;
  /** Side buttons. */
  button: number;
  frameRoughness: number;
}

/** The colours the device comes in here. */
export const DUO_FINISHES = {
  natural: { frame: 0xc9c5bd, back: 0xdcd8d0, button: 0xbfbbb3, frameRoughness: 0.34 },
  graphite: { frame: 0x4a4b4f, back: 0x2e2f33, button: 0x45464a, frameRoughness: 0.38 },
} satisfies Record<string, DuoFinish>;
export type DuoFinishId = keyof typeof DUO_FINISHES;

const W = DUO.halfWidth;
const H = DUO.height;
const T = DUO.thickness;
/** Glass and plates sit this far inside the frame's outline. */
const RIM = 0.75;
/** …and this far proud of the slab, so they never fight it for depth. */
const SKIN = 0.012;

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * A rectangle with a radius per corner, drawn with the slightly squarer,
 * longer-running curve Apple hardware uses rather than a plain arc.
 * Radii: [top-left, top-right, bottom-right, bottom-left].
 */
function roundedRectShape(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radii: [number, number, number, number],
): THREE.Shape {
  const limit = Math.min(x1 - x0, y1 - y0) / 2;
  const [tl, tr, br, bl] = radii.map((r) => {
    const radius = Math.min(r, limit / 1.3);
    return { e: radius * 1.3, c: radius * 0.348 };
  });
  const s = new THREE.Shape();
  s.moveTo(x0 + bl.e, y0);
  s.lineTo(x1 - br.e, y0);
  s.bezierCurveTo(x1 - br.c, y0, x1, y0 + br.c, x1, y0 + br.e);
  s.lineTo(x1, y1 - tr.e);
  s.bezierCurveTo(x1, y1 - tr.c, x1 - tr.c, y1, x1 - tr.e, y1);
  s.lineTo(x0 + tl.e, y1);
  s.bezierCurveTo(x0 + tl.c, y1, x0, y1 - tl.c, x0, y1 - tl.e);
  s.lineTo(x0, y0 + bl.e);
  s.bezierCurveTo(x0, y0 + bl.c, x0 + bl.c, y0, x0 + bl.e, y0);
  return s;
}

/** One half's outline, seen from the inner side. `inset` shrinks it evenly. */
function halfOutline(side: "camera" | "cover", inset = 0): THREE.Shape {
  const outer = Math.max(0.2, DUO.cornerRadius - inset);
  const hinge = Math.max(0.2, DUO.hingeCornerRadius - inset);
  return side === "camera"
    ? roundedRectShape(inset, -H / 2 + inset, W - inset, H / 2 - inset, [hinge, outer, outer, hinge])
    : roundedRectShape(-W + inset, -H / 2 + inset, -inset, H / 2 - inset, [outer, hinge, hinge, outer]);
}

/** A half's metal slab: the outline pushed through the thickness, edges eased. */
function slabGeometry(side: "camera" | "cover"): THREE.ExtrudeGeometry {
  const b = DUO.edgeBevel;
  const g = new THREE.ExtrudeGeometry(halfOutline(side), {
    depth: T - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 5,
    curveSegments: 20,
  });
  g.translate(0, 0, -T / 2 + b);
  return g;
}

/**
 * A plate on a half's back. The half's outline is symmetric top to bottom, so
 * turning the flat shape over about X keeps it in place and faces it backwards.
 */
function backPlateGeometry(side: "camera" | "cover"): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(halfOutline(side, RIM), 20);
  g.rotateX(Math.PI);
  g.translate(0, 0, -T / 2 - SKIN);
  return g;
}

// ── Screens ─────────────────────────────────────────────────────────────────

const SCREEN_VERTEX = /* glsl */ `
  varying vec2 vFlat;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  void main() {
    vFlat = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// One shader draws a whole glass face: the panel's picture inside its rounded
// rectangle, black glass around it, the face's own rounded outline, and a
// faint studio reflection that grows at glancing angles the way glass does.
// The picture is passed through untouched — no tone mapping, no lighting — so
// the app looks exactly as it does on the device.
const SCREEN_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec2 uOutlineCenter;
  uniform vec2 uOutlineHalf;
  uniform vec2 uOutlineRadii;   // corners at −x, corners at +x
  uniform vec2 uScreenCenter;
  uniform vec2 uScreenHalf;
  uniform vec2 uScreenRadii;
  uniform mat3 uFlatToFramebuffer;
  uniform vec3 uGlass;
  uniform float uSheen;
  uniform float uDim;
  varying vec2 vFlat;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  float roundedBox(vec2 p, vec2 halfSize, vec2 radii) {
    float r = p.x < 0.0 ? radii.x : radii.y;
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  // A room to reflect: a broad light overhead, a window up and to the left,
  // a little glow along the horizon.
  float room(vec3 r) {
    float overhead = smoothstep(0.45, 0.97, r.y);
    float window = smoothstep(0.86, 0.992, dot(r, normalize(vec3(-0.65, 0.45, 0.6))));
    float horizon = 0.25 * (1.0 - abs(r.y));
    return 0.2 * horizon + 1.3 * overhead + 1.8 * window;
  }

  void main() {
    float outline = roundedBox(vFlat - uOutlineCenter, uOutlineHalf, uOutlineRadii);
    float edge = max(fwidth(outline), 1e-4);
    float alpha = 1.0 - smoothstep(-edge, edge, outline);
    if (alpha < 0.003) discard;

    float panel = roundedBox(vFlat - uScreenCenter, uScreenHalf, uScreenRadii);
    float inPanel = 1.0 - smoothstep(-edge * 0.75, edge * 0.75, panel);

    vec2 fb = (uFlatToFramebuffer * vec3(vFlat, 1.0)).xy;
    vec3 picture = texture2D(uMap, clamp(fb, 0.0, 1.0)).rgb;
    // With no picture yet the panel is not quite as black as the glass around
    // it. Once there is one it is always shown: a panel iOS has switched off
    // streams black anyway, and whether it is "off" is only a guess from its
    // pixels, which must never hide an app that happens to be dark.
    vec3 off = uGlass + vec3(0.006, 0.006, 0.008);
    vec3 color = mix(uGlass, mix(off, picture * (1.0 - uDim), uHasMap), inPanel);

    vec3 n = normalize(gl_FrontFacing ? vWorldNormal : -vWorldNormal);
    vec3 v = normalize(cameraPosition - vWorldPosition);
    float facing = max(dot(n, v), 0.0);
    float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
    color += uSheen * fresnel * room(reflect(-v, n));

    gl_FragColor = vec4(color, alpha);
  }
`;

interface ScreenFaceLayout {
  outlineCenter: [number, number];
  outlineHalf: [number, number];
  outlineRadii: [number, number];
  screenCenter: [number, number];
  screenHalf: [number, number];
  screenRadii: [number, number];
  /** Row-major 3×3: flat (x, y, 1) → framebuffer (u, v, 1). */
  flatToFramebuffer: [number, number, number, number, number, number, number, number, number];
}

function screenMaterial(layout: ScreenFaceLayout): THREE.ShaderMaterial {
  const m = layout.flatToFramebuffer;
  return new THREE.ShaderMaterial({
    vertexShader: SCREEN_VERTEX,
    fragmentShader: SCREEN_FRAGMENT,
    transparent: true,
    uniforms: {
      uMap: { value: null },
      uHasMap: { value: 0 },
      uOutlineCenter: { value: new THREE.Vector2(...layout.outlineCenter) },
      uOutlineHalf: { value: new THREE.Vector2(...layout.outlineHalf) },
      uOutlineRadii: { value: new THREE.Vector2(...layout.outlineRadii) },
      uScreenCenter: { value: new THREE.Vector2(...layout.screenCenter) },
      uScreenHalf: { value: new THREE.Vector2(...layout.screenHalf) },
      uScreenRadii: { value: new THREE.Vector2(...layout.screenRadii) },
      // Matrix3.set takes rows.
      uFlatToFramebuffer: { value: new THREE.Matrix3().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]) },
      uGlass: { value: new THREE.Color(0x030304) },
      uSheen: { value: 0.5 },
      uDim: { value: 0 },
    },
  });
}

/** Columns of the inner face's grid: fine across the bend, coarse elsewhere. */
function innerFaceColumns(): number[] {
  const edge = W - RIM;
  const t0 = DUO.bendHalfWidth;
  const xs: number[] = [-edge, -edge / 2, -t0 * 2.5];
  const bendSegments = 36;
  for (let i = 0; i <= bendSegments; i++) xs.push(-t0 + (2 * t0 * i) / bendSegments);
  xs.push(t0 * 2.5, edge / 2, edge);
  return xs;
}

// ── The model ───────────────────────────────────────────────────────────────

export interface DuoModelButton {
  button: DuoButton;
  mesh: THREE.Mesh;
  rest: THREE.Vector3;
  /** Unit direction the button travels when pressed. */
  inward: THREE.Vector3;
}

export interface DuoModel {
  /** The device frame. Parent this; do not move its children. */
  root: THREE.Group;
  screens: Record<DuoDisplay, { mesh: THREE.Mesh; material: THREE.ShaderMaterial }>;
  buttons: DuoModelButton[];
  /** Solid parts of each half: holding one of these drags the hinge. */
  halves: { camera: THREE.Object3D[]; cover: THREE.Object3D[] };
  /** Pose the model for a fold (radians from flat; see duo-geometry). */
  setFold(beta: number): void;
  setFinish(finish: DuoFinishId): void;
  dispose(): void;
}

export function buildDuoModel(finishId: DuoFinishId = "natural"): DuoModel {
  const root = new THREE.Group();
  const cameraHalf = new THREE.Group();
  const coverHalf = new THREE.Group();
  root.add(cameraHalf, coverHalf);
  const disposables: Array<{ dispose(): void }> = [];
  const track = <G extends { dispose(): void }>(g: G): G => {
    disposables.push(g);
    return g;
  };

  // Materials ---------------------------------------------------------------
  const frame = track(new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.34 }));
  const backGlass = track(
    new THREE.MeshPhysicalMaterial({ metalness: 0, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  );
  const buttonMetal = track(new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.28 }));
  // The hinge's back is seen from outside only, but its end caps face along
  // the hinge; drawing both sides spares working out a winding per fold.
  const spineMetal = track(new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.42, side: THREE.DoubleSide }));
  const blackGlass = track(
    new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04 }),
  );
  const lensRing = track(new THREE.MeshStandardMaterial({ color: 0x9b9891, metalness: 1, roughness: 0.2 }));
  const lensGlass = track(
    new THREE.MeshPhysicalMaterial({ color: 0x0a0c12, metalness: 0.2, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02 }),
  );
  const lensCore = track(new THREE.MeshPhysicalMaterial({ color: 0x1a2140, metalness: 0.6, roughness: 0.12, clearcoat: 1 }));
  const flash = track(new THREE.MeshStandardMaterial({ color: 0xf2e8cf, roughness: 0.4, emissive: 0x33301f }));

  const setFinish = (id: DuoFinishId): void => {
    const f: DuoFinish = DUO_FINISHES[id];
    frame.color.setHex(f.frame);
    frame.roughness = f.frameRoughness;
    spineMetal.color.setHex(f.frame).multiplyScalar(0.92);
    backGlass.color.setHex(f.back);
    buttonMetal.color.setHex(f.button);
    lensRing.color.setHex(id === "graphite" ? 0x3a3b3f : 0x9b9891);
  };
  setFinish(finishId);

  // Bodies ------------------------------------------------------------------
  const cameraSlab = new THREE.Mesh(track(slabGeometry("camera")), frame);
  const coverSlab = new THREE.Mesh(track(slabGeometry("cover")), frame);
  cameraHalf.add(cameraSlab);
  coverHalf.add(coverSlab);

  const cameraBack = new THREE.Mesh(track(backPlateGeometry("camera")), backGlass);
  cameraHalf.add(cameraBack);

  // Camera plateau and lenses, on the camera half's back near the top. Shapes
  // for the back are drawn mirrored in x and then turned about Y, which puts
  // them where intended while facing them backwards.
  const backZ = -T / 2 - SKIN;
  const plateauDepth = 2.6;
  const plateau = { x0: 24, x1: 77.2, y0: 33.4, y1: 54.1 };
  const plateauGeometry = track(
    new THREE.ExtrudeGeometry(roundedRectShape(-plateau.x1, plateau.y0, -plateau.x0, plateau.y1, [9.6, 9.6, 9.6, 9.6]), {
      depth: plateauDepth - 0.7,
      bevelEnabled: true,
      bevelThickness: 0.7,
      bevelSize: 0.7,
      bevelOffset: -0.7,
      bevelSegments: 4,
      curveSegments: 16,
    }),
  );
  plateauGeometry.rotateY(Math.PI);
  plateauGeometry.translate(0, 0, backZ);
  const plateauMesh = new THREE.Mesh(plateauGeometry, backGlass);
  cameraHalf.add(plateauMesh);

  const plateauTop = backZ - plateauDepth;
  const lensParts: THREE.Object3D[] = [];
  const disc = (radius: number, height: number, material: THREE.Material, x: number, y: number, zTop: number): THREE.Mesh => {
    const g = track(new THREE.CylinderGeometry(radius, radius, height, 48));
    g.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(x, y, zTop + height / 2);
    cameraHalf.add(mesh);
    lensParts.push(mesh);
    return mesh;
  };
  for (const cx of [67.0, 49.2]) {
    const cy = 43.75;
    const ringTop = plateauTop - 2.0;
    disc(8.15, 2.0, lensRing, cx, cy, ringTop);
    disc(6.9, 0.3, lensGlass, cx, cy, ringTop - 0.12);
    disc(3.5, 0.2, lensCore, cx, cy, ringTop - 0.2);
    disc(1.5, 0.12, lensGlass, cx, cy, ringTop - 0.26);
  }
  disc(1.9, 0.25, flash, 32.6, 39.3, plateauTop - 0.1);
  disc(0.55, 0.2, lensGlass, 32.6, 48.0, plateauTop - 0.05);

  // Side buttons, all on the camera half: power and camera control on its
  // outer edge, volume on its top edge.
  const buttons: DuoModelButton[] = [];
  const sideButton = (
    button: DuoButton | null,
    size: [number, number, number],
    position: [number, number, number],
    inward: [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh => {
    const g = track(new RoundedBoxGeometry(size[0], size[1], size[2], 4, Math.min(...size) * 0.45));
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(...position);
    cameraHalf.add(mesh);
    if (button) {
      buttons.push({ button, mesh, rest: mesh.position.clone(), inward: new THREE.Vector3(...inward) });
    }
    return mesh;
  };
  sideButton("lock", [1.5, 18.2, 2.5], [W + 0.25, 16.0, 0], [-1, 0, 0], buttonMetal);
  const cameraControl = sideButton(null, [0.9, 17.1, 2.7], [W - 0.2, -26.1, 0], [-1, 0, 0], blackGlass);
  sideButton("volumeUp", [10.9, 1.5, 2.5], [56.05, H / 2 + 0.25, 0], [0, -1, 0], buttonMetal);
  sideButton("volumeDown", [10.9, 1.5, 2.5], [42.65, H / 2 + 0.25, 0], [0, -1, 0], buttonMetal);

  // Cover face: black glass over the cover half's back, with the cover panel
  // in it. A plain quad; the shader rounds its corners and places the picture.
  const coverGlass = { x0: -W + RIM, x1: -RIM, y0: -H / 2 + RIM, y1: H / 2 - RIM };
  const coverGeometry = track(new THREE.BufferGeometry());
  const cz = -T / 2 - SKIN;
  coverGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [coverGlass.x0, coverGlass.y0, cz, coverGlass.x1, coverGlass.y0, cz, coverGlass.x1, coverGlass.y1, cz, coverGlass.x0, coverGlass.y1, cz],
      3,
    ),
  );
  coverGeometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
  // `uv` carries the flat position, which the shader and the touch mapping use.
  coverGeometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      [coverGlass.x0, coverGlass.y0, coverGlass.x1, coverGlass.y0, coverGlass.x1, coverGlass.y1, coverGlass.x0, coverGlass.y1],
      2,
    ),
  );
  coverGeometry.setIndex([0, 2, 1, 0, 3, 2]); // wound to face −Z
  const cover = DUO.cover;
  const coverMaterial = track(
    screenMaterial({
      outlineCenter: [-W / 2, 0],
      outlineHalf: [W / 2 - RIM, H / 2 - RIM],
      // −x is the outer edge, +x the hinge.
      outlineRadii: [DUO.cornerRadius - RIM, Math.max(0.3, DUO.hingeCornerRadius - RIM)],
      screenCenter: [-(cover.hingeInset + cover.width / 2), 0],
      screenHalf: [cover.width / 2, cover.height / 2],
      screenRadii: [cover.cornerRadiusOuter, cover.cornerRadiusHinge],
      // u = (−x − inset) / width, v = (height/2 − y) / height
      flatToFramebuffer: [-1 / cover.width, 0, -cover.hingeInset / cover.width, 0, -1 / cover.height, 0.5, 0, 0, 1],
    }),
  );
  const coverFace = new THREE.Mesh(coverGeometry, coverMaterial);
  coverHalf.add(coverFace);

  // Inner face: one sheet across both halves that bends at the fold. Its
  // vertices are recomputed whenever the fold changes.
  const columns = innerFaceColumns();
  const rows = [-(H / 2 - RIM), H / 2 - RIM];
  const innerGeometry = track(new THREE.BufferGeometry());
  const innerPositions = new Float32Array(columns.length * rows.length * 3);
  const innerNormals = new Float32Array(columns.length * rows.length * 3);
  const innerFlat = new Float32Array(columns.length * rows.length * 2);
  const innerIndex: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const i = r * columns.length + c;
      innerFlat[i * 2] = columns[c];
      innerFlat[i * 2 + 1] = rows[r];
    }
  }
  for (let c = 0; c < columns.length - 1; c++) {
    const a = c;
    const b = c + 1;
    const d = columns.length + c;
    const e = columns.length + c + 1;
    innerIndex.push(a, b, e, a, e, d); // faces +Z when flat
  }
  innerGeometry.setAttribute("position", new THREE.BufferAttribute(innerPositions, 3));
  innerGeometry.setAttribute("normal", new THREE.BufferAttribute(innerNormals, 3));
  innerGeometry.setAttribute("uv", new THREE.BufferAttribute(innerFlat, 2));
  innerGeometry.setIndex(innerIndex);
  const inner = DUO.inner;
  const innerMaterial = track(
    screenMaterial({
      outlineCenter: [0, 0],
      outlineHalf: [W - RIM, H / 2 - RIM],
      outlineRadii: [DUO.cornerRadius - RIM, DUO.cornerRadius - RIM],
      screenCenter: [0, 0],
      screenHalf: [inner.width / 2, inner.height / 2],
      screenRadii: [inner.cornerRadius, inner.cornerRadius],
      // u = (height/2 − y) / height, v = (width/2 − x) / width
      flatToFramebuffer: [0, -1 / inner.height, 0.5, -1 / inner.width, 0, 0.5, 0, 0, 1],
    }),
  );
  const innerFace = new THREE.Mesh(innerGeometry, innerMaterial);
  innerFace.frustumCulled = false; // its bounds change with every fold
  root.add(innerFace);

  // Hinge spine: the rounded back of the hinge, which shows between the halves
  // as they close. A wedge of a cylinder about the hinge axis, exactly as wide
  // as the gap that has opened.
  const spineSegments = 28;
  const spineRadius = HINGE_AXIS_Z + T / 2 - 0.02;
  // A plain arc about the hinge would stand a full half-thickness proud of the
  // closed device, like a thick rail. The real hinge is flatter: so the arc is
  // pulled in towards the axis in its middle, more the further it has closed,
  // until shut it stands out only this far.
  const spineProud = 2.3;
  const spineHalfLength = H / 2 - 1.4;
  // Curved wall: two rings of (segments + 1). Caps: a centre plus a ring each.
  const wallVerts = (spineSegments + 1) * 2;
  const capVerts = spineSegments + 2;
  const spinePositions = new Float32Array((wallVerts + capVerts * 2) * 3);
  const spineNormals = new Float32Array((wallVerts + capVerts * 2) * 3);
  const spineIndex: number[] = [];
  for (let i = 0; i < spineSegments; i++) {
    const a = i * 2;
    spineIndex.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const capTop = wallVerts;
  const capBottom = wallVerts + capVerts;
  for (let i = 0; i < spineSegments; i++) {
    spineIndex.push(capTop, capTop + 1 + i, capTop + 2 + i);
    spineIndex.push(capBottom, capBottom + 2 + i, capBottom + 1 + i);
  }
  const spineGeometry = track(new THREE.BufferGeometry());
  spineGeometry.setAttribute("position", new THREE.BufferAttribute(spinePositions, 3));
  spineGeometry.setAttribute("normal", new THREE.BufferAttribute(spineNormals, 3));
  spineGeometry.setIndex(spineIndex);
  const spine = new THREE.Mesh(spineGeometry, spineMetal);
  spine.frustumCulled = false;
  root.add(spine);

  const setFold = (beta: number): void => {
    // Cover half: turn about the hinge axis (x = 0, z = HINGE_AXIS_Z).
    coverHalf.rotation.set(0, beta, 0);
    coverHalf.position.set(-HINGE_AXIS_Z * Math.sin(beta), 0, HINGE_AXIS_Z * (1 - Math.cos(beta)));

    // Inner face.
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < columns.length; c++) {
        const i = (r * columns.length + c) * 3;
        const { position, normal } = innerFacePoint(columns[c], rows[r], beta, SKIN);
        innerPositions[i] = position.x;
        innerPositions[i + 1] = position.y;
        innerPositions[i + 2] = position.z;
        innerNormals[i] = normal.x;
        innerNormals[i + 1] = normal.y;
        innerNormals[i + 2] = normal.z;
      }
    }
    innerGeometry.attributes.position.needsUpdate = true;
    innerGeometry.attributes.normal.needsUpdate = true;
    innerGeometry.computeBoundingSphere();
    innerGeometry.computeBoundingBox();

    // Spine: from straight behind the camera half round to straight behind
    // the cover half.
    const put = (index: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): void => {
      spinePositions[index * 3] = x;
      spinePositions[index * 3 + 1] = y;
      spinePositions[index * 3 + 2] = z;
      spineNormals[index * 3] = nx;
      spineNormals[index * 3 + 1] = ny;
      spineNormals[index * 3 + 2] = nz;
    };
    put(capTop, 0, spineHalfLength, HINGE_AXIS_Z, 0, 1, 0);
    put(capBottom, 0, -spineHalfLength, HINGE_AXIS_Z, 0, -1, 0);
    const profile = spineProfile(beta, spineSegments, spineRadius, spineProud);
    for (let i = 0; i <= spineSegments; i++) {
      const { x, z, nx, nz } = profile[i];
      put(i * 2, x, spineHalfLength, z, nx, 0, nz);
      put(i * 2 + 1, x, -spineHalfLength, z, nx, 0, nz);
      put(capTop + 1 + i, x, spineHalfLength, z, 0, 1, 0);
      put(capBottom + 1 + i, x, -spineHalfLength, z, 0, -1, 0);
    }
    spineGeometry.attributes.position.needsUpdate = true;
    spineGeometry.attributes.normal.needsUpdate = true;
    spineGeometry.computeBoundingSphere();
    spine.visible = beta > 0.01;
  };
  setFold(0);

  return {
    root,
    screens: {
      inner: { mesh: innerFace, material: innerMaterial },
      cover: { mesh: coverFace, material: coverMaterial },
    },
    buttons,
    halves: {
      camera: [cameraSlab, cameraBack, plateauMesh, cameraControl, ...lensParts],
      cover: [coverSlab],
    },
    setFold,
    setFinish,
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * The hinge's back in cross-section, for a fold: points from straight behind
 * the camera half round to straight behind the cover half, each with its
 * outward normal. Flush with both backs at its ends; in between, flattened
 * towards the axis so that shut it stands `proud` beyond the halves' edges
 * instead of a whole radius.
 */
export function spineProfile(
  beta: number,
  segments: number,
  radius: number,
  proud: number,
): Array<{ x: number; z: number; nx: number; nz: number }> {
  const flatten = (1 - proud / radius) * Math.sin(beta / 2) ** 2;
  const points: Array<{ x: number; z: number }> = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const phi = beta * t;
    const r = radius * (1 - flatten * Math.sin(Math.PI * t));
    points.push({ x: -r * Math.sin(phi), z: HINGE_AXIS_Z - r * Math.cos(phi) });
  }
  return points.map((p, i) => {
    // Outward normal: perpendicular to the run of the curve here.
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(segments, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const length = Math.hypot(tx, tz) || 1;
    // The curve runs from −z round towards −x; its outside is to the right of travel.
    return { x: p.x, z: p.z, nx: -tz / length, nz: tx / length };
  });
}

/** Z of the inner face, re-exported for callers that place things on it. */
export const DUO_INNER_FACE_Z = INNER_FACE_Z;
