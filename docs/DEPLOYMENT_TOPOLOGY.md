# ReJivan — Camera Ingestion Architecture & Deployment Topology

> **Executive Overview for Technical & Clinical Evaluators**  
> Competition: *Hack for Social Cause 2027 (VBYLD 2027, MoYAS + IIT Bombay)*  
> Region Anchor: *Andaman & Nicobar Islands (UT) — Homes at Junglighat/Little Andaman; Virtual Ward at GB Pant Hospital, Port Blair*  
> Document Version: `2.4.0` · Updated: `2026-09-17`

---

## 1. System Architecture Overview

ReJivan separates physical video ingestion from cloud alerting by deploying an **On-Premises Edge Sentinel Node**. Whether processing physical IP surveillance cameras, local caregiver webcams, or clinical verification video, **all video frames are decoded, analyzed, and discarded in volatile edge RAM**. Zero raw video ever leaves the hospital or residential premises.

```mermaid
flowchart TD
    subgraph SOURCELAYER["1. Interchangeable Ingestion Sources"]
        SRC_RTSP["🏥 Hospital RTSP CCTV / NVR<br/>(H.264/H.265 RTSP Stream)"]
        SRC_WEBCAM["📹 Caregiver USB/Built-in Webcam<br/>(DirectShow Hardware)"]
        SRC_VIRTUAL["🎥 Virtual Camera Source<br/>(Prerecorded Clinical Video)"]
    end

    subgraph EDGELAYER["2. On-Premises Edge Sentinel Node (CUDA GPU / CPU)"]
        NORM["Frame / Timestamp Normalization<br/>(NormalizedFrame Contract)"]
        ISOLATION["TrackingContext Isolation<br/>(Per-Camera Kinematic State)"]
        POSE["YOLO11-Pose Inference<br/>(17 COCO Keypoints @ 25-30 FPS)"]
        KINE["Temporal Feature Extraction<br/>(Torso Angle θ, Descent Velocity dy/dt)"]
        HYPO["Hypothesis & Counterfactual Engine<br/>(9 Competing Physical States)"]
        RECOV["Recovery Detection Engine<br/>(Upright Restoration & Immobility)"]
        HEALTH["System Infrastructure Watchdog<br/>(7-Tier Status Hierarchy)"]
    end

    subgraph CLOUDLAYER["3. ReJivan Cloud / Vercel Clinical Portal"]
        CANONICAL["Canonical Event Store<br/>(Schema v2.1.0 Idempotent Events)"]
        PILLARS["3-Pillar UI Telemetry<br/>(Edge Status · Camera Status · Patient Status)"]
        CHECKIN["Resident Verification Workflow<br/>(Are You Okay? Modal & Ladder)"]
        DASH["Virtual Ward Nurse Dashboard<br/>(NEWS2 Vitals + Vision Sentinel)"]
    end

    SRC_RTSP -->|LAN RTSP 554| NORM
    SRC_WEBCAM -->|DirectShow| NORM
    SRC_VIRTUAL -->|Sequential Decoded Frames| NORM

    NORM --> ISOLATION
    ISOLATION --> POSE
    POSE --> KINE
    KINE --> HYPO
    HYPO --> RECOV
    RECOV -->|Structured Telemetry Only| CANONICAL
    HEALTH -->|Lightweight Heartbeat (3s)| PILLARS
    CANONICAL --> CHECKIN
    CANONICAL --> DASH
```

---

## 2. Interchangeable Camera Sources & The Unified Pipeline

ReJivan eliminates custom "demo-only" fall logic. All three sources feed the **identical downstream inference and event reconstruction engine**:

$$\text{Camera Source} \longrightarrow \text{NormalizedFrame} \longrightarrow \text{YOLO11-Pose} \longrightarrow \text{TrackingContext} \longrightarrow \text{Hypothesis Engine} \longrightarrow \text{Verification} \longrightarrow \text{Response}$$

### Source Implementations

| Source Type | Physical Medium | Timestamp Generation | Ideal Usage |
| :--- | :--- | :--- | :--- |
| **`LOCAL_WEBCAM`** | DirectShow USB / Integrated Camera | Monotonic Wall-Clock ($t_{wall}$) | Low-cost home monitoring, laptop evaluations, caregiver rooms. |
| **`RTSP_CCTV`** | IP Camera / ONVIF NVR (H.264 RTSP) | Monotonic Arrival Time ($t_{arrival}$) | Hospital wards, ICU perimeters, nursing home hallways. |
| **`PRERECORDED_VIDEO`**| Clinical Demonstration MP4 File | Sequential Timeline ($t_{video} = \frac{frame\_idx}{fps}$) | Competition evaluations, automated unit testing, clinical replays. |

### The `NormalizedFrame` Interface
Every source converts frames into this unified dataclass before inference:
```python
@dataclass
class NormalizedFrame:
    frame: np.ndarray          # BGR image matrix (discarded after keypoint extraction)
    timestamp: float           # Monotonic timeline timestamp (seconds)
    frame_index: int           # Sequential frame counter
    source_id: str             # e.g. "cam-rtsp-ward-01"
    source_type: str           # "LOCAL_WEBCAM" | "RTSP_CCTV" | "PRERECORDED_VIDEO"
    width: int                 # Pixel width (e.g. 1280)
    height: int                # Pixel height (e.g. 720)
    metadata: Dict[str, Any]   # Source-specific health telemetry (fps, drop count, latency)
```

---

## 3. Production Deployment Topology (Hospital & Virtual Ward)

In a real hospital (such as GB Pant Hospital in Port Blair), ReJivan interfaces with existing IP surveillance cameras without replacing hospital CCTV infrastructure:

```
[Ward 302 IP Dome Camera]  ──(RTSP/H.264 over LAN)──┐
[Ward 303 IP Bullet Camera] ──(RTSP/H.264 over LAN)──┼──> [ReJivan Edge Gateway]
[Ward 304 IP PTZ Camera]   ──(RTSP/H.264 over LAN)──┘     (CUDA GPU or Jetson Orin)
                                                                    │
                                                                    │ Local YOLO-Pose Inference
                                                                    │ Kinematics & Hypothesis Engine
                                                                    │ Zero Video Upload
                                                                    ▼
                                                            [Structured Telemetry JSON]
                                                                    │
                                                    HTTPS Long-Poll / WebSockets (<2 KB/s)
                                                                    ▼
                                                        [ReJivan Clinical Portal]
                                                          (Nurse Station & Cloud)
```

### Key Production Engineering Safeguards
1. **Zero Raw Video Off-Premises (DPDP Act 2023):** Raw video streams never traverse external networks. Only lightweight structured events (e.g. `{"state": "CONTACT_OR_FALL", "torsoAngle": 64.0, "confidence": 94}`) are transmitted.
2. **Strict Credential Masking:** Passwords in RTSP URLs are masked immediately upon ingestion (`rtsp://admin:*****@192.168.1.50:554/live/ch0`). Unmasked credentials never appear in API responses, browser DOMs, or log files.
3. **TrackingContext Isolation:** In multi-camera deployments, each camera retains an isolated kinematic memory (`prev_com_y`, `smooth_velocity`, `consecutive_valid_frames`, `fall_latched`). Camera 1's activity can never leak into Camera 2.
4. **Timestamp Gap & Jitter Protection:** Network packet drops exceeding $350\text{ ms}$ automatically invalidate velocity derivatives ($dy/dt$), preventing synthetic acceleration spikes from being classified as falls.
5. **Bounded Reconnect & Safe Reconnect Boundary:** If an RTSP stream drops, the edge node attempts 5 bounded reconnects with exponential backoff. Upon successful reconnect, the tracking context is **cleanly reset**, ensuring that resident position jumps across the offline window never trigger false alerts.

---

## 4. Competition & Zero-Budget Demonstration Paths

ReJivan was engineered to accommodate diverse presentation constraints without compromising technical integrity:

### Path A: Zero-Budget Laptop / Terminal-Free Evaluator Path
- **Target:** Judges accessing `rejivan2.vercel.app` on their own laptops/smartphones.
- **Mechanism:** Click **"🎥 Pre-Recorded Hospital Demo"** in the Camera Zones portal.
- **Execution:** The browser executes optical motion vector differencing, 7 temporal stages, 3 distinct confidences, and the resident verification dialog with **zero terminal commands or local software required**.

### Path B: Dedicated Edge Hardware Acceleration Path
- **Target:** Local laptop with an NVIDIA CUDA GPU (auto-detected by PyTorch; falls back to CPU if none is present). Current development machine: NVIDIA GeForce RTX 4060 Laptop GPU (8GB VRAM).
- **Mechanism:** Run `Start-ReJivan.bat` or `python tools/yolo_edge_sentinel.py`.
- **Execution:** Ultralytics YOLO11-Pose runs locally at 25–30 FPS on CUDA. The web dashboard auto-discovers port `5050` and visualizes genuine 17-point skeletal wireframes and on-demand DPDP privacy radar.

### Path C: Hospital NVR / IP Camera Ingestion Path
- **Target:** Commercial hospital deployment.
- **Mechanism:** Open **Manage Cameras** in the UI and enter the ward RTSP URL (`rtsp://user:pass@hospital-lan/stream`).
- **Execution:** Edge node validates RTSP negotiation, measures stream latency, verifies frame receipt, and binds stream to the active resident's Virtual Ward bed.

---

## 5. Three-Pillar Telemetry Decoupling

A critical failure of naive vision systems is conflating camera connection drops with patient emergencies. ReJivan enforces strict architectural separation between **Technical Infrastructure Health** and **Clinical Patient Health**:

```mermaid
graph LR
    subgraph PILLAR1["Pillar 1: EDGE STATUS"]
        E1["Edge Node Health"]
        E2["GPU CUDA VRAM"]
        E3["Process Heartbeat (3s)"]
    end

    subgraph PILLAR2["Pillar 2: CAMERA STATUS"]
        C1["Stream Lifecycle (ONLINE / RECONNECTING)"]
        C2["Delivery Frame Rate (FPS)"]
        C3["Timestamp Gaps & Reconnect Count"]
    end

    subgraph PILLAR3["Pillar 3: PATIENT STATUS"]
        P1["17-Point COCO Skeletal Pose"]
        P2["Torso Angle θ (0° Upright - 90° Flat)"]
        P3["Hypothesis: INTENTIONAL_LYING vs FALL"]
    end

    PILLAR1 -.->|Decoupled| PILLAR3
    PILLAR2 -.->|Decoupled| PILLAR3
```

> [!IMPORTANT]
> **Safety Invariance:** If a physical camera is disconnected, an RTSP socket resets, or the edge sentinel restarts, **Patient Status remains SAFE**. The dashboard updates `Vision Monitoring: DEGRADED — Camera reconnecting`, but emergency call ladders and alarm bells are never falsely triggered.
