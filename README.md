# Ball Control Coach

An iPhone-first React Native prototype for individual soccer juggling practice.

## What is working

- Home dashboard with camera-mode selection
- Live training flow with timer, touch count, current streak, and best streak
- Session results with left/right-foot usage and a count-correction control
- Rule-based next-drill recommendations
- Progress history and a touches-per-session chart
- A typed vision adapter boundary ready for the native iOS camera pipeline

The current touch buttons are intentionally a development adapter. They make the complete product flow testable before the on-device vision module is integrated.

## Run locally

```bash
npm install
npm run start
```

Open the iOS simulator with `npm run ios`, or scan the Expo QR code with Expo Go.

## Native vision integration

Replace `ManualVisionAdapter` in `src/vision.ts` with an iOS module that:

1. Streams camera frames after calibration.
2. Uses MediaPipe for pose/ankle landmarks and a Core ML YOLO model for ball detection.
3. Tracks ball-to-foot contact across frames with temporal debouncing.
4. Emits classified left/right touch events and a tracking confidence score.

Video is designed to stay on-device. The future Supabase layer should persist only session metrics and touch events.

## Next milestones

1. Add `expo-camera` and the iOS vision module.
2. Add Supabase Auth, RLS policies, and cloud-synced history.
3. Build a labelled juggling-video evaluation suite before enabling automatic scoring.
