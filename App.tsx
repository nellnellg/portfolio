import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  CameraMode,
  DrillRecommendation,
  Foot,
  TouchEvent,
  TrainingSession
} from "./src/domain";
import { recommendDrill } from "./src/recommendations";
import { analyzeTrainingClip } from "./src/visionApi";
import { ManualVisionAdapter } from "./src/vision";

type Screen = "home" | "training" | "results" | "progress";

const starterHistory: TrainingSession[] = [
  {
    id: "baseline-1",
    createdAt: "2026-09-16T16:00:00.000Z",
    durationSeconds: 150,
    cameraMode: "tripod",
    touches: [],
    totalTouches: 48,
    bestStreak: 11,
    leftTouches: 20,
    rightTouches: 24,
    trackingConfidence: 0.91,
    correctionDelta: 0
  },
  {
    id: "baseline-2",
    createdAt: "2026-09-14T16:00:00.000Z",
    durationSeconds: 145,
    cameraMode: "tripod",
    touches: [],
    totalTouches: 39,
    bestStreak: 8,
    leftTouches: 18,
    rightTouches: 18,
    trackingConfidence: 0.88,
    correctionDelta: 0
  }
];

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return minutes + ":" + seconds;
}

function currentStreak(touches: TouchEvent[]) {
  if (!touches.length) return 0;
  let streak = 1;
  for (let index = touches.length - 1; index > 0; index -= 1) {
    if (touches[index].atSeconds - touches[index - 1].atSeconds <= 2.2) streak += 1;
    else break;
  }
  return streak;
}

function bestStreak(touches: TouchEvent[]) {
  return touches.reduce((best, _, index) => Math.max(best, currentStreak(touches.slice(0, index + 1))), 0);
}

function AppButton({
  label,
  onPress,
  kind = "primary"
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "ghost";
}) {
  return (
    <Pressable onPress={onPress} style={[styles.button, kind === "primary" ? styles.button_primary : kind === "secondary" ? styles.button_secondary : styles.button_ghost]}>
      <Text style={[styles.buttonText, kind === "primary" ? styles.buttonText_primary : kind === "secondary" ? styles.buttonText_secondary : styles.buttonText_ghost]}>{label}</Text>
    </Pressable>
  );
}

function Metric({
  value,
  label,
  highlight
}: {
  value: string | number;
  label: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.metric, highlight && styles.metricHighlight]}>
      <Text style={[styles.metricValue, highlight && styles.metricValueHighlight]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [cameraMode, setCameraMode] = useState<CameraMode>("tripod");
  const [history, setHistory] = useState<TrainingSession[]>(starterHistory);
  const [touches, setTouches] = useState<TouchEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStart, setSessionStart] = useState<Date | null>(null);
  const [completedSession, setCompletedSession] = useState<TrainingSession | null>(null);
  const [adjustment, setAdjustment] = useState(0);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const recordingPromise = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const adapter = useRef(new ManualVisionAdapter()).current;
  const visionApiUrl = process.env.EXPO_PUBLIC_VISION_API_URL;

  useEffect(() => {
    if (screen !== "training" || !isRecording) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [screen, isRecording]);

  const counts = useMemo(
    () => ({
      left: touches.filter((item) => item.foot === "left").length,
      right: touches.filter((item) => item.foot === "right").length
    }),
    [touches]
  );

  const beginSession = async () => {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();

    if (!permission.granted) {
      setCameraDenied(true);
      return;
    }

    setCameraDenied(false);
    setAnalysisError(null);
    setCameraReady(false);
    setTouches([]);
    setElapsed(0);
    setAdjustment(0);
    setSessionStart(new Date());
    setScreen("training");
    await adapter.start(cameraMode);
  };

  const addTouch = (foot: Foot) => {
    const event: TouchEvent = {
      id: Date.now().toString() + foot,
      atSeconds: elapsed,
      foot,
      confidence: 0.92
    };
    setTouches((items) => [...items, event]);
  };

  const startRecording = () => {
    if (!cameraRef.current || recordingPromise.current) return;

    try {
      setIsRecording(true);
      const promise = cameraRef.current.recordAsync({ maxDuration: 120 });
      recordingPromise.current = promise;
      promise
        .catch(() => setAnalysisError("The camera could not record this session."))
        .finally(() => setIsRecording(false));
    } catch {
      setIsRecording(false);
      setAnalysisError("The camera is still preparing. Please start the session again.");
    }
  };

  const finishSession = async () => {
    setIsAnalyzing(true);
    cameraRef.current?.stopRecording();
    let clip: { uri: string } | undefined;
    try {
      clip = await recordingPromise.current;
    } catch {
      setAnalysisError("The camera recording did not complete. Please try again.");
    }
    recordingPromise.current = null;
    await adapter.stop();

    let detectedTouches = touches;
    let durationSeconds = Math.max(elapsed, 1);
    let confidence = touches.length ? 0.92 : 0.68;
    let detectedBestStreak = bestStreak(touches);
    let leftTouches = counts.left;
    let rightTouches = counts.right;

    if (clip?.uri && visionApiUrl) {
      try {
        const analysis = await analyzeTrainingClip(visionApiUrl, clip.uri);
        detectedTouches = analysis.touches;
        durationSeconds = analysis.durationSeconds;
        confidence = analysis.trackingConfidence;
        detectedBestStreak = analysis.bestStreak;
        leftTouches = analysis.leftTouches;
        rightTouches = analysis.rightTouches;
      } catch {
        setAnalysisError("Analysis was unavailable. Check that the local vision service is running.");
      }
    } else if (!visionApiUrl) {
      setAnalysisError("Automatic analysis needs a local vision-service address.");
    }

    const session: TrainingSession = {
      id: "session-" + Date.now(),
      createdAt: (sessionStart ?? new Date()).toISOString(),
      durationSeconds,
      cameraMode,
      touches: detectedTouches,
      totalTouches: detectedTouches.length,
      bestStreak: detectedBestStreak,
      leftTouches,
      rightTouches,
      trackingConfidence: confidence,
      correctionDelta: 0
    };
    setCompletedSession(session);
    setIsAnalyzing(false);
    setScreen("results");
  };

  const saveSession = () => {
    if (!completedSession) return;
    const corrected = {
      ...completedSession,
      totalTouches: Math.max(0, completedSession.totalTouches + adjustment),
      correctionDelta: adjustment
    };
    setHistory((items) => [corrected, ...items]);
    setCompletedSession(corrected);
    setScreen("home");
  };

  const totalThisWeek = history.slice(0, 7).reduce((sum, item) => sum + item.totalTouches, 0);
  const latest = history[0];
  const recommendation: DrillRecommendation | null = completedSession
    ? recommendDrill({ ...completedSession, totalTouches: Math.max(0, completedSession.totalTouches + adjustment) }, history)
    : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {screen === "home" && (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.brandRow}>
            <View>
              <Text style={styles.eyebrow}>BALL CONTROL COACH</Text>
              <Text style={styles.title}>Own every touch.</Text>
            </View>
            <View style={styles.avatar}><Text style={styles.avatarText}>NC</Text></View>
          </View>

          <View style={styles.heroCard}>
            <Text style={styles.heroKicker}>THIS WEEK</Text>
            <Text style={styles.heroNumber}>{totalThisWeek}</Text>
            <Text style={styles.heroLabel}>tracked touches</Text>
            <View style={styles.heroRule} />
            <Text style={styles.heroNote}>Your best streak is building. One short session today keeps the rhythm going.</Text>
          </View>

          <Text style={styles.sectionTitle}>Ready to train?</Text>
          {cameraDenied && (
            <View style={styles.permissionCard}>
              <Text style={styles.permissionTitle}>Camera access is needed</Text>
              <Text style={styles.permissionText}>Allow camera access in iPhone Settings to use the live training view.</Text>
            </View>
          )}
          <View style={styles.modeRow}>
            <Pressable onPress={() => setCameraMode("tripod")} style={[styles.modeOption, cameraMode === "tripod" && styles.modeActive]}>
              <Text style={styles.modeIcon}>▣</Text>
              <Text style={styles.modeTitle}>Tripod</Text>
              <Text style={styles.modeText}>Best accuracy</Text>
            </Pressable>
            <Pressable onPress={() => setCameraMode("handheld")} style={[styles.modeOption, cameraMode === "handheld" && styles.modeActive]}>
              <Text style={styles.modeIcon}>◉</Text>
              <Text style={styles.modeTitle}>Handheld</Text>
              <Text style={styles.modeText}>Quick setup</Text>
            </Pressable>
          </View>
          <AppButton label="Start juggling session" onPress={beginSession} />

          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>Last session</Text>
            <Pressable onPress={() => setScreen("progress")}><Text style={styles.link}>See progress</Text></Pressable>
          </View>
          <View style={styles.lastSession}>
            <Metric value={latest.totalTouches} label="touches" highlight />
            <Metric value={latest.bestStreak} label="best streak" />
            <Metric value={latest.leftTouches + " / " + latest.rightTouches} label="L / R" />
          </View>
        </ScrollView>
      )}

      {screen === "training" && (
        <View style={styles.trainingPage}>
          <View style={styles.trainingHeader}>
            <Pressable onPress={() => setScreen("home")}><Text style={styles.close}>×</Text></Pressable>
            <View><Text style={styles.live}>● LIVE SESSION</Text><Text style={styles.timer}>{formatTime(elapsed)}</Text></View>
            <Text style={styles.confidence}>{isRecording ? "REC" : "ON"}<Text style={styles.confidenceSub}> camera</Text></Text>
          </View>

          <View style={styles.cameraFrame}>
            <CameraView
              active
              autofocus="on"
              facing={cameraMode === "tripod" ? "back" : "front"}
              onCameraReady={() => setCameraReady(true)}
              ref={cameraRef}
              style={styles.cameraPreview}
            />
            <View pointerEvents="none" style={styles.gridLineHorizontal} />
            <View pointerEvents="none" style={styles.gridLineVertical} />
            <View pointerEvents="none" style={styles.cameraGuidance}>
              <Text style={styles.frameText}>Keep ball + ankles in frame</Text>
              <Text style={styles.frameSub}>{isRecording ? "Recording for automatic analysis" : "Preparing camera"}</Text>
            </View>
          </View>

          <View style={styles.liveCount}>
            <Text style={styles.countNumber}>{touches.length}</Text>
            <Text style={styles.countLabel}>TOUCHES</Text>
            <Text style={styles.streakText}>Current streak: {currentStreak(touches)} · Best: {bestStreak(touches)}</Text>
          </View>

          <View style={styles.manualCard}>
            <Text style={styles.manualTitle}>{isRecording ? "Recording session" : "Camera preview"}</Text>
            <Text style={styles.manualText}>{isRecording ? "Keep the ball and both ankles visible. Finish when your round is complete." : "Once you can see the live preview, tap Start recording when you are positioned and ready."}</Text>
          </View>
          {isRecording ? (
            <AppButton label={isAnalyzing ? "Analyzing session…" : "Finish & analyze"} onPress={finishSession} />
          ) : (
            <AppButton label="Start recording" onPress={startRecording} />
          )}
        </View>
      )}

      {screen === "results" && completedSession && recommendation && (
        <ScrollView contentContainerStyle={styles.page}>
          <Text style={styles.eyebrow}>SESSION COMPLETE</Text>
          <Text style={styles.title}>Nice work.</Text>
          <Text style={styles.subtitle}>Your result is ready to review.</Text>

          {analysisError && <View style={styles.analysisWarning}><Text style={styles.analysisWarningText}>{analysisError}</Text></View>}
          <View style={styles.resultHero}>
            <Text style={styles.resultNumber}>{Math.max(0, completedSession.totalTouches + adjustment)}</Text>
            <Text style={styles.resultLabel}>TOTAL TOUCHES</Text>
            <Text style={styles.resultStreak}>Best streak: {completedSession.bestStreak}</Text>
          </View>

          <View style={styles.metricsRow}>
            <Metric value={completedSession.leftTouches} label="left foot" />
            <Metric value={completedSession.rightTouches} label="right foot" />
            <Metric value={Math.round(completedSession.trackingConfidence * 100) + "%"} label="confidence" />
          </View>

          <View style={styles.correctionCard}>
            <View><Text style={styles.correctionTitle}>Does the total look right?</Text><Text style={styles.correctionText}>You can correct the count before saving.</Text></View>
            <View style={styles.stepper}>
              <Pressable onPress={() => setAdjustment((value) => value - 1)} style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
              <Text style={styles.stepValue}>{adjustment > 0 ? "+" + adjustment : adjustment}</Text>
              <Pressable onPress={() => setAdjustment((value) => value + 1)} style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
            </View>
          </View>

          <View style={styles.drillCard}>
            <Text style={styles.drillKicker}>YOUR NEXT DRILL</Text>
            <Text style={styles.drillTitle}>{recommendation.title}</Text>
            <Text style={styles.drillFocus}>{recommendation.focus} · {recommendation.duration}</Text>
            <Text style={styles.drillCue}>{recommendation.cue}</Text>
            <Text style={styles.drillReason}>{recommendation.reason}</Text>
          </View>

          <AppButton label="Save session" onPress={saveSession} />
          <AppButton label="Discard" kind="ghost" onPress={() => setScreen("home")} />
        </ScrollView>
      )}

      {screen === "progress" && (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.sectionRow}>
            <View><Text style={styles.eyebrow}>YOUR PROGRESS</Text><Text style={styles.title}>Momentum.</Text></View>
            <Pressable onPress={() => setScreen("home")}><Text style={styles.link}>Done</Text></Pressable>
          </View>

          <View style={styles.progressCard}>
            <Text style={styles.progressCaption}>TOUCHES PER SESSION</Text>
            <View style={styles.chart}>
              {history.slice(0, 5).reverse().map((item) => (
                <View key={item.id} style={styles.chartColumn}>
                  <View style={[styles.bar, { height: Math.max(24, Math.min(144, item.totalTouches * 3)) }]} />
                  <Text style={styles.barLabel}>{item.totalTouches}</Text>
                </View>
              ))}
            </View>
          </View>

          <Text style={styles.sectionTitle}>Recent sessions</Text>
          {history.slice(0, 5).map((item) => (
            <View style={styles.historyRow} key={item.id}>
              <View><Text style={styles.historyTitle}>{item.cameraMode === "tripod" ? "Tripod" : "Handheld"} juggling</Text><Text style={styles.historySub}>{new Date(item.createdAt).toLocaleDateString()} · {formatTime(item.durationSeconds)}</Text></View>
              <View style={styles.historyMetric}><Text style={styles.historyNumber}>{item.totalTouches}</Text><Text style={styles.historySub}>touches</Text></View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#08120F" },
  page: { padding: 22, paddingBottom: 38, gap: 18 },
  trainingPage: { flex: 1, padding: 22, gap: 16 },
  eyebrow: { color: "#78F7B2", letterSpacing: 1.6, fontSize: 11, fontWeight: "800" },
  title: { color: "#F4FFF8", fontSize: 38, lineHeight: 44, fontWeight: "800", letterSpacing: -1.3 },
  subtitle: { color: "#A7B9B0", fontSize: 16, marginTop: -10 },
  brandRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 8 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#D5FF61", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#08120F", fontWeight: "900" },
  heroCard: { backgroundColor: "#D5FF61", padding: 24, borderRadius: 24, marginTop: 4 },
  heroKicker: { color: "#386142", fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  heroNumber: { color: "#08120F", fontSize: 64, fontWeight: "900", lineHeight: 68, marginTop: 4 },
  heroLabel: { color: "#284C34", fontSize: 16, fontWeight: "700" },
  heroRule: { height: 1, backgroundColor: "#88AD30", marginVertical: 16 },
  heroNote: { color: "#24452F", lineHeight: 20, fontSize: 14 },
  sectionTitle: { color: "#F4FFF8", fontSize: 20, fontWeight: "800" },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  link: { color: "#78F7B2", fontWeight: "700" },
  permissionCard: { backgroundColor: "#3B2B10", borderWidth: 1, borderColor: "#8E6C25", borderRadius: 16, padding: 14 },
  permissionTitle: { color: "#FFE19A", fontWeight: "800" },
  permissionText: { color: "#E3C982", fontSize: 12, lineHeight: 17, marginTop: 4 },
  modeRow: { flexDirection: "row", gap: 12 },
  modeOption: { flex: 1, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: "#284339", backgroundColor: "#0D1B16" },
  modeActive: { borderColor: "#78F7B2", backgroundColor: "#113124" },
  modeIcon: { color: "#78F7B2", fontSize: 22, marginBottom: 8 },
  modeTitle: { color: "#F4FFF8", fontWeight: "800", fontSize: 16 },
  modeText: { color: "#8FA39A", fontSize: 12, marginTop: 3 },
  button: { borderRadius: 16, paddingVertical: 17, alignItems: "center", justifyContent: "center" },
  button_primary: { backgroundColor: "#78F7B2" },
  button_secondary: { backgroundColor: "#183329", borderWidth: 1, borderColor: "#315A49", flex: 1 },
  button_ghost: { backgroundColor: "transparent", paddingVertical: 11 },
  buttonText: { fontWeight: "800", fontSize: 16 },
  buttonText_primary: { color: "#082015" },
  buttonText_secondary: { color: "#B8F9D1" },
  buttonText_ghost: { color: "#8FA39A" },
  lastSession: { backgroundColor: "#0D1B16", padding: 16, borderRadius: 18, flexDirection: "row", justifyContent: "space-between" },
  metric: { alignItems: "center", flex: 1 },
  metricHighlight: { borderRightWidth: 1, borderRightColor: "#284339" },
  metricValue: { color: "#F4FFF8", fontSize: 22, fontWeight: "900" },
  metricValueHighlight: { color: "#78F7B2" },
  metricLabel: { color: "#8FA39A", fontSize: 11, marginTop: 4, textAlign: "center" },
  trainingHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 6 },
  close: { color: "#F4FFF8", fontSize: 34, lineHeight: 34 },
  live: { color: "#78F7B2", fontWeight: "900", fontSize: 11, letterSpacing: 1.2, textAlign: "center" },
  timer: { color: "#F4FFF8", fontSize: 28, fontWeight: "800", textAlign: "center" },
  confidence: { color: "#F4FFF8", fontWeight: "800", textAlign: "right" },
  confidenceSub: { color: "#8FA39A", fontWeight: "500", fontSize: 11 },
  cameraFrame: { flex: 1, minHeight: 290, backgroundColor: "#12281F", borderRadius: 24, overflow: "hidden", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#315A49" },
  cameraPreview: { ...StyleSheet.absoluteFill },
  cameraGuidance: { position: "absolute", top: 18, left: 18, right: 18, backgroundColor: "rgba(8, 18, 15, 0.72)", borderRadius: 12, padding: 12 },
  gridLineHorizontal: { position: "absolute", width: "100%", height: 1, backgroundColor: "#315A49" },
  gridLineVertical: { position: "absolute", height: "100%", width: 1, backgroundColor: "#315A49" },
  frameText: { color: "#C2D9CE", fontWeight: "800", fontSize: 16 },
  frameSub: { color: "#85A496", fontSize: 12, marginTop: 7 },
  liveCount: { alignItems: "center", marginTop: -2 },
  countNumber: { color: "#F4FFF8", fontSize: 48, fontWeight: "900", lineHeight: 50 },
  countLabel: { color: "#78F7B2", fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  streakText: { color: "#A7B9B0", marginTop: 5 },
  manualCard: { backgroundColor: "#0D1B16", borderRadius: 18, padding: 16 },
  manualTitle: { color: "#F4FFF8", fontWeight: "800" },
  manualText: { color: "#8FA39A", fontSize: 12, lineHeight: 17, marginTop: 4 },
  touchButtons: { flexDirection: "row", gap: 10, marginTop: 13 },
  analysisWarning: { backgroundColor: "#3B2B10", borderWidth: 1, borderColor: "#8E6C25", borderRadius: 14, padding: 13 },
  analysisWarningText: { color: "#FFE19A", fontSize: 12, lineHeight: 17 },
  resultHero: { backgroundColor: "#13382A", borderRadius: 24, padding: 26, alignItems: "center" },
  resultNumber: { color: "#D5FF61", fontSize: 72, fontWeight: "900", lineHeight: 76 },
  resultLabel: { color: "#B8F9D1", letterSpacing: 1.4, fontSize: 11, fontWeight: "900" },
  resultStreak: { color: "#A7B9B0", marginTop: 10 },
  metricsRow: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#0D1B16", padding: 16, borderRadius: 18 },
  correctionCard: { backgroundColor: "#0D1B16", padding: 16, borderRadius: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  correctionTitle: { color: "#F4FFF8", fontWeight: "800" },
  correctionText: { color: "#8FA39A", fontSize: 12, marginTop: 3, maxWidth: 200 },
  stepper: { flexDirection: "row", gap: 11, alignItems: "center" },
  step: { width: 31, height: 31, borderRadius: 16, backgroundColor: "#234335", alignItems: "center", justifyContent: "center" },
  stepText: { color: "#B8F9D1", fontSize: 21, fontWeight: "700" },
  stepValue: { color: "#F4FFF8", minWidth: 25, textAlign: "center", fontWeight: "800" },
  drillCard: { borderRadius: 24, padding: 22, backgroundColor: "#D5FF61" },
  drillKicker: { color: "#386142", fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  drillTitle: { color: "#082015", fontSize: 25, fontWeight: "900", marginTop: 8 },
  drillFocus: { color: "#284C34", fontWeight: "700", marginTop: 4 },
  drillCue: { color: "#183C28", lineHeight: 20, marginTop: 16 },
  drillReason: { color: "#386142", fontSize: 12, lineHeight: 17, marginTop: 12 },
  progressCard: { backgroundColor: "#0D1B16", padding: 19, borderRadius: 22 },
  progressCaption: { color: "#8FA39A", fontSize: 10, letterSpacing: 1.3, fontWeight: "800" },
  chart: { height: 175, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-around", paddingTop: 20 },
  chartColumn: { alignItems: "center", justifyContent: "flex-end", gap: 7, height: "100%" },
  bar: { width: 30, backgroundColor: "#78F7B2", borderRadius: 9 },
  barLabel: { color: "#B8F9D1", fontSize: 11, fontWeight: "800" },
  historyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#0D1B16", padding: 16, borderRadius: 17 },
  historyTitle: { color: "#F4FFF8", fontWeight: "800" },
  historySub: { color: "#8FA39A", fontSize: 12, marginTop: 4 },
  historyMetric: { alignItems: "flex-end" },
  historyNumber: { color: "#78F7B2", fontWeight: "900", fontSize: 22 }
});