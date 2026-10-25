// The 3D scene's viewport id — declared ONCE (verify:invariants: "the scene3d viewport id is declared
// once"). WorkspaceShell keeps the 3D out of the left pane by comparing against it, so a drifted second
// copy would mount Simulator3D in both panes: two WebGL contexts, two render loops.
//
// Its own tiny module so code outside the shell can name the viewport without importing the shell:
// the calibration plugin's contexts declare it, and the plugin is in the chunk every projector window
// evaluates — WorkspaceShell (and everything it imports) must not ride along into those windows.
export const SCENE_3D_VIEWPORT = 'core.viewport.scene3d';
