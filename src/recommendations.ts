import { DrillRecommendation, TrainingSession } from "./domain";

const fallback: DrillRecommendation = {
  title: "Alternating-feet cadence",
  focus: "Rhythm and control",
  duration: "3 × 45 sec",
  cue: "Keep the ball below waist height and alternate feet on every touch.",
  reason: "Your current balance and streak are ready for a rhythm challenge."
};

export function recommendDrill(
  session: TrainingSession,
  history: TrainingSession[]
): DrillRecommendation {
  if (session.trackingConfidence < 0.75) {
    return {
      title: "Camera setup reset",
      focus: "Reliable tracking",
      duration: "2 min",
      cue: "Step back until both ankles and the ball stay visible, then retry with even lighting.",
      reason: "This session had low tracking confidence, so a cleaner setup will make your results more useful."
    };
  }

  const classified = session.leftTouches + session.rightTouches;
  const imbalance = classified
    ? Math.abs(session.leftTouches - session.rightTouches) / classified
    : 0;

  if (imbalance > 0.25) {
    const weakerFoot = session.leftTouches < session.rightTouches ? "left" : "right";
    return {
      title: `${weakerFoot[0].toUpperCase() + weakerFoot.slice(1)}-foot ladder`,
      focus: "Foot balance",
      duration: "4 × 30 sec",
      cue: `Start every round with your ${weakerFoot} foot and aim for two ${weakerFoot}-foot touches before switching.`,
      reason: "Your foot usage is more than 25% imbalanced."
    };
  }

  if (session.bestStreak <= 5) {
    return {
      title: "Low-height control ladder",
      focus: "First-touch consistency",
      duration: "3 × 40 sec",
      cue: "Use soft laces touches and keep every contact below knee height.",
      reason: "Building a longer controlled streak is the biggest win right now."
    };
  }

  const validHistory = history.filter((item) => item.trackingConfidence >= 0.75).slice(0, 3);
  const historicalRate = validHistory.length
    ? validHistory.reduce((sum, item) => sum + item.totalTouches / Math.max(item.durationSeconds, 1), 0) / validHistory.length
    : 0;
  const currentRate = session.totalTouches / Math.max(session.durationSeconds, 1);

  if (historicalRate && currentRate < historicalRate * 0.85) {
    return {
      title: "Consistency recovery",
      focus: "Session rhythm",
      duration: "3 × 30 sec",
      cue: "Take a breath between rounds and aim for a smooth, repeatable tempo.",
      reason: "Your touches per minute dipped more than 15% from recent valid sessions."
    };
  }

  return fallback;
}