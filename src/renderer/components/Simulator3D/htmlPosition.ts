// WHERE A DOM LABEL GOES (drei <Html calculatePosition>) — plans/3d-workbench.md Phase 2.
//
// drei's Html projects its object with the default camera and lays the label out over the WHOLE canvas.
// In four views the default camera is the Perspective PANE's (top-right quarter, at the pane's aspect), so
// every label landed scaled across the whole canvas — the tracking zones' names floated over the flat panes
// (measured). This maps the projection into the Perspective pane while the four-view layout is up, and parks
// a label whose point is outside that pane off-screen. With one view it is exactly drei's default.
//
// Handed to plugin scene overlays as the `htmlPosition` prop (SDK SceneVizContribution), and used by the
// core's own labels (AnchorMarker). MultiView switches it on and off.
import * as THREE from 'three';
import { QUAD_PANES, paneRect } from '../../services/view3d';

let quadActive = false;
export function setQuadHtml(on: boolean): void { quadActive = on; }

const PERSP = QUAD_PANES.find((p) => p.view === 'persp')!;
const _p = new THREE.Vector3();
const OFF: number[] = [-1e5, -1e5];

export function htmlPosition(el: THREE.Object3D, camera: THREE.Camera, size: { width: number; height: number }): number[] {
  _p.setFromMatrixPosition(el.matrixWorld).project(camera);
  if (!quadActive) {
    const wh = size.width / 2, hh = size.height / 2;
    return [_p.x * wh + wh, -(_p.y * hh) + hh];      // drei's defaultCalculatePosition
  }
  if (_p.x < -1 || _p.x > 1 || _p.y < -1 || _p.y > 1) return OFF;
  const r = paneRect(PERSP, size.width, size.height);
  return [r.x + ((_p.x + 1) / 2) * r.w, r.y + ((1 - _p.y) / 2) * r.h];
}
