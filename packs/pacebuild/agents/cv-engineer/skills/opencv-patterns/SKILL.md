---
name: opencv-patterns
description: Guidelines for drawing bounding boxes, labels, and tracking overlays on video frames.
triggers:
  - opencv drawing
  - draw bbox
  - overlay text
  - frame rendering
always: false
---

# OpenCV Overlays Skill

This skill contains drawing guidelines for cv-engine rendering annotated MJPEG stream feeds.

## Drawing Principles
- Use standard OpenCV call `cv2.rectangle` with integer pixel scales (convert normalized float coordinates if needed).
- Font choices: use `cv2.FONT_HERSHEY_SIMPLEX` with thickness `2` and scale `0.5` for clear visibility.
- Color code categories:
  - **Worker (Person):** Blue (`cv2.rectangle(..., (255, 0, 0), 2)`)
  - **Vehicle (Truck/Excavator):** Orange (`cv2.rectangle(..., (0, 165, 255), 2)`)
- Always render the `track_id` next to the class name: e.g., `Worker #12 (88%)`.
- Avoid drawing overlapping text. Offsets labels slightly above or below the bounding boxes.
