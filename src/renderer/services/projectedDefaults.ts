/**
 * Self-shadow bias in metres, when a model does not carry its own. 2 cm holds on venue-scale geometry
 * (the world is metres by convention — see SceneModel.scale) without letting content leak past a
 * silhouette by anything an audience can see.
 *
 * In a file of its own (E5/W5h) so the Model card, which may open in a panel window, can show the
 * default without importing the projected-mapping renderer (three.js).
 */
export const DEFAULT_BIAS_M = 0.02;
