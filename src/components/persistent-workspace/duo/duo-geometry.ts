// The iPhone Duo as numbers: its dimensions, how its two halves move about the
// hinge, where each panel's picture sits on the body, and which way up iOS
// should draw for a given way of holding it. No rendering here — the 3D scene
// (duo-model.ts, duo-scene.ts) and the tests both build on this.
//
// THE DEVICE FRAME. Millimetres. The device lies open and flat, inner screen
// towards +Z (the viewer), hinge along the Y axis, top edge at +Y:
//
//   - the CAMERA HALF is x ≥ 0. It never moves in this frame. Its back (−Z)
//     carries the rear cameras, near the top.
//   - the COVER HALF is x ≤ 0. It turns about the hinge by the fold `beta`.
//     Its back carries the cover screen.
//
// FOLD. `hinge` is what iOS and the wire protocol use: the angle between the
// halves, 180° open flat … 0° shut. `beta = 180° − hinge` is how far the cover
// half has turned from flat, which is the handier number for geometry.
//
// Dimensions are measured, not guessed: panel sizes and corner radii from the
// simulator's own framebuffers and masks, body proportions from the device as
// Xcode's Device Hub presents it.

export type DuoDisplay = "cover" | "inner";

export type DeviceOrientation =
  | "portrait"
  | "portrait-upside-down"
  | "landscape-left"
  | "landscape-right";

export const DUO = {
  /** One half: hinge edge to outer edge. */
  halfWidth: 82.4,
  height: 117.8,
  /** One half, back to inner face. */
  thickness: 5.6,
  /** Space left between the two inner faces when shut. */
  closedGap: 0.5,
  /** Outer corners of the body (continuous-curve look). */
  cornerRadius: 11.6,
  /** Hinge-side corners of each half. */
  hingeCornerRadius: 1.6,
  /** Rounded edge where the frame meets the faces. */
  edgeBevel: 0.9,

  /** Inner panel, centred on the open device. Wider than tall when held like a book. */
  inner: { width: 158.0, height: 110.8, cornerRadius: 9.7 },
  /**
   * Cover panel, on the back of the cover half. `hingeInset` is from the hinge
   * edge of that half to the panel's near edge; it is centred vertically.
   */
  cover: { width: 77.4, height: 112.2, hingeInset: 2.5, cornerRadiusOuter: 10.9, cornerRadiusHinge: 1.2 },

  /** Half the width of the strip of inner panel that bends at the fold. */
  bendHalfWidth: 4.0,

  /** Framebuffer sizes in pixels (what the host streams). */
  innerPixels: { width: 2007, height: 2853 },
  coverPixels: { width: 1398, height: 2034 },
} as const;

const RAD = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Hinge angle (degrees, 180 open) → fold `beta` in radians (0 open). */
export function hingeToBeta(hingeDegrees: number): number {
  return (180 - clamp(hingeDegrees, 0, 180)) * RAD;
}

// ── Hinge kinematics ────────────────────────────────────────────────────────

/** Z of the inner faces (device frame, flat). */
export const INNER_FACE_Z = DUO.thickness / 2;
/** The hinge axis: x = 0, parallel to Y, this far towards the viewer. Half the
 * closed gap above the inner faces, so shut halves end up `closedGap` apart. */
export const HINGE_AXIS_Z = INNER_FACE_Z + DUO.closedGap / 2;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A point that rides with the cover half, given where it is when open flat. */
export function coverHalfPoint(flat: Vec3, beta: number): Vec3 {
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  const dx = flat.x;
  const dz = flat.z - HINGE_AXIS_Z;
  // Right-handed rotation about +Y through the hinge axis: the outer edge
  // (x < 0) swings towards the viewer.
  return { x: dx * c + dz * s, y: flat.y, z: HINGE_AXIS_Z - dx * s + dz * c };
}

/** The same rotation for a direction (a normal, an edge). */
export function coverHalfDirection(flat: Vec3, beta: number): Vec3 {
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  return { x: flat.x * c + flat.z * s, y: flat.y, z: -flat.x * s + flat.z * c };
}

/**
 * A point on the inner face (the bezel and the panel under it), which is one
 * flexible sheet across both halves. `x` is the position across the open
 * device (−halfWidth … +halfWidth), measured along the sheet. Away from the
 * fold the sheet lies flat on its half; within `bendHalfWidth` of it the sheet
 * follows an arc that leaves both halves tangentially — a soft crease that
 * tightens as the device closes, as the real one does.
 */
export function innerFacePoint(
  x: number,
  y: number,
  beta: number,
  lift = 0,
): { position: Vec3; normal: Vec3 } {
  const zs = INNER_FACE_Z + lift;
  const t0 = DUO.bendHalfWidth;
  if (x >= t0 || beta < 1e-4) {
    return { position: { x, y, z: zs }, normal: { x: 0, y: 0, z: 1 } };
  }
  if (x <= -t0) {
    return {
      position: coverHalfPoint({ x, y, z: zs }, beta),
      normal: coverHalfDirection({ x: 0, y: 0, z: 1 }, beta),
    };
  }
  // The arc. Its centre sits above the camera half's edge of the bend strip,
  // at the radius that makes it meet the cover half's edge tangentially too.
  const d = HINGE_AXIS_Z - zs;
  const radius = d + t0 / Math.tan(beta / 2);
  const phi = (beta * (t0 - x)) / (2 * t0);
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  return {
    position: { x: t0 - radius * sin, y, z: zs + radius * (1 - cos) },
    normal: { x: sin, y: 0, z: cos },
  };
}

/**
 * Where the device's weight is, so it can be kept centred while it folds: the
 * midpoint of the two halves' centres.
 */
export function deviceCentroid(beta: number): Vec3 {
  const camera = { x: DUO.halfWidth / 2, y: 0, z: 0 };
  const cover = coverHalfPoint({ x: -DUO.halfWidth / 2, y: 0, z: 0 }, beta);
  return { x: (camera.x + cover.x) / 2, y: 0, z: (camera.z + cover.z) / 2 };
}

/**
 * How far to turn the whole device about its hinge so the side in use faces
 * the viewer. Open: none, the inner screen is square on. Part folded: half the
 * fold, so the two halves open towards the viewer evenly, like a book held up.
 * Nearly shut: back to none, which leaves the cover screen square on.
 * Radians about +Y.
 */
export function autoYaw(beta: number): number {
  const bookish = 1 - smoothstep(95 * RAD, 165 * RAD, beta);
  return (-beta / 2) * bookish;
}

// ── Where the pictures sit ──────────────────────────────────────────────────
// A framebuffer coordinate is (u, v) in 0…1 with the origin at the top left of
// the image the host streams. Touches are sent in the same terms.

/**
 * Inner panel. The framebuffer is taller than wide and the panel, held like a
 * book, is wider than tall: the image's left edge is the device's top, its top
 * edge the camera half's outer edge. (iOS then draws its interface turned a
 * quarter turn inside the image, so it reads upright on the device.)
 * `x`, `y`: position on the open, flat inner face, origin at its centre.
 */
export function innerFaceToFramebuffer(x: number, y: number): { u: number; v: number } {
  const { width, height } = DUO.inner;
  return { u: (height / 2 - y) / height, v: (width / 2 - x) / width };
}

export function framebufferToInnerFace(u: number, v: number): { x: number; y: number } {
  const { width, height } = DUO.inner;
  return { x: width / 2 - v * width, y: height / 2 - u * height };
}

/**
 * Cover panel, in the cover half's own flat coordinates (x ≤ 0, hinge at 0).
 * Seen from behind — the way the cover is looked at — the hinge is on the
 * left, so the image's left edge is the hinge side.
 */
export function coverFaceToFramebuffer(x: number, y: number): { u: number; v: number } {
  const { width, height, hingeInset } = DUO.cover;
  return { u: (-x - hingeInset) / width, v: (height / 2 - y) / height };
}

export function framebufferToCoverFace(u: number, v: number): { x: number; y: number } {
  const { width, height, hingeInset } = DUO.cover;
  return { x: -(hingeInset + u * width), y: height / 2 - v * height };
}

/** Is a framebuffer coordinate on the panel (with a little slack at the edge)? */
export function insideFramebuffer(u: number, v: number, slack = 0): boolean {
  return u >= -slack && u <= 1 + slack && v >= -slack && v <= 1 + slack;
}

// ── Which way up ────────────────────────────────────────────────────────────

/**
 * How iOS should be told the device is held, from which way is up. A phone
 * works this out from gravity; here "up" is the top of the user's screen.
 *
 * `cameraHalf` and `coverHalf` are the world's up direction as each half sees
 * it, in the flat device's axes: x across the device (towards the camera
 * half's outer edge), y towards the device's top. The length of each says how
 * upright that half is (0 = lying flat, facing the ceiling or the floor).
 *
 * With the cover screen in use only its half counts. Otherwise both do, which
 * is what makes a half-folded device standing on one half read correctly: the
 * half that lies flat says nothing, the one standing up decides.
 *
 * `previous` is kept unless another way up is clearly better, so a device held
 * near a diagonal does not flip back and forth.
 */
export function orientationFromUp(
  cameraHalf: { x: number; y: number },
  coverHalf: { x: number; y: number },
  coverInUse: boolean,
  previous: DeviceOrientation,
): DeviceOrientation {
  const x = coverInUse ? coverHalf.x : cameraHalf.x + coverHalf.x;
  const y = coverInUse ? coverHalf.y : cameraHalf.y + coverHalf.y;
  const scale = coverInUse ? 1 : 2;
  // Lying nearly flat: nothing to go on.
  if (Math.hypot(x, y) < 0.3 * scale) return previous;
  const score: Record<DeviceOrientation, number> = {
    portrait: y,
    "portrait-upside-down": -y,
    "landscape-left": x,
    "landscape-right": -x,
  };
  let best: DeviceOrientation = previous;
  for (const candidate of Object.keys(score) as DeviceOrientation[]) {
    if (score[candidate] > score[best]) best = candidate;
  }
  if (best === previous) return previous;
  // Switch only when the new way up beats the current one by a clear margin.
  return score[best] - score[previous] > 0.28 * scale ? best : previous;
}

/**
 * Quarter turns (clockwise) that make a panel's streamed image read upright,
 * for screenshots. The cover keeps its upright layout however the device is
 * held; the inner panel's interface is drawn turned inside its image.
 */
export function uprightQuarterTurns(display: DuoDisplay, orientation: DeviceOrientation): 0 | 1 | 2 | 3 {
  if (display === "cover") return 0;
  switch (orientation) {
    case "portrait":
      return 1;
    case "landscape-left":
      return 0;
    case "landscape-right":
      return 2;
    case "portrait-upside-down":
      return 3;
  }
}

// ── Postures ────────────────────────────────────────────────────────────────

export type DuoPoseId = "closed" | "open" | "book" | "tabletop";

export interface DuoPose {
  id: DuoPoseId;
  label: string;
  /** What it is for, shown as a tooltip. */
  hint: string;
  /** Hinge angle in degrees (180 open … 0 shut). */
  hinge: number;
  /**
   * The device's attitude once the fold's own turn (autoYaw) is applied, as
   * intrinsic rotations in degrees about the screen's X then Y then Z axes.
   * Null: square on to the viewer.
   */
  attitude: { x: number; y: number; z: number } | null;
  /** Stand the device on its cover half, hinge level (see duo-scene). */
  tabletop?: boolean;
}

export const DUO_POSES: readonly DuoPose[] = [
  { id: "closed", label: "Closed", hint: "Folded shut, on the cover screen", hinge: 0, attitude: null },
  { id: "open", label: "Open", hint: "Open flat, on the inner screen", hinge: 180, attitude: null },
  { id: "book", label: "Book", hint: "Half open, held like a book", hinge: 125, attitude: { x: -8, y: 0, z: 0 } },
  {
    id: "tabletop",
    label: "Tabletop",
    hint: "Half open, standing on one half",
    hinge: 105,
    attitude: null,
    tabletop: true,
  },
];

export function poseById(id: DuoPoseId): DuoPose {
  return DUO_POSES.find((p) => p.id === id) ?? DUO_POSES[1];
}

/** The posture a hinge angle is closest to in name, for the readout. */
export function hingePostureLabel(hingeDegrees: number): string {
  if (hingeDegrees <= 3) return "Closed";
  if (hingeDegrees >= 177) return "Open flat";
  return "Part open";
}
