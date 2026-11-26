// The iPhone Duo on screen: renders the model, plays the two panels' video on
// it, and turns what the pointer does into either a move of the model (turn it,
// fold it, zoom) or input for the simulator (touch a screen, press a button).
//
// Plain three.js, driven imperatively: the scene redraws only when something
// changed (a new video frame, an animation in flight, a drag), so a still
// simulator costs nothing.
//
// How the device is placed (see duo-geometry.ts for the device frame):
//
//   scene ─ pivot ─ model.root
//
// `model.root` is shifted so the device's centre of weight is at the pivot.
// `pivot` carries the orientation: the user's own turn (`userQuat`) applied
// over the turn the fold itself asks for (autoYaw), so the side in use keeps
// facing the viewer while the device opens and closes.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  DUO,
  DUO_POSES,
  autoYaw,
  clamp,
  coverFaceToFramebuffer,
  coverHalfDirection,
  coverHalfPoint,
  deviceCentroid,
  hingeToBeta,
  innerFaceToFramebuffer,
  insideFramebuffer,
  orientationFromUp,
  uprightQuarterTurns,
  type DeviceOrientation,
  type DuoDisplay,
  type DuoPoseId,
  type Vec3,
} from "./duo-geometry";
import { buildDuoModel, type DuoButton, type DuoFinishId, type DuoModel } from "./duo-model";

/** Input for the simulator, in the wire protocol's terms. */
export type DuoSceneInput =
  | { kind: "touch"; display: DuoDisplay; phase: "down" | "move" | "up"; normX: number; normY: number; finger: 0 | 1 }
  | { kind: "scroll"; display: DuoDisplay; normX: number; normY: number; deltaX: number; deltaY: number }
  | { kind: "button"; button: DuoButton };

export interface DuoSceneCallbacks {
  onInput: (input: DuoSceneInput) => void;
  /** The user set the hinge (degrees, 180 open). `settled`: not mid-drag. */
  onHingeRequest: (hinge: number, settled: boolean) => void;
  /** The angle the model is shown at changed (for readouts). */
  onHingeShown?: (hinge: number) => void;
  /** The way the device is held changed enough that iOS should turn. */
  onOrientation?: (orientation: DeviceOrientation) => void;
  /** The pointer went down on the device or the canvas (take keyboard focus). */
  onEngage?: () => void;
}

export interface DuoPanelLit {
  cover: boolean;
  inner: boolean;
}

/**
 * How the device was left: fold, attitude and zoom. Carried from one view of
 * the device to the next (the stopped preview to the running one), so it does
 * not spring back to open and square on.
 */
export interface DuoPosture {
  hinge: number;
  /** The person's turn of the device: x, y, z, w. */
  turn: [number, number, number, number];
  /** A whole-device attitude being held (tabletop), if any: x, y, z, w. */
  attitude: [number, number, number, number] | null;
  zoom: number;
  /** The person set any of this themselves (as opposed to it being the default). */
  posed: boolean;
  /** How iOS was last told the device is held. */
  held: DeviceOrientation;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Vertical field of view. Narrow, so the device reads as a product shot
 * rather than a wide-angle close-up. */
const FOV = 24;
/** The device fills this fraction of the room it is given. */
const FILL = 0.84;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.2;
/** A half can be folded by its outer edge: this close to it counts. */
const HINGE_GRAB_MM = 15;
/** After the user moves the hinge, the host's reports are ignored this long
 * (they trail behind while it eases there). */
const HINGE_USER_HOLD_MS = 1400;
/** How long after this view turned the device a report that disagrees is taken to be an older one. */
const ORIENTATION_OWN_HOLD_MS = 2500;
/** Quarter turns, anticlockwise as seen, that put the device in each orientation. */
const QUARTER_TURNS: Record<DeviceOrientation, number> = {
  portrait: 0,
  "landscape-left": 1,
  "portrait-upside-down": 2,
  "landscape-right": -1,
};

type Pick =
  | { kind: "button"; index: number }
  | { kind: "screen"; display: DuoDisplay; u: number; v: number }
  | { kind: "body"; half: "camera" | "cover"; flat: Vec3; edge: boolean }
  | null;

type Drag =
  | { kind: "orbit"; lastX: number; lastY: number }
  | { kind: "hinge"; lastX: number; lastY: number; half: "camera" | "cover"; flat: Vec3 }
  | { kind: "touch"; display: DuoDisplay; finger: 0 | 1; u: number; v: number; pinch: boolean }
  | { kind: "button"; index: number };

/** Smooth a value towards a target; `tau` is the time to cover ~63% of the gap. */
function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class DuoScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 10, 4000);
  private readonly pivot = new THREE.Group();
  private readonly model: DuoModel;
  private readonly shadow: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly textures: Record<DuoDisplay, THREE.VideoFrameTexture>;
  private readonly frames: Record<DuoDisplay, VideoFrame | null> = { cover: null, inner: null };

  private width = 1;
  private height = 1;
  private insets = { top: 0, bottom: 0 };
  private disposed = false;
  private raf = 0;
  private lastTick = 0;
  /** Frames still to draw after the last change (lets animations finish). */
  private settleFrames = 0;

  // Fold.
  private hingeShown = 180;
  private hingeTarget = 180;
  private hingeUserAt = 0;
  private foldApplied = -1;

  // Orientation and framing.
  private readonly userQuat = new THREE.Quaternion();
  private readonly userQuatTarget = new THREE.Quaternion();
  /** When set, the pose being travelled to is the device's whole attitude
   * (tabletop), so the user's part is recomputed as the fold's own turn changes. */
  private attitudeTarget: THREE.Quaternion | null = null;
  private spin = { x: 0, y: 0 };
  private zoom = 1;
  private zoomTarget = 1;
  private distance = 600;
  private distanceTarget = 600;
  private framed = false;
  /** The person has folded or turned the device themselves. */
  private posed = false;
  private touchKeepAlive: ReturnType<typeof setInterval> | null = null;

  // Panels.
  private lit: DuoPanelLit = { cover: false, inner: true };
  private live = false;
  private dim = 0;
  private dimTarget = 0;

  // Held orientation.
  private orientation: DeviceOrientation = "portrait";
  private orientationCandidate: DeviceOrientation = "portrait";
  private orientationSince = 0;
  /** When this view last told the session how the device is held. */
  private orientationOwnAt = Number.NEGATIVE_INFINITY;
  /** Sensing is off until then (the model is being turned to follow the session). */
  private orientationQuietUntil = 0;
  private orientationReported: DeviceOrientation | null = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;

  // Pointer.
  private readonly drags = new Map<number, Drag>();
  private hoverButton = -1;
  private pressed = new Set<number>();
  private buttonTravel: number[];
  private pendingMoves = new Map<number, { display: DuoDisplay; finger: 0 | 1; u: number; v: number; pinch: boolean }>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: DuoSceneCallbacks,
    finish: DuoFinishId = "natural",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.buildEnvironment();

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-260, 420, 520);
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.7);
    rim.position.set(380, 120, -300);
    this.scene.add(key, rim);

    this.model = buildDuoModel(finish);
    this.buttonTravel = this.model.buttons.map(() => 0);
    this.pivot.add(this.model.root);
    this.scene.add(this.pivot);

    // A soft shadow on the "wall" behind the device, so it sits in space
    // instead of being pasted on the page.
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: shadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.3,
        toneMapped: false,
      }),
    );
    this.shadow.renderOrder = -1;
    this.scene.add(this.shadow);

    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const texture = (): THREE.VideoFrameTexture => {
      const t = new THREE.VideoFrameTexture();
      // The picture is shown as it is: no colour conversion on the way in or out.
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = anisotropy;
      return t;
    };
    this.textures = { cover: texture(), inner: texture() };

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.applyFold();
    this.invalidate();
  }

  /** A neutral studio to reflect in the metal and glass. */
  private buildEnvironment(): void {
    this.scene.environment?.dispose();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.03).texture;
    this.scene.environmentIntensity = 1.0;
    room.dispose();
    pmrem.dispose();
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  /** Canvas size in CSS pixels. `insets` keep the device clear of overlaid controls. */
  setSize(width: number, height: number, insets: { top: number; bottom: number } = { top: 0, bottom: 0 }): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.insets = insets;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    // Lens shift: centres the device in the room left by the insets without
    // changing the perspective.
    const shift = (insets.bottom - insets.top) / 2;
    this.camera.setViewOffset(this.width, this.height, 0, shift, this.width, this.height);
    this.camera.updateProjectionMatrix();
    if (!this.framed) {
      this.distance = this.distanceTarget = this.fitDistance();
      this.framed = true;
    }
    this.invalidate();
  }

  /** A decoded frame for a panel. The scene takes it over and closes it. */
  setFrame(display: DuoDisplay, frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    const previous = this.frames[display];
    this.frames[display] = frame;
    this.textures[display].setFrame(frame);
    const uniforms = this.model.screens[display].material.uniforms;
    if (!uniforms.uMap.value) {
      uniforms.uMap.value = this.textures[display];
      uniforms.uHasMap.value = 1;
    }
    previous?.close();
    this.invalidate();
  }

  /** Drop the pictures (the session ended or restarted). */
  clearFrames(): void {
    for (const display of ["cover", "inner"] as const) {
      this.frames[display]?.close();
      this.frames[display] = null;
      const uniforms = this.model.screens[display].material.uniforms;
      uniforms.uMap.value = null;
      uniforms.uHasMap.value = 0;
    }
    this.invalidate();
  }

  /** Which panels iOS has on. */
  setLit(lit: DuoPanelLit): void {
    this.lit = lit;
    this.invalidate();
  }

  /** Whether the simulator is streaming: only then do the screens take touches. */
  setLive(live: boolean): void {
    this.live = live;
    if (!live) {
      // No session, no reports to follow: the device stays as the person has it.
      if (this.followTimer) clearTimeout(this.followTimer);
      this.followTimer = null;
      this.orientationReported = null;
    }
    this.invalidate();
  }

  /** Darken the pictures (behind a status message). 0 … 1. */
  setDim(dim: number): void {
    this.dimTarget = clamp(dim, 0, 1);
    this.invalidate();
  }

  setFinish(finish: DuoFinishId): void {
    this.model.setFinish(finish);
    this.invalidate();
  }

  /** Shadow strength suits the page behind: lighter on a light page. */
  setDarkBackdrop(dark: boolean): void {
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = dark ? 0.55 : 0.26;
    this.invalidate();
  }

  /**
   * The host's report of where the hinge is. Followed unless the user has just
   * moved it (`adopt` follows it regardless: joining a session already under way).
   */
  setReportedHinge(hinge: number, adopt = false): void {
    const held = !adopt && performance.now() - this.hingeUserAt <= HINGE_USER_HOLD_MS;
    if (!held && Math.abs(hinge - this.hingeTarget) > 0.5) {
      this.hingeTarget = hinge;
      this.invalidate();
    }
  }

  /**
   * Take up the way the session's device is already held (joining a session
   * under way): turn the model to match, so this view does not then tell iOS
   * the device has been turned back.
   */
  adoptOrientation(orientation: DeviceOrientation): void {
    if (orientation === this.orientation) return;
    this.attitudeTarget = null;
    this.userQuatTarget.setFromAxisAngle(AXIS_Z, (QUARTER_TURNS[orientation] * Math.PI) / 2);
    this.orientation = orientation;
    this.orientationCandidate = orientation;
    this.invalidate();
  }

  /**
   * The session's report of how its device is held, after this view has joined
   * it. Usually it is this view's own turn coming back. When it is not —
   * another view of the same session turned the device (the full-screen view
   * over this one, another tab) — this model is turned to match, keeping its
   * tilt: otherwise it would show a picture drawn for a device held another way.
   */
  followOrientation(reported: DeviceOrientation): void {
    this.orientationReported = reported;
    if (this.disposed || reported === this.orientation) return;
    const now = performance.now();
    // While the person here is turning the device, or just has, theirs is the
    // newer fact and a report that disagrees an older one. Look again later.
    const turning =
      Math.abs(this.spin.x) + Math.abs(this.spin.y) > 1e-4 ||
      [...this.drags.values()].some((d) => d.kind === "orbit" || d.kind === "hinge");
    const wait = turning ? 400 : this.orientationOwnAt + ORIENTATION_OWN_HOLD_MS - now;
    if (wait > 0) {
      this.followTimer ??= setTimeout(() => {
        this.followTimer = null;
        if (this.orientationReported) this.followOrientation(this.orientationReported);
      }, wait + 20);
      return;
    }
    // How this model, as it is, would be said to be held (leaning towards the
    // report): only if that is something else does it need turning.
    const beta = hingeToBeta(this.hingeTarget);
    const attitude =
      this.attitudeTarget?.clone() ??
      this.userQuatTarget.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta)));
    const own = this.heldOrientation(beta, attitude, reported);
    if (own !== reported) {
      // Which way round the turn goes depends on which way the device faces
      // (seen from the back, a turn to the left is one to its right): take
      // the turn that does bring it to what was reported, the likeliest first.
      const quarters = QUARTER_TURNS[reported] - QUARTER_TURNS[own];
      const turn = [quarters, -quarters, 2, 1, -1]
        .map((k) => new THREE.Quaternion().setFromAxisAngle(AXIS_Z, (k * Math.PI) / 2))
        .find((q) => this.heldOrientation(beta, q.clone().multiply(attitude), reported) === reported);
      // (None does, from some odd attitude: leave the model be, and say nothing.)
      if (!turn) return;
      this.settleAttitude();
      this.userQuatTarget.premultiply(turn);
      this.spin = { x: 0, y: 0 };
    }
    this.orientation = this.orientationCandidate = reported;
    this.orientationQuietUntil = now + 900;
    this.invalidate();
  }

  /** How the device is held, to tell a session that has just been joined. */
  announceOrientation(): DeviceOrientation {
    this.orientationOwnAt = performance.now();
    return this.orientation;
  }

  /** Whether the person has folded or turned the device themselves. */
  hasUserPosture(): boolean {
    return this.posed;
  }

  getPosture(): DuoPosture {
    const q = this.userQuatTarget;
    const a = this.attitudeTarget;
    return {
      hinge: this.hingeTarget,
      turn: [q.x, q.y, q.z, q.w],
      attitude: a ? [a.x, a.y, a.z, a.w] : null,
      zoom: this.zoomTarget,
      posed: this.posed,
      held: this.orientation,
    };
  }

  /** Put the device as it was left (no animation, nothing sent). */
  restorePosture(posture: DuoPosture): void {
    this.hingeTarget = this.hingeShown = clamp(posture.hinge, 0, 180);
    this.userQuatTarget.set(...posture.turn).normalize();
    this.attitudeTarget = posture.attitude ? new THREE.Quaternion(...posture.attitude).normalize() : null;
    if (this.attitudeTarget) {
      const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(hingeToBeta(this.hingeTarget)));
      this.userQuatTarget.copy(this.attitudeTarget).multiply(auto.invert());
    }
    this.userQuat.copy(this.userQuatTarget);
    this.zoom = this.zoomTarget = clamp(posture.zoom, ZOOM_MIN, ZOOM_MAX);
    this.posed = posture.posed;
    this.spin = { x: 0, y: 0 };
    // The device is already held this way: know it now, rather than starting
    // from "upright" and telling iOS it was turned back for a moment.
    const beta = hingeToBeta(this.hingeTarget);
    const attitude = this.userQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta)));
    this.orientation = this.orientationCandidate = this.heldOrientation(beta, attitude, posture.held);
    this.applyFold();
    if (this.framed) this.distance = this.distanceTarget = this.fitDistance();
    this.invalidate();
  }

  /**
   * A picture of the device as it stands, on a transparent background, at
   * `scale` times the size on screen: for decks, posts and store pages.
   */
  snapshot(scale = 3): Promise<Blob | null> {
    if (this.disposed) return Promise.resolve(null);
    const previous = this.renderer.getPixelRatio();
    // Stay inside what a GPU will allocate for one canvas.
    const limit = Math.min(4, 8192 / Math.max(this.width, this.height));
    this.renderer.setPixelRatio(Math.max(1, Math.min(scale, limit)));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.render(this.scene, this.camera);
    // The canvas is read at the moment of the call; encoding happens after.
    const blob = new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/png"));
    this.renderer.setPixelRatio(previous);
    this.renderer.setSize(this.width, this.height, false);
    this.invalidate();
    return blob;
  }

  /** Fold to an angle (from the slider). */
  setHinge(hinge: number, settled: boolean): void {
    this.hingeTarget = clamp(hinge, 0, 180);
    this.posed = true;
    this.hingeUserAt = performance.now();
    this.callbacks.onHingeRequest(this.hingeTarget, settled);
    this.invalidate();
  }

  getHinge(): number {
    return this.hingeTarget;
  }

  getOrientation(): DeviceOrientation {
    return this.orientation;
  }

  /** Move to a named posture: fold and attitude together. */
  applyPose(id: DuoPoseId): void {
    const pose = DUO_POSES.find((p) => p.id === id);
    if (!pose) return;
    this.spin = { x: 0, y: 0 };
    this.zoomTarget = 1;
    if (pose.tabletop) {
      // Stand the device on its cover half: that half flat with its inner face
      // up, reaching towards the viewer, the camera half upright behind it, and
      // the whole thing tipped forward enough to see the lower screen. (This
      // way up — the camera half's outer edge at the top — is one every app
      // can turn to; the other way round needs upside-down support.)
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, -1), // across the cover half, towards the hinge → away from the viewer
        new THREE.Vector3(-1, 0, 0), // along the hinge → across the screen
        new THREE.Vector3(0, 1, 0), // the cover half's inner face → up
      );
      const lying = new THREE.Quaternion().setFromRotationMatrix(basis);
      // The device frame is the camera half's; bring the cover half's into it.
      const unfold = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, hingeToBeta(pose.hinge)).invert();
      const tip = new THREE.Quaternion().setFromAxisAngle(AXIS_X, THREE.MathUtils.degToRad(38));
      this.attitudeTarget = tip.multiply(lying).multiply(unfold);
    } else {
      this.attitudeTarget = null;
      const a = pose.attitude;
      this.userQuatTarget.setFromEuler(
        a
          ? new THREE.Euler(THREE.MathUtils.degToRad(a.x), THREE.MathUtils.degToRad(a.y), THREE.MathUtils.degToRad(a.z), "XYZ")
          : new THREE.Euler(0, 0, 0),
      );
    }
    this.setHinge(pose.hinge, true);
  }

  /** Turn the device a quarter turn in the plane of the screen. */
  rollQuarter(direction: "left" | "right"): void {
    this.posed = true;
    this.settleAttitude();
    const turn = new THREE.Quaternion().setFromAxisAngle(AXIS_Z, ((direction === "left" ? 1 : -1) * Math.PI) / 2);
    this.userQuatTarget.premultiply(turn);
    this.spin = { x: 0, y: 0 };
    this.invalidate();
  }

  /** Square the device up to the viewer again and undo any zoom. */
  resetView(): void {
    this.attitudeTarget = null;
    this.userQuatTarget.identity();
    this.spin = { x: 0, y: 0 };
    this.zoomTarget = 1;
    this.invalidate();
  }

  /**
   * The picture on a panel as an upright image, for screenshots. `display`
   * omitted: the panel that is on. Null when there is no frame yet.
   */
  async capture(display?: DuoDisplay, quality = 0.9): Promise<Blob | null> {
    const which: DuoDisplay = display ?? (this.lit.inner || !this.lit.cover ? "inner" : "cover");
    const frame = this.frames[which];
    if (!frame) return null;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const turns = uprightQuarterTurns(which, this.orientation);
    const out = document.createElement("canvas");
    out.width = turns % 2 === 1 ? h : w;
    out.height = turns % 2 === 1 ? w : h;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    try {
      ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    } catch {
      return null; // the frame was closed under us; the next call will have a new one
    }
    return new Promise((resolve) => out.toBlob((blob) => resolve(blob), "image/jpeg", quality));
  }

  /** Whether a panel has shown a picture yet. */
  hasFrame(display?: DuoDisplay): boolean {
    return display ? this.frames[display] !== null : this.frames.cover !== null || this.frames.inner !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.touchKeepAlive) clearInterval(this.touchKeepAlive);
    if (this.followTimer) clearTimeout(this.followTimer);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("dblclick", this.onDoubleClick);
    c.removeEventListener("contextmenu", this.onContextMenu);
    c.removeEventListener("webglcontextlost", this.onContextLost);
    c.removeEventListener("webglcontextrestored", this.onContextRestored);
    // Lift any finger still down on the simulator.
    for (const drag of this.drags.values()) {
      if (drag.kind === "touch") this.endTouch(drag);
    }
    this.drags.clear();
    for (const display of ["cover", "inner"] as const) {
      this.frames[display]?.close();
      this.frames[display] = null;
      this.textures[display].dispose();
    }
    this.model.dispose();
    this.shadow.geometry.dispose();
    const shadowMaterial = this.shadow.material as THREE.MeshBasicMaterial;
    shadowMaterial.map?.dispose();
    shadowMaterial.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────

  private invalidate(): void {
    if (this.disposed) return;
    this.settleFrames = 2;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (time: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.lastTick ? Math.min(0.05, (time - this.lastTick) / 1000) : 1 / 60;
    this.lastTick = time;

    const moving = this.advance(dt, time);
    this.flushTouchMoves();
    this.renderer.render(this.scene, this.camera);

    if (moving) this.settleFrames = 2;
    else this.settleFrames -= 1;
    if (this.settleFrames > 0) this.raf = requestAnimationFrame(this.tick);
    else this.lastTick = 0;
  };

  /** Step every animation. Returns whether anything is still in motion. */
  private advance(dt: number, now: number): boolean {
    let moving = false;
    const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) < eps;

    // Fold.
    if (!near(this.hingeShown, this.hingeTarget, 0.02)) {
      this.hingeShown = approach(this.hingeShown, this.hingeTarget, dt, 0.085);
      if (near(this.hingeShown, this.hingeTarget, 0.02)) this.hingeShown = this.hingeTarget;
      moving = true;
    }
    const beta = hingeToBeta(this.hingeShown);

    // Attitude: either free spin after a flick, or travel to a target.
    const dragging = [...this.drags.values()].some((d) => d.kind === "orbit");
    if (!dragging) {
      if (Math.hypot(this.spin.x, this.spin.y) > 0.02) {
        this.turnBy(this.spin.x * dt, this.spin.y * dt);
        const decay = Math.exp(-dt / 0.22);
        this.spin.x *= decay;
        this.spin.y *= decay;
        moving = true;
      } else {
        this.spin.x = this.spin.y = 0;
        if (this.attitudeTarget) {
          // The fold's own turn is still changing: keep aiming so the device
          // ends in the attitude asked for.
          const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta));
          this.userQuatTarget.copy(this.attitudeTarget).multiply(auto.invert());
        }
        const gap = this.userQuat.angleTo(this.userQuatTarget);
        if (gap > 0.0008) {
          this.userQuat.slerp(this.userQuatTarget, 1 - Math.exp(-dt / 0.11));
          moving = true;
        } else if (gap > 0) {
          this.userQuat.copy(this.userQuatTarget);
        }
      }
    }

    if (this.foldApplied !== this.hingeShown) this.applyFold();
    const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta));
    this.pivot.quaternion.copy(this.userQuat).multiply(auto);

    // Framing.
    if (!near(this.zoom, this.zoomTarget, 0.001)) {
      this.zoom = approach(this.zoom, this.zoomTarget, dt, 0.09);
      moving = true;
    }
    this.distanceTarget = this.fitDistance();
    if (!near(this.distance, this.distanceTarget, 0.05)) {
      this.distance = approach(this.distance, this.distanceTarget, dt, 0.16);
      moving = true;
    }
    this.camera.position.set(0, 0, this.distance / this.zoom);
    this.camera.lookAt(0, 0, 0);
    this.placeShadow();

    for (const display of ["cover", "inner"] as const) {
      this.model.screens[display].material.uniforms.uDim.value = this.dim;
    }
    if (!near(this.dim, this.dimTarget, 0.004)) {
      this.dim = approach(this.dim, this.dimTarget, dt, 0.12);
      moving = true;
    } else {
      this.dim = this.dimTarget;
    }

    // Buttons travel inwards while held.
    this.model.buttons.forEach((b, i) => {
      const target = this.pressed.has(i) ? 1 : 0;
      if (!near(this.buttonTravel[i], target, 0.01)) {
        this.buttonTravel[i] = approach(this.buttonTravel[i], target, dt, 0.035);
        moving = true;
      } else {
        this.buttonTravel[i] = target;
      }
      b.mesh.position.copy(b.rest).addScaledVector(b.inward, 0.55 * this.buttonTravel[i]);
    });

    this.senseOrientation(beta, now, moving);
    return moving;
  }

  private applyFold(): void {
    const beta = hingeToBeta(this.hingeShown);
    this.model.setFold(beta);
    const c = deviceCentroid(beta);
    this.model.root.position.set(-c.x, -c.y, -c.z);
    this.foldApplied = this.hingeShown;
    this.callbacks.onHingeShown?.(this.hingeShown);
  }

  // ── Framing ────────────────────────────────────────────────────────────────

  /** Points that bound the device, in the pivot's frame, for a fold. */
  private boundingPoints(beta: number, quat: THREE.Quaternion): THREE.Vector3[] {
    const W = DUO.halfWidth;
    const H = DUO.height / 2;
    const T = DUO.thickness / 2;
    const c = deviceCentroid(beta);
    const points: THREE.Vector3[] = [];
    for (const y of [-H, H]) {
      for (const z of [-T, T]) {
        for (const x of [0, W]) points.push(new THREE.Vector3(x, y, z));
        for (const x of [0, -W]) {
          const p = coverHalfPoint({ x, y, z }, beta);
          points.push(new THREE.Vector3(p.x, p.y, p.z));
        }
      }
    }
    // The camera plateau stands proud of the back.
    points.push(new THREE.Vector3(77, 54, -T - 5), new THREE.Vector3(24, 34, -T - 5));
    for (const p of points) p.set(p.x - c.x, p.y - c.y, p.z - c.z).applyQuaternion(quat);
    return points;
  }

  /** Camera distance at which the device, as posed, just fits the room it has. */
  private fitDistance(): number {
    const beta = hingeToBeta(this.hingeShown);
    const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta));
    const quat = this.userQuat.clone().multiply(auto);
    const room = Math.max(40, this.height - this.insets.top - this.insets.bottom);
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * (room / this.height) * FILL;
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * this.camera.aspect * FILL;
    let distance = 100;
    for (const p of this.boundingPoints(beta, quat)) {
      distance = Math.max(distance, p.z + Math.abs(p.x) / tanH, p.z + Math.abs(p.y) / tanV);
    }
    return distance;
  }

  private placeShadow(): void {
    const beta = hingeToBeta(this.hingeShown);
    let maxX = 1;
    let maxY = 1;
    let minZ = 0;
    for (const p of this.boundingPoints(beta, this.pivot.quaternion)) {
      maxX = Math.max(maxX, Math.abs(p.x));
      maxY = Math.max(maxY, Math.abs(p.y));
      minZ = Math.min(minZ, p.z);
    }
    this.shadow.scale.set(maxX * 2 * 1.5, maxY * 2 * 1.42, 1);
    this.shadow.position.set(0, -maxY * 0.09, minZ - 22);
  }

  // ── Attitude ───────────────────────────────────────────────────────────────

  /** Turn about the screen's vertical and horizontal axes (radians). */
  private turnBy(aboutY: number, aboutX: number): void {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(AXIS_Y, aboutY)
      .multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, aboutX));
    this.userQuat.premultiply(q).normalize();
    this.userQuatTarget.copy(this.userQuat);
  }

  /** Stop aiming at a whole-device attitude; keep the device where it is headed. */
  private settleAttitude(): void {
    if (!this.attitudeTarget) return;
    const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(hingeToBeta(this.hingeTarget)));
    this.userQuatTarget.copy(this.attitudeTarget).multiply(auto.invert());
    this.attitudeTarget = null;
  }

  /**
   * After a turn by hand: if the device is nearly square on to the viewer (in
   * any of its quarter-turn attitudes, front or back), finish the job. Text
   * that is a few degrees off level is only harder to read.
   */
  private snapIfNearlySquare(): void {
    const beta = hingeToBeta(this.hingeTarget);
    const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta));
    const total = this.userQuat.clone().multiply(auto);
    let best: THREE.Quaternion | null = null;
    let bestAngle = THREE.MathUtils.degToRad(13);
    for (const flip of [0, Math.PI]) {
      for (let quarter = 0; quarter < 4; quarter++) {
        const candidate = new THREE.Quaternion()
          .setFromAxisAngle(AXIS_Z, (quarter * Math.PI) / 2)
          .multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, flip));
        const angle = total.angleTo(candidate);
        if (angle < bestAngle) {
          bestAngle = angle;
          best = candidate;
        }
      }
    }
    if (best) {
      this.userQuatTarget.copy(best).multiply(auto.invert());
      this.spin = { x: 0, y: 0 };
    }
  }

  /**
   * Work out how the device is being held and, once it has stayed that way a
   * moment, say so (iOS turns the interface to match).
   */
  /** How a device in this fold and attitude is being held (see orientationFromUp). */
  private heldOrientation(beta: number, attitude: THREE.Quaternion, previous: DeviceOrientation): DeviceOrientation {
    // World up, in the device's own axes.
    const up = WORLD_UP.clone().applyQuaternion(attitude.clone().invert());
    const coverX = coverHalfDirection({ x: 1, y: 0, z: 0 }, beta);
    return orientationFromUp(
      { x: up.x, y: up.y },
      { x: up.x * coverX.x + up.y * coverX.y + up.z * coverX.z, y: up.y },
      this.lit.cover && !this.lit.inner,
      previous,
    );
  }

  private senseOrientation(beta: number, now: number, moving: boolean): void {
    if (performance.now() < this.orientationQuietUntil) {
      // Being turned to follow the session: what it passes through on the way is not news.
      this.orientationCandidate = this.orientation;
      if (!moving) this.settleFrames = Math.max(this.settleFrames, 2);
      return;
    }
    const next = this.heldOrientation(beta, this.pivot.quaternion, this.orientation);
    if (next !== this.orientationCandidate) {
      this.orientationCandidate = next;
      this.orientationSince = now;
    }
    if (this.orientationCandidate !== this.orientation) {
      if (now - this.orientationSince > 260) {
        this.orientation = this.orientationCandidate;
        this.orientationOwnAt = performance.now();
        this.callbacks.onOrientation?.(this.orientation);
      } else if (!moving) {
        // Nothing else is animating: come back to check when the wait is over.
        this.settleFrames = Math.max(this.settleFrames, 2);
      }
    }
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  private ray(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  private pick(clientX: number, clientY: number): Pick {
    const ray = this.ray(clientX, clientY);
    const { model } = this;
    const targets: THREE.Object3D[] = [
      ...model.buttons.map((b) => b.mesh),
      model.screens.inner.mesh,
      model.screens.cover.mesh,
      ...model.halves.camera,
      ...model.halves.cover,
    ];
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;

    const buttonIndex = model.buttons.findIndex((b) => b.mesh === hit.object);
    if (buttonIndex >= 0) return { kind: "button", index: buttonIndex };

    const W = DUO.halfWidth;
    if (hit.object === model.screens.inner.mesh && hit.uv) {
      const { u, v } = innerFaceToFramebuffer(hit.uv.x, hit.uv.y);
      if (insideFramebuffer(u, v)) return { kind: "screen", display: "inner", u, v };
      // The bezel around the panel: part of whichever half it lies on.
      return {
        kind: "body",
        half: hit.uv.x >= 0 ? "camera" : "cover",
        flat: { x: hit.uv.x, y: hit.uv.y, z: DUO.thickness / 2 },
        edge: Math.abs(hit.uv.x) > W - HINGE_GRAB_MM,
      };
    }
    if (hit.object === model.screens.cover.mesh && hit.uv) {
      const { u, v } = coverFaceToFramebuffer(hit.uv.x, hit.uv.y);
      if (insideFramebuffer(u, v)) return { kind: "screen", display: "cover", u, v };
      return {
        kind: "body",
        half: "cover",
        flat: { x: hit.uv.x, y: hit.uv.y, z: -DUO.thickness / 2 },
        edge: -hit.uv.x > W - HINGE_GRAB_MM,
      };
    }
    // A solid part: find where on its half (in flat coordinates) it was held.
    const half: "camera" | "cover" = model.halves.cover.includes(hit.object) ? "cover" : "camera";
    const local = hit.object.parent ? hit.object.parent.worldToLocal(hit.point.clone()) : hit.point.clone();
    return {
      kind: "body",
      half,
      flat: { x: local.x, y: local.y, z: local.z },
      edge: Math.abs(local.x) > W - HINGE_GRAB_MM,
    };
  }

  /** Where a point held on a half would be on screen (CSS px) at a hinge angle. */
  private screenPointAt(half: "camera" | "cover", flat: Vec3, hinge: number): THREE.Vector2 {
    const beta = hingeToBeta(hinge);
    const p = half === "cover" ? coverHalfPoint(flat, beta) : flat;
    const c = deviceCentroid(beta);
    const auto = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, autoYaw(beta));
    const world = new THREE.Vector3(p.x - c.x, p.y - c.y, p.z - c.z).applyQuaternion(this.userQuat.clone().multiply(auto));
    world.project(this.camera);
    return new THREE.Vector2(((world.x + 1) / 2) * this.width, ((1 - world.y) / 2) * this.height);
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.callbacks.onEngage?.();
    const pick = this.pick(e.clientX, e.clientY);
    let drag: Drag;
    if (pick?.kind === "button") {
      drag = { kind: "button", index: pick.index };
      this.pressed.add(pick.index);
    } else if (pick?.kind === "screen" && this.live && !e.shiftKey) {
      // A second pointer on the same panel is a second finger.
      const used = [...this.drags.values()].filter((d) => d.kind === "touch").map((d) => (d as { finger: 0 | 1 }).finger);
      if (used.length >= 2) return;
      const finger: 0 | 1 = used.includes(0) ? 1 : 0;
      const pinch = e.altKey && e.pointerType === "mouse" && used.length === 0;
      drag = { kind: "touch", display: pick.display, finger, u: pick.u, v: pick.v, pinch };
      this.sendTouch(pick.display, "down", pick.u, pick.v, finger);
      // Option-drag: a second finger mirrored through the panel's centre.
      if (pinch) this.sendTouch(pick.display, "down", 1 - pick.u, 1 - pick.v, 1);
    } else if (pick?.kind === "body" && pick.edge && !e.shiftKey) {
      drag = { kind: "hinge", lastX: e.clientX, lastY: e.clientY, half: pick.half, flat: pick.flat };
      this.hingeUserAt = performance.now();
      this.posed = true;
    } else {
      drag = { kind: "orbit", lastX: e.clientX, lastY: e.clientY };
      this.posed = true;
      this.settleAttitude();
      this.spin = { x: 0, y: 0 };
      this.userQuatTarget.copy(this.userQuat);
    }
    e.preventDefault();
    this.drags.set(e.pointerId, drag);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    this.updateCursor(pick, true);
    this.invalidate();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const drag = this.drags.get(e.pointerId);
    if (!drag) {
      if (e.pointerType === "mouse") this.hover(e.clientX, e.clientY);
      return;
    }
    switch (drag.kind) {
      case "orbit": {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        // Two orbit pointers (fingers) at once: a pinch, which zooms.
        const orbits = [...this.drags.entries()].filter(([, d]) => d.kind === "orbit");
        if (orbits.length === 2) {
          const other = orbits.find(([id]) => id !== e.pointerId)?.[1] as { lastX: number; lastY: number };
          const before = Math.hypot(e.clientX - dx - other.lastX, e.clientY - dy - other.lastY);
          const after = Math.hypot(e.clientX - other.lastX, e.clientY - other.lastY);
          if (before > 10) this.zoomTarget = clamp(this.zoomTarget * (after / before), ZOOM_MIN, ZOOM_MAX);
          break;
        }
        const k = (Math.PI * 1.15) / Math.min(this.width, this.height);
        this.turnBy(dx * k, dy * k);
        // Remember the pace, so letting go mid-turn carries on a little.
        this.spin = { x: dx * k * 60, y: dy * k * 60 };
        break;
      }
      case "hinge": {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        // How the held point moves on screen per degree of hinge, here and now.
        const a = this.screenPointAt(drag.half, drag.flat, Math.min(180, this.hingeTarget + 0.5));
        const b = this.screenPointAt(drag.half, drag.flat, Math.max(0, this.hingeTarget - 0.5));
        const gx = a.x - b.x;
        const gy = a.y - b.y;
        const g2 = gx * gx + gy * gy;
        let delta: number;
        if (g2 > 0.09) {
          // The point follows the pointer.
          delta = (dx * gx + dy * gy) / g2;
        } else {
          // Square on and nearly flat the edge barely moves on screen: treat
          // a pull towards the middle as "fold".
          const centre = this.screenPointAt(drag.half, { x: 0, y: 0, z: 0 }, this.hingeTarget);
          const here = this.screenPointAt(drag.half, drag.flat, this.hingeTarget);
          const outward = Math.sign(here.x - centre.x) || 1;
          delta = (dx * outward * 220) / Math.max(120, this.width);
        }
        this.hingeTarget = clamp(this.hingeTarget + delta, 0, 180);
        // Follow the hand exactly; the host eases its own.
        this.hingeShown = this.hingeTarget;
        this.hingeUserAt = performance.now();
        this.callbacks.onHingeRequest(this.hingeTarget, false);
        break;
      }
      case "touch": {
        const pick = this.pick(e.clientX, e.clientY);
        if (pick?.kind === "screen" && pick.display === drag.display) {
          drag.u = clamp(pick.u, 0, 1);
          drag.v = clamp(pick.v, 0, 1);
          this.pendingMoves.set(e.pointerId, {
            display: drag.display,
            finger: drag.finger,
            u: drag.u,
            v: drag.v,
            pinch: drag.pinch,
          });
        }
        break;
      }
      case "button": {
        // Sliding off the button cancels the press.
        const pick = this.pick(e.clientX, e.clientY);
        if (pick?.kind === "button" && pick.index === drag.index) this.pressed.add(drag.index);
        else this.pressed.delete(drag.index);
        break;
      }
    }
    this.invalidate();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const drag = this.drags.get(e.pointerId);
    if (!drag) return;
    this.drags.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    switch (drag.kind) {
      case "orbit":
        if (Math.hypot(this.spin.x, this.spin.y) < 0.6) {
          this.spin = { x: 0, y: 0 };
          this.snapIfNearlySquare();
        }
        break;
      case "hinge": {
        // Let go close to shut or flat: finish the move.
        if (this.hingeTarget < 12) this.hingeTarget = 0;
        else if (this.hingeTarget > 168) this.hingeTarget = 180;
        this.hingeUserAt = performance.now();
        this.callbacks.onHingeRequest(this.hingeTarget, true);
        break;
      }
      case "touch":
        this.pendingMoves.delete(e.pointerId);
        this.endTouch(drag);
        break;
      case "button":
        if (this.pressed.delete(drag.index) && e.type === "pointerup") {
          this.callbacks.onInput({ kind: "button", button: this.model.buttons[drag.index].button });
        }
        break;
    }
    this.updateCursor(e.pointerType === "mouse" ? this.pick(e.clientX, e.clientY) : null, false);
    this.invalidate();
  };

  private readonly onPointerLeave = (): void => {
    if (this.drags.size === 0) this.setHoverButton(-1);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const pick = e.ctrlKey || e.metaKey ? null : this.pick(e.clientX, e.clientY);
    if (pick?.kind === "screen" && this.live) {
      const { dx, dy } = this.wheelInPanelAxes(pick.display, e.clientX, e.clientY, e.deltaX, e.deltaY);
      this.callbacks.onInput({
        kind: "scroll",
        display: pick.display,
        normX: pick.u,
        normY: pick.v,
        deltaX: dx,
        deltaY: dy,
      });
      return;
    }
    // Trackpad pinch arrives as a wheel with ctrl held and small deltas.
    const scale = e.ctrlKey ? 0.012 : 0.0016;
    this.zoomTarget = clamp(this.zoomTarget * Math.exp(-e.deltaY * scale), ZOOM_MIN, ZOOM_MAX);
    this.invalidate();
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.pick(e.clientX, e.clientY) === null) this.resetView();
  };

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  private readonly onContextRestored = (): void => {
    // The studio the metal reflects lived on the GPU: make it again.
    this.buildEnvironment();
    for (const display of ["cover", "inner"] as const) this.textures[display].needsUpdate = true;
    this.invalidate();
  };

  /**
   * A wheel movement, which is in the page's axes, expressed along the
   * panel's own framebuffer axes — however the device happens to be turned.
   */
  private wheelInPanelAxes(
    display: DuoDisplay,
    clientX: number,
    clientY: number,
    deltaX: number,
    deltaY: number,
  ): { dx: number; dy: number } {
    const here = this.pick(clientX, clientY);
    const alongX = this.pick(clientX + 6, clientY);
    const alongY = this.pick(clientX, clientY + 6);
    if (
      here?.kind !== "screen" ||
      alongX?.kind !== "screen" ||
      alongY?.kind !== "screen" ||
      alongX.display !== display ||
      alongY.display !== display
    ) {
      return { dx: deltaX, dy: deltaY };
    }
    // Framebuffer movement per page pixel, scaled so a level panel passes the wheel through unchanged.
    const size = display === "inner" ? DUO.innerPixels : DUO.coverPixels;
    const ax = { u: (alongX.u - here.u) * size.width, v: (alongX.v - here.v) * size.height };
    const ay = { u: (alongY.u - here.u) * size.width, v: (alongY.v - here.v) * size.height };
    const norm = Math.max(1e-6, Math.sqrt(Math.abs(ax.u * ay.v - ax.v * ay.u)));
    return {
      dx: (deltaX * ax.u + deltaY * ay.u) / norm,
      dy: (deltaX * ax.v + deltaY * ay.v) / norm,
    };
  }

  // ── Touch plumbing ─────────────────────────────────────────────────────────

  private sendTouch(display: DuoDisplay, phase: "down" | "move" | "up", u: number, v: number, finger: 0 | 1): void {
    this.callbacks.onInput({ kind: "touch", display, phase, normX: clamp(u, 0, 1), normY: clamp(v, 0, 1), finger });
    this.keepTouchesAlive();
  }

  /**
   * The host lifts a finger it has heard nothing of for a few seconds (in case
   * the client has gone). A finger held still sends nothing, so while any is
   * down its position is repeated every couple of seconds: a long press, or a
   * drag paused mid-way, stays down.
   */
  private keepTouchesAlive(): void {
    const touching = [...this.drags.values()].some((d) => d.kind === "touch");
    if (!touching) {
      if (this.touchKeepAlive) clearInterval(this.touchKeepAlive);
      this.touchKeepAlive = null;
      return;
    }
    if (this.touchKeepAlive) return;
    this.touchKeepAlive = setInterval(() => {
      let any = false;
      for (const d of this.drags.values()) {
        if (d.kind !== "touch") continue;
        any = true;
        this.callbacks.onInput({ kind: "touch", display: d.display, phase: "move", normX: d.u, normY: d.v, finger: d.finger });
        if (d.pinch) {
          this.callbacks.onInput({ kind: "touch", display: d.display, phase: "move", normX: 1 - d.u, normY: 1 - d.v, finger: 1 });
        }
      }
      if (!any && this.touchKeepAlive) {
        clearInterval(this.touchKeepAlive);
        this.touchKeepAlive = null;
      }
    }, 2000);
  }

  /** Moves are gathered and sent once per drawn frame: no faster than the picture can answer. */
  private flushTouchMoves(): void {
    if (this.pendingMoves.size === 0) return;
    for (const move of this.pendingMoves.values()) {
      this.sendTouch(move.display, "move", move.u, move.v, move.finger);
      if (move.pinch) this.sendTouch(move.display, "move", 1 - move.u, 1 - move.v, 1);
    }
    this.pendingMoves.clear();
  }

  private endTouch(drag: { display: DuoDisplay; finger: 0 | 1; u: number; v: number; pinch: boolean }): void {
    this.sendTouch(drag.display, "up", drag.u, drag.v, drag.finger);
    if (drag.pinch) this.sendTouch(drag.display, "up", 1 - drag.u, 1 - drag.v, 1);
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  private hover(clientX: number, clientY: number): void {
    const pick = this.pick(clientX, clientY);
    this.setHoverButton(pick?.kind === "button" ? pick.index : -1);
    this.updateCursor(pick, false);
  }

  private setHoverButton(index: number): void {
    if (index === this.hoverButton) return;
    this.hoverButton = index;
    const names: Record<DuoButton, string> = { lock: "Side button (lock)", volumeUp: "Volume up", volumeDown: "Volume down" };
    this.canvas.title = index >= 0 ? names[this.model.buttons[index].button] : "";
  }

  private updateCursor(pick: Pick, down: boolean): void {
    let cursor = down ? "grabbing" : "grab";
    if (pick?.kind === "button") cursor = "pointer";
    else if (pick?.kind === "screen" && this.live) cursor = "default";
    else if (pick?.kind === "body" && pick.edge) cursor = down ? "grabbing" : "ew-resize";
    this.canvas.style.cursor = cursor;
  }
}

/** A soft dark oval, fading to nothing: the device's shadow. */
function shadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(0,0,0,0.85)");
    g.addColorStop(0.45, "rgba(0,0,0,0.5)");
    g.addColorStop(0.75, "rgba(0,0,0,0.14)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
