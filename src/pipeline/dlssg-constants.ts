/**
 * The camera and depth constants DLSS Frame Generation needs for video, which has neither: a
 * static perspective camera looking at a flat, screen-filling plane, with all motion on the plane.
 */

/** A 4x4 matrix as float[16], row-major and post-multiplied (clip = view · M), the DLSS-FG layout (Programming Guide v310.7.0 p.22). */
export type RowMajorMatrix4 = Float32Array;

export interface DlssgIntervalConstants {
  cameraViewToClip: RowMajorMatrix4;
  clipToCameraView: RowMajorMatrix4;
  /** Identity: the camera never moves, so previous and current clip space coincide. */
  clipToPrevClip: RowMajorMatrix4;
  prevClipToClip: RowMajorMatrix4;
  /** Identity: no lens distortion. */
  clipToLensClip: RowMajorMatrix4;
  /** Hardware depth of the video plane, for every pixel of the R32_FLOAT depth texture; DepthInverted = 0. */
  planeDepth: number;
}

// The camera the host was verified with on nvngx_dlssg.dll 310.9.1. Any constant depth short of
// the far plane gave identical 2x output, while depth at the far plane interpolates visibly
// worse, so the plane sits between near and far.
const CAMERA_NEAR = 1;
const CAMERA_FAR = 100;
const CAMERA_VERTICAL_FOV_RADIANS = Math.PI / 2;
const PLANE_DISTANCE = 10;
const Y_SCALE = 1 / Math.tan(CAMERA_VERTICAL_FOV_RADIANS / 2);
const DEPTH_SCALE = CAMERA_FAR / (CAMERA_FAR - CAMERA_NEAR);

/** Left-handed D3D perspective: view z in [near, far] maps to depth [0, 1]. */
function perspectiveViewToClip(aspectRatio: number): number[] {
  const xScale = Y_SCALE / aspectRatio;
  return [
    xScale, 0, 0, 0,
    0, Y_SCALE, 0, 0,
    0, 0, DEPTH_SCALE, 1,
    0, 0, -CAMERA_NEAR * DEPTH_SCALE, 0,
  ];
}

/**
 * Closed-form inverse of perspectiveViewToClip: the x and y scales invert on the diagonal, and
 * the z/w block [[DEPTH_SCALE, 1], [-near·DEPTH_SCALE, 0]] has determinant near·DEPTH_SCALE.
 */
function perspectiveClipToView(aspectRatio: number): number[] {
  const xScale = Y_SCALE / aspectRatio;
  return [
    1 / xScale, 0, 0, 0,
    0, 1 / Y_SCALE, 0, 0,
    0, 0, 0, -1 / (CAMERA_NEAR * DEPTH_SCALE),
    0, 0, 1, 1 / CAMERA_NEAR,
  ];
}

/** Depth the projection above gives a point at view distance `distance`: far/(far-near) · (1 - near/distance). */
function hardwareDepthAt(distance: number): number {
  return DEPTH_SCALE * (1 - CAMERA_NEAR / distance);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The same for every interval of a session; the aspect ratio is the frame's width over its height. */
export function dlssgIntervalConstants(frame: { width: number; height: number }): DlssgIntervalConstants {
  const aspectRatio = frame.width / frame.height;
  return {
    cameraViewToClip: Float32Array.from(perspectiveViewToClip(aspectRatio)),
    clipToCameraView: Float32Array.from(perspectiveClipToView(aspectRatio)),
    clipToPrevClip: Float32Array.from(IDENTITY),
    prevClipToClip: Float32Array.from(IDENTITY),
    clipToLensClip: Float32Array.from(IDENTITY),
    planeDepth: hardwareDepthAt(PLANE_DISTANCE),
  };
}
