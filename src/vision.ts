import { CameraMode, Foot, TouchEvent } from "./domain";

/**
 * The UI depends on this small interface rather than a specific model.
 * The native iOS module will replace the manual reporter with:
 * MediaPipe foot landmarks + a Core ML ball detector + temporal contact scoring.
 */
export type VisionUpdate = {
  touch?: TouchEvent;
  confidence: number;
  framingReady: boolean;
};

export interface VisionSessionAdapter {
  start(mode: CameraMode): Promise<void>;
  stop(): Promise<void>;
  onUpdate(listener: (update: VisionUpdate) => void): () => void;
}

/** Development adapter used until the native camera module is connected. */
export class ManualVisionAdapter implements VisionSessionAdapter {
  private listener?: (update: VisionUpdate) => void;

  async start(_mode: CameraMode): Promise<void> {
    this.listener?.({ confidence: 0.92, framingReady: true });
  }

  async stop(): Promise<void> {
    this.listener = undefined;
  }

  onUpdate(listener: (update: VisionUpdate) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  reportTouch(foot: Foot, atSeconds: number): void {
    this.listener?.({
      confidence: 0.92,
      framingReady: true,
      touch: {
        id: `${Date.now()}-${foot}`,
        atSeconds,
        foot,
        confidence: 0.92
      }
    });
  }
}