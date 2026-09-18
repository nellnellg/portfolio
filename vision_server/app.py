"""Local-only soccer touch analysis service.

Run on the same Wi-Fi network as the phone:
  python -m pip install -r vision_server/requirements.txt
  uvicorn vision_server.app:app --host 0.0.0.0 --port 8000

The uploaded clip is processed in a temporary directory and deleted before
the response is returned. This is a prototype; validate against labelled clips
before trusting scores for coaching decisions.
"""
from __future__ import annotations

import math
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

app = FastAPI(title="Ball Control Coach Vision API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Local-development server; restrict before deployment.
    allow_methods=["POST"],
    allow_headers=["*"],
)

BALL_CLASS_ID = 32  # COCO sports ball
TARGET_FPS = 15.0
MIN_EVENT_GAP_SECONDS = 0.18
STREAK_GAP_SECONDS = 2.2

model = YOLO("yolo11n.pt")
pose = mp.solutions.pose.Pose(
    static_image_mode=False,
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)


@dataclass
class Detection:
    time_seconds: float
    center: tuple[float, float]
    radius: float
    left_foot: tuple[float, float] | None
    right_foot: tuple[float, float] | None
    confidence: float


def point_distance(first: tuple[float, float], second: tuple[float, float]) -> float:
    return math.hypot(first[0] - second[0], first[1] - second[1])


def best_streak(events: list[dict]) -> int:
    if not events:
        return 0
    running = 1
    best = 1
    for current, previous in zip(events[1:], events[:-1]):
        running = running + 1 if current["atSeconds"] - previous["atSeconds"] <= STREAK_GAP_SECONDS else 1
        best = max(best, running)
    return best


def extract_feet(frame: np.ndarray) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    height, width = frame.shape[:2]
    result = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    if not result.pose_landmarks:
        return None, None

    landmarks = result.pose_landmarks.landmark
    # Use the ankle/foot-index midpoint to give a more stable contact location.
    def foot(ankle_index: int, toe_index: int) -> tuple[float, float]:
        ankle = landmarks[ankle_index]
        toe = landmarks[toe_index]
        return ((ankle.x + toe.x) * width / 2, (ankle.y + toe.y) * height / 2)

    return foot(27, 31), foot(28, 32)


def detect_ball(frame: np.ndarray) -> tuple[tuple[float, float], float, float] | None:
    result = model.predict(frame, classes=[BALL_CLASS_ID], conf=0.2, verbose=False)[0]
    if result.boxes is None or len(result.boxes) == 0:
        return None

    boxes = result.boxes
    best_index = int(np.argmax(boxes.conf.cpu().numpy()))
    x1, y1, x2, y2 = boxes.xyxy[best_index].cpu().numpy().tolist()
    confidence = float(boxes.conf[best_index].item())
    return ((x1 + x2) / 2, (y1 + y2) / 2), max(x2 - x1, y2 - y1) / 2, confidence


def classify_contacts(detections: list[Detection]) -> list[dict]:
    events: list[dict] = []
    last_event_time = -MIN_EVENT_GAP_SECONDS
    prior_vertical_velocity: float | None = None

    for previous, current in zip(detections, detections[1:]):
        delta_time = current.time_seconds - previous.time_seconds
        if delta_time <= 0:
            continue

        vertical_velocity = (current.center[1] - previous.center[1]) / delta_time
        # Image y increases downwards: a foot contact usually reverses falling
        # ball movement (positive) into upward movement (negative).
        direction_reversed = prior_vertical_velocity is not None and prior_vertical_velocity > 18 and vertical_velocity < -18
        prior_vertical_velocity = vertical_velocity
        if not direction_reversed or current.time_seconds - last_event_time < MIN_EVENT_GAP_SECONDS:
            continue

        candidates: list[tuple[Literal["left", "right"], float]] = []
        for foot_name, foot in (("left", current.left_foot), ("right", current.right_foot)):
            if foot is None:
                continue
            distance = point_distance(current.center, foot)
            contact_radius = max(42.0, current.radius * 3.8)
            if distance <= contact_radius:
                candidates.append((foot_name, distance / contact_radius))

        if not candidates:
            continue

        foot_name, normalized_distance = min(candidates, key=lambda item: item[1])
        confidence = round(max(0.3, min(0.99, current.confidence * (1 - normalized_distance * 0.35))), 2)
        events.append({
            "id": f"touch-{len(events) + 1}",
            "atSeconds": round(current.time_seconds, 2),
            "foot": foot_name,
            "confidence": confidence,
        })
        last_event_time = current.time_seconds

    return events


def analyze_video(video_path: Path) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("The uploaded file could not be opened as video.")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    stride = max(1, round(source_fps / TARGET_FPS))
    frame_index = 0
    detections: list[Detection] = []
    sampled_frames = 0
    frames_with_ball = 0
    frames_with_feet = 0

    while True:
        success, frame = capture.read()
        if not success:
            break
        if frame_index % stride != 0:
            frame_index += 1
            continue

        sampled_frames += 1
        timestamp = frame_index / source_fps
        ball = detect_ball(frame)
        left_foot, right_foot = extract_feet(frame)
        if left_foot or right_foot:
            frames_with_feet += 1
        if ball:
            center, radius, confidence = ball
            frames_with_ball += 1
            detections.append(Detection(timestamp, center, radius, left_foot, right_foot, confidence))
        frame_index += 1

    capture.release()
    if sampled_frames == 0:
        raise ValueError("The video contained no readable frames.")

    events = classify_contacts(detections)
    left_touches = sum(event["foot"] == "left" for event in events)
    right_touches = sum(event["foot"] == "right" for event in events)
    duration = frame_index / source_fps
    coverage = min(frames_with_ball, frames_with_feet) / sampled_frames
    mean_ball_confidence = float(np.mean([item.confidence for item in detections])) if detections else 0.0
    tracking_confidence = round(min(0.99, coverage * 0.7 + mean_ball_confidence * 0.3), 2)

    return {
        "durationSeconds": round(duration, 1),
        "totalTouches": len(events),
        "bestStreak": best_streak(events),
        "leftTouches": left_touches,
        "rightTouches": right_touches,
        "trackingConfidence": tracking_confidence,
        "touches": events,
        "diagnostics": {
            "sampledFrames": sampled_frames,
            "ballCoverage": round(frames_with_ball / sampled_frames, 2),
            "feetCoverage": round(frames_with_feet / sampled_frames, 2),
        },
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(video: UploadFile = File(...)) -> dict:
    if not (video.content_type or "").startswith("video/"):
        raise HTTPException(status_code=415, detail="Upload a video file.")

    temporary_directory = Path(tempfile.mkdtemp(prefix="ball-control-"))
    video_path = temporary_directory / "session.mov"
    try:
        with video_path.open("wb") as destination:
            shutil.copyfileobj(video.file, destination)
        return analyze_video(video_path)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await video.close()
        shutil.rmtree(temporary_directory, ignore_errors=True)
