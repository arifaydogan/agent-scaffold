---
name: yolo-bytetrack
description: Guidelines for YOLOv8 model loading, ByteTrack tracking configuration, and hyperparameter tuning.
triggers:
  - yolo
  - bytetrack
  - tracker setup
  - tracking hyperparameter
always: false
---

# YOLO & ByteTrack Configuration Skill

This skill provides guidelines for running object tracking stable enough for construction yards.

## Model Ingestion
- Load YOLO model weights using `YOLO("model_name.pt")` and ensure it runs on GPU if available (`device=0`).
- Ensure tracking runs in a separate background thread or worker queue to avoid blocking main processes.

## ByteTrack Tuning for Construction
- **High Threshold (`track_high_thresh`):** Default `0.5` or `0.6`. High confidence detections are matched first.
- **Low Threshold (`track_low_thresh`):** Set to `0.1` or `0.2` to match occluded workers or dusty vehicles.
- **Buffer (`track_buffer`):** Default `30` (frames). At 30 FPS, keeps tracking active for 1 second of occlusion. Increase to `60` or `90` if workers frequently go behind pillars.
- **Match Threshold (`match_thresh`):** Set to `0.7` or `0.8` to prevent ID switching in close proximity.
