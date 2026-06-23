# CV Engineer Rules

Specific operational constraints and guidelines for the CV Engineer agent.

## Operational Constraints
- **Config Existence Check:** Never reference `bytetrack.yaml` or any other config file in your tracking calls without first verifying it exists in the workspace filesystem.
- **Detections Normalization:** Normalize bounding boxes to `[0.0, 1.0]` float arrays before transmitting to the Backend endpoint. Draw overlays using raw integer pixel coordinates.
- **Track Persistence:** Ensure `persist=True` is explicitly passed in `model.track()` calls to prevent overcounting and ID resets across video frames.
- **Deduplication IDs:** Generate determinstic `frame_id` hashes using `camera_id` and frame metrics to support backend deduplication.
