import React from 'react';

// Catches errors thrown while loading/parsing the venue model (useGLTF suspense throw)
// so a bad file logs a clear message instead of blanking the whole 3D canvas.
export class ModelBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error('[scene] venue model failed to load:', err); }
  componentDidUpdate(prev: { children: React.ReactNode }) {
    // Reset when the model (children) changes so a new import can retry.
    if (prev.children !== this.props.children && this.state.failed) this.setState({ failed: false });
  }
  render() { return this.state.failed ? null : this.props.children; }
}
