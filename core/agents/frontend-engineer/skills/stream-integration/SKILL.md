---
name: stream-integration
description: Integrate live or replayed media streams with visible failure states.
triggers: [stream, mjpeg, video, camera, playback]
always: false
---

# Stream Integration

Define connect, reconnect, timeout, stale-frame, and disconnected behavior. Never silently replace a failed live source with mock data. Surface latency and source status to the user.
