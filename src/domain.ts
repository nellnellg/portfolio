export type Foot = "left" | "right";
export type CameraMode = "tripod" | "handheld";

export type TouchEvent = {
  id: string;
  atSeconds: number;
  foot: Foot;
  confidence: number;
};

export type TrainingSession = {
  id: string;
  createdAt: string;
  durationSeconds: number;
  cameraMode: CameraMode;
  touches: TouchEvent[];
  totalTouches: number;
  bestStreak: number;
  leftTouches: number;
  rightTouches: number;
  trackingConfidence: number;
  correctionDelta: number;
};

export type DrillRecommendation = {
  title: string;
  focus: string;
  duration: string;
  cue: string;
  reason: string;
};