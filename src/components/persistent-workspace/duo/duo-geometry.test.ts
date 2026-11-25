/**
 * The iPhone Duo's geometry: how the halves fold, where each panel's picture
 * sits, and which way up iOS is told the device is.
 */
import { describe, expect, test } from 'vitest';
import {
  DUO,
  DUO_POSES,
  HINGE_AXIS_Z,
  INNER_FACE_Z,
  autoYaw,
  coverFaceToFramebuffer,
  coverHalfDirection,
  coverHalfPoint,
  deviceCentroid,
  framebufferToCoverFace,
  framebufferToInnerFace,
  hingeToBeta,
  innerFacePoint,
  innerFaceToFramebuffer,
  orientationFromUp,
  uprightQuarterTurns,
} from './duo-geometry';
import { spineProfile } from './duo-model';

const RAD = Math.PI / 180;
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('fold', () => {
  test('the hinge angle and the fold run opposite ways', () => {
    close(hingeToBeta(180), 0);
    close(hingeToBeta(0), Math.PI);
    close(hingeToBeta(90), Math.PI / 2);
    close(hingeToBeta(500), 0); // out of range is clamped
  });

  test('open flat, the cover half is where it was drawn', () => {
    const p = coverHalfPoint({ x: -40, y: 10, z: 1 }, 0);
    close(p.x, -40);
    close(p.y, 10);
    close(p.z, 1);
  });

  test('shut, the inner faces meet with the closed gap between them', () => {
    // A point on the cover half's inner face ends up facing the camera half's.
    const p = coverHalfPoint({ x: -40, y: 0, z: INNER_FACE_Z }, Math.PI);
    close(p.x, 40);
    close(p.z, INNER_FACE_Z + DUO.closedGap);
    const n = coverHalfDirection({ x: 0, y: 0, z: 1 }, Math.PI);
    close(n.z, -1);
  });

  test('folding swings the cover half towards the viewer', () => {
    const p = coverHalfPoint({ x: -DUO.halfWidth, y: 0, z: 0 }, 90 * RAD);
    expect(p.z).toBeGreaterThan(DUO.halfWidth - 10);
    expect(Math.abs(p.x)).toBeLessThan(10);
  });

  test('the centre of weight starts in the middle and ends over the camera half', () => {
    close(deviceCentroid(0).x, 0);
    close(deviceCentroid(Math.PI).x, DUO.halfWidth / 2);
  });

  test('the device turns to face its halves evenly when part folded, not when open or shut', () => {
    close(autoYaw(0), 0);
    close(autoYaw(60 * RAD), -30 * RAD);
    close(autoYaw(Math.PI), 0);
  });
});

describe('inner face (the sheet that bends)', () => {
  test('flat when open', () => {
    for (const x of [-80, -2, 0, 2, 80]) {
      const { position, normal } = innerFacePoint(x, 5, 0);
      close(position.x, x);
      close(position.z, INNER_FACE_Z);
      close(normal.z, 1);
    }
  });

  test('away from the fold it rides on its half', () => {
    const beta = 70 * RAD;
    const onCamera = innerFacePoint(50, 0, beta);
    close(onCamera.position.x, 50);
    close(onCamera.position.z, INNER_FACE_Z);
    const onCover = innerFacePoint(-50, 0, beta);
    const expected = coverHalfPoint({ x: -50, y: 0, z: INNER_FACE_Z }, beta);
    close(onCover.position.x, expected.x);
    close(onCover.position.z, expected.z);
  });

  test('the bend joins both halves without a step or a kink', () => {
    const t0 = DUO.bendHalfWidth;
    for (const beta of [5 * RAD, 60 * RAD, 120 * RAD, 175 * RAD]) {
      // At the camera half's edge of the bend…
      const a = innerFacePoint(t0 - 1e-7, 0, beta);
      const b = innerFacePoint(t0, 0, beta);
      close(a.position.x, b.position.x, 1e-4);
      close(a.position.z, b.position.z, 1e-4);
      close(a.normal.z, b.normal.z, 1e-4);
      // …and at the cover half's.
      const c = innerFacePoint(-t0 + 1e-7, 0, beta);
      const d = innerFacePoint(-t0, 0, beta);
      close(c.position.x, d.position.x, 1e-4);
      close(c.position.z, d.position.z, 1e-4);
      close(c.normal.x, d.normal.x, 1e-4);
      close(c.normal.z, d.normal.z, 1e-4);
    }
  });

  test('the bend never passes through the hinge axis side of either half', () => {
    // Every point of the arc is on the viewer's side of the camera half's face.
    for (const beta of [30 * RAD, 90 * RAD, 150 * RAD]) {
      for (let x = -DUO.bendHalfWidth; x <= DUO.bendHalfWidth; x += 0.5) {
        expect(innerFacePoint(x, 0, beta).position.z).toBeGreaterThanOrEqual(INNER_FACE_Z - 1e-9);
      }
    }
    expect(HINGE_AXIS_Z).toBeGreaterThan(INNER_FACE_Z);
  });
});

describe('where the pictures sit', () => {
  test('inner: the image is a quarter turn from the panel', () => {
    const { width, height } = DUO.inner;
    // The image's top-left corner is the panel's top-right (camera half, top).
    expect(innerFaceToFramebuffer(width / 2, height / 2)).toEqual({ u: 0, v: 0 });
    // Its left edge runs along the device's top.
    const topLeftOfDevice = innerFaceToFramebuffer(-width / 2, height / 2);
    close(topLeftOfDevice.u, 0);
    close(topLeftOfDevice.v, 1);
    // Its bottom-right is the device's bottom-left.
    const bottomLeft = innerFaceToFramebuffer(-width / 2, -height / 2);
    close(bottomLeft.u, 1);
    close(bottomLeft.v, 1);
  });

  test('inner: there and back again', () => {
    for (const [u, v] of [[0, 0], [1, 1], [0.25, 0.8], [0.5, 0.5]] as const) {
      const p = framebufferToInnerFace(u, v);
      const back = innerFaceToFramebuffer(p.x, p.y);
      close(back.u, u);
      close(back.v, v);
    }
  });

  test('inner: the panel and its image have the same proportions', () => {
    close(DUO.inner.width / DUO.inner.height, DUO.innerPixels.height / DUO.innerPixels.width, 0.01);
    close(DUO.cover.height / DUO.cover.width, DUO.coverPixels.height / DUO.coverPixels.width, 0.01);
  });

  test('cover: the hinge is on the image\'s left, the top is the top', () => {
    const { width, height, hingeInset } = DUO.cover;
    const nearHingeTop = coverFaceToFramebuffer(-hingeInset, height / 2);
    close(nearHingeTop.u, 0);
    close(nearHingeTop.v, 0);
    const outerBottom = coverFaceToFramebuffer(-(hingeInset + width), -height / 2);
    close(outerBottom.u, 1);
    close(outerBottom.v, 1);
    const p = framebufferToCoverFace(0.3, 0.7);
    const back = coverFaceToFramebuffer(p.x, p.y);
    close(back.u, 0.3);
    close(back.v, 0.7);
  });

  test('both panels fit on the body', () => {
    expect(DUO.inner.width).toBeLessThan(DUO.halfWidth * 2);
    expect(DUO.inner.height).toBeLessThan(DUO.height);
    expect(DUO.cover.hingeInset + DUO.cover.width).toBeLessThan(DUO.halfWidth);
    expect(DUO.cover.height).toBeLessThan(DUO.height);
  });
});

describe('which way up', () => {
  const up = (x: number, y: number) => ({ x, y });

  test('held upright, open: portrait', () => {
    expect(orientationFromUp(up(0, 1), up(0, 1), false, 'landscape-left')).toBe('portrait');
  });

  test('each outer edge up is its own landscape', () => {
    expect(orientationFromUp(up(1, 0), up(1, 0), false, 'portrait')).toBe('landscape-left');
    expect(orientationFromUp(up(-1, 0), up(-1, 0), false, 'portrait')).toBe('landscape-right');
    expect(orientationFromUp(up(0, -1), up(0, -1), false, 'portrait')).toBe('portrait-upside-down');
  });

  test('lying flat says nothing: the last answer stands', () => {
    expect(orientationFromUp(up(0.05, 0.02), up(0.03, 0.02), false, 'landscape-right')).toBe('landscape-right');
  });

  test('near a diagonal it does not flip-flop', () => {
    // Slightly more "x" than "y", but not clearly: stays as it was.
    expect(orientationFromUp(up(0.74, 0.67), up(0.74, 0.67), false, 'portrait')).toBe('portrait');
    expect(orientationFromUp(up(0.74, 0.67), up(0.74, 0.67), false, 'landscape-left')).toBe('landscape-left');
    // Clearly over: switches.
    expect(orientationFromUp(up(0.95, 0.3), up(0.95, 0.3), false, 'portrait')).toBe('landscape-left');
  });

  test('standing on one half, the half that is upright decides', () => {
    // Tabletop: cover half flat (says nothing), camera half standing, its outer edge up.
    expect(orientationFromUp(up(0.95, 0), up(0, 0), false, 'portrait')).toBe('landscape-left');
    // The other way round: camera half flat, cover half standing.
    expect(orientationFromUp(up(0, 0), up(-0.95, 0), false, 'portrait')).toBe('landscape-right');
  });

  test('with the cover screen in use only the cover half counts', () => {
    expect(orientationFromUp(up(1, 0), up(0, 1), true, 'landscape-left')).toBe('portrait');
  });
});

describe('screenshots', () => {
  test('the cover image is always upright', () => {
    expect(uprightQuarterTurns('cover', 'landscape-left')).toBe(0);
  });
  test('the inner image is turned to read upright for each way of holding', () => {
    expect(uprightQuarterTurns('inner', 'portrait')).toBe(1);
    expect(uprightQuarterTurns('inner', 'landscape-left')).toBe(0);
    expect(uprightQuarterTurns('inner', 'landscape-right')).toBe(2);
    expect(uprightQuarterTurns('inner', 'portrait-upside-down')).toBe(3);
  });
});

describe('postures', () => {
  test('each has a hinge angle the simulator accepts', () => {
    for (const pose of DUO_POSES) {
      expect(pose.hinge).toBeGreaterThanOrEqual(0);
      expect(pose.hinge).toBeLessThanOrEqual(180);
    }
    expect(new Set(DUO_POSES.map((p) => p.id)).size).toBe(DUO_POSES.length);
  });
});

describe('hinge spine', () => {
  const radius = HINGE_AXIS_Z + DUO.thickness / 2;

  test('meets the back of each half flush, whatever the fold', () => {
    for (const beta of [20 * RAD, 90 * RAD, Math.PI]) {
      const profile = spineProfile(beta, 28, radius, 2.3);
      // Starts straight behind the camera half…
      close(profile[0].x, 0, 1e-9);
      close(profile[0].z, HINGE_AXIS_Z - radius, 1e-9);
      // …and ends straight behind the cover half, the same distance from the axis.
      const end = profile[profile.length - 1];
      close(Math.hypot(end.x, end.z - HINGE_AXIS_Z), radius, 1e-9);
    }
  });

  test('shut, it stands only a little proud of the edges, not a whole radius', () => {
    const profile = spineProfile(Math.PI, 28, radius, 2.3);
    const furthest = Math.min(...profile.map((p) => p.x));
    close(furthest, -2.3, 0.2);
  });

  test('its normals point away from the hinge axis', () => {
    for (const p of spineProfile(120 * RAD, 28, radius, 2.3)) {
      expect(p.nx * p.x + p.nz * (p.z - HINGE_AXIS_Z)).toBeGreaterThan(0);
      close(Math.hypot(p.nx, p.nz), 1, 1e-6);
    }
  });
});
