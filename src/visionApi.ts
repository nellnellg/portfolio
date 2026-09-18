import { TouchEvent } from "./domain";

export type VisionAnalysis = {
  durationSeconds: number;
  totalTouches: number;
  bestStreak: number;
  leftTouches: number;
  rightTouches: number;
  trackingConfidence: number;
  touches: TouchEvent[];
  diagnostics: {
    sampledFrames: number;
    ballCoverage: number;
    feetCoverage: number;
  };
};

export async function analyzeTrainingClip(endpoint: string, videoUri: string): Promise<VisionAnalysis> {
  const body = new FormData();
  body.append(
    "video",
    {
      uri: videoUri,
      name: "training-session.mov",
      type: "video/quicktime"
    } as unknown as Blob
  );

  const response = await fetch(endpoint.replace(/\/$/, "") + "/analyze", {
    method: "POST",
    body
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Vision analysis failed.");
  }

  return response.json() as Promise<VisionAnalysis>;
}