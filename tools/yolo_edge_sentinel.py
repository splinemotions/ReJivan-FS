# tools/yolo_edge_sentinel.py
# ReJivan Real Edge Sentinel Daemon
# Powered by Ultralytics YOLO-Pose on System Hardware (NVIDIA CUDA GPU when available, else CPU Pipeline)
# Unified Camera-Ingestion Architecture: LOCAL_WEBCAM, RTSP_CCTV, and PRERECORDED_VIDEO
# All sources feed the exact same downstream pose inference, temporal kinematics, and event reconstruction.

import sys
import os
import time
import json
import math
import base64
import socket
import threading
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import numpy as np

# Configure UTF-8 encoding for standard output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Verify dependencies
try:
    import cv2
except ImportError:
    print("[ERROR] OpenCV not found. Please install: pip install opencv-python")
    sys.exit(1)

try:
    import torch
    from ultralytics import YOLO
except ImportError:
    print("[ERROR] Ultralytics/PyTorch not found. Please install: pip install ultralytics torch")
    sys.exit(1)

# Import Camera Provider Abstraction & Data Models
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from camera_providers import (
    CameraLifecycleState,
    CameraSourceType,
    FrameHealthMetrics,
    NormalizedFrame,
    TrackingContext,
    CameraSource,
    LocalWebcamSource,
    RtspCctvSource,
    PrerecordedVideoSource,
    EdgeNode,
    mask_rtsp_url,
    validate_rtsp_url,
    DEFAULT_CALIBRATION_FRAMES
)

print("=" * 76)
print("   ReJivan Real Edge Sentinel Daemon - Ultralytics YOLO-Pose")
print("   Unified Camera Ingestion Architecture: WEBCAM | RTSP CCTV | VIRTUAL VIDEO")
print("   Hardware Platform: Auto-detected NVIDIA CUDA GPU (or Optimized CPU Pipeline)")
print("=" * 76)

# --- Single-instance guard ---------------------------------------------------
# Checked BEFORE the ~20s model load so a duplicate launch fails fast.
# Two sentinels sharing port 5050 break the live camera stream on Windows
# (see SingleInstanceHTTPServer below for the full explanation).
EDGE_PORT = int(os.environ.get("REJIVAN_EDGE_PORT", "5050"))


def _edge_port_in_use(port):
    """True if something is already accepting connections on 127.0.0.1:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1.0)
        return probe.connect_ex(("127.0.0.1", port)) == 0


# Only enforced when this file is RUN as the daemon. The test suites import this
# module (from yolo_edge_sentinel import compute_kinematics, hub) and must keep
# working even while a daemon is already serving on 5050.
if __name__ == "__main__" and _edge_port_in_use(EDGE_PORT):
    print("")
    print(f"[!] Port {EDGE_PORT} is ALREADY IN USE.")
    print("[!] Another ReJivan Edge Sentinel is most likely still running.")
    print("[!] Refusing to start a second instance - two daemons on one port")
    print("[!] split the camera stream and make it freeze after the first frame.")
    print("")
    print("[*] Stop the other instance first:")
    print("[*]     tools\\stop_yolo.bat")
    print("[*] ...or close the window that is running yolo_edge_sentinel.py.")
    print("")
    sys.exit(1)

# Hardware & Model Configuration
CUDA_AVAILABLE = torch.cuda.is_available()
GPU_NAME = torch.cuda.get_device_name(0) if CUDA_AVAILABLE else "System CPU (Intel/AMD)"
DEVICE_TARGET = "cuda" if CUDA_AVAILABLE else "cpu"
MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "yolo11n-pose.pt")
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = "yolo11n-pose.pt"

print(f"[*] Compute Device: {GPU_NAME} (CUDA: {CUDA_AVAILABLE})")
print(f"[*] Model Path: {MODEL_PATH}")

# Load YOLO11-pose model
print("[*] Initializing Ultralytics YOLO-Pose model...")
try:
    yolo_model = YOLO(MODEL_PATH)
    # Warmup inference on blank frame
    dummy_warmup = np.zeros((320, 320, 3), dtype=np.uint8)
    yolo_model(dummy_warmup, imgsz=320, verbose=False, device=DEVICE_TARGET)
    print(f"[+] YOLO model loaded and warmed up successfully on {DEVICE_TARGET.upper()}!")
except Exception as e:
    print(f"[!] Warmup on {DEVICE_TARGET} failed: {e}. Falling back to CPU...")
    DEVICE_TARGET = "cpu"
    yolo_model = YOLO(MODEL_PATH)
    dummy_warmup = np.zeros((320, 320, 3), dtype=np.uint8)
    yolo_model(dummy_warmup, imgsz=320, verbose=False, device="cpu")
    print("[+] YOLO model loaded on CPU.")

# COCO 17 Pose Skeleton Connections
SKELETON_PAIRS = [
    (0, 1), (0, 2), (1, 3), (2, 4),        # Facial features
    (5, 6),                                  # Shoulders
    (5, 7), (7, 9),                          # Left arm
    (6, 8), (8, 10),                         # Right arm
    (11, 12),                                # Hips
    (5, 11), (6, 12),                        # Torso spine
    (11, 13), (13, 15),                      # Left leg
    (12, 14), (14, 16)                       # Right leg
]

KEYPOINT_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle"
]

# Thread-safe global inference mutex
inference_lock = threading.Lock()

class SentinelHub:
    """
    Central coordinator managing EdgeNode, active camera selection,
    and serving MJPEG / JSON telemetry.
    """
    def __init__(self):
        self.lock = threading.Lock()
        self.running = True
        self.camera_active = False # On-demand hardware lifecycle (Camera OFF by default)
        self.active_streamers = 0  # Active MJPEG client count
        self.camera_index = 0
        self.source = "PRERECORDED_VIDEO" # "PRERECORDED_VIDEO", "LIVE_WEBCAM", "RTSP_CAMERA"
        self.camera_source_type = "PRERECORDED_VIDEO"
        self.playback_state = "STOPPED"   # "STOPPED", "CALIBRATING", "PLAYING", "PAUSED", "VIDEO_ENDED"
        self.playback_speed = 1.0         # 0.5, 1.0, 2.0
        self.video_frame_index = 0
        self.video_total_frames = 369
        self.video_fps = 25.0
        self.video_time = 0.0
        self.video_duration = 14.76
        self.floor_contact_time = None
        self.timeline_stage = "STAGE_RESTING"

        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.demo_video_path = os.path.join(repo_root, "video", "patient_bed_fall_demo.mp4")
        if not os.path.exists(self.demo_video_path):
            self.demo_video_path = os.path.join(repo_root, "prototype", "public", "videos", "patient_bed_fall_demo.mp4")

        self.latest_raw_frame = None
        self.latest_rendered_frame = None
        self.latest_radar_frame = None
        self.fps = 0.0
        self.last_seen = time.time()
        self.last_inference_latency = 0.015
        self.new_frame_event = threading.Event()

        # Camera Lifecycle Management (Default context)
        self.camera_state = "CAMERA_OFFLINE"
        self.calibration_frames_left = 0
        self.CALIBRATION_FRAMES_REQUIRED = DEFAULT_CALIBRATION_FRAMES

        # Kinematic Tracking History (Global fallback for test compatibility)
        self.consecutive_valid_frames = 0
        self.prev_com_y = None
        self.prev_time = None
        self.smooth_velocity = 0.0
        self.recent_drop_time = 0.0
        self.recent_drop_velocity = 0.0

        # High-Risk Latch & Recovery
        self.fall_latched = False
        self.fall_latch_start_time = 0.0
        self.last_high_risk_time = 0.0
        self.immobility_start_time = None

        # ---------------------------------------------------------------------
        # EdgeNode & Camera Ingestion Providers
        # ---------------------------------------------------------------------
        self.edge_node = EdgeNode(
            edge_id="edge-node-an-01",
            name="ReJivan GB Pant Hospital Edge Sentinel",
            host_identifier=socket.gethostname(),
            software_version="2.4.0-edge"
        )

        # 1A. Local Phone / Mobile Connected Camera (Index 0)
        self.webcam_source = LocalWebcamSource(
            camera_id="cam-webcam-01",
            camera_name="Connected Phone / Mobile Camera (Index 0)",
            device_index=0,
            zone="Home Living Room",
            resident_id="P1",
            resolution=(640, 480),
            target_fps=30.0
        )

        # 1B. Integrated Laptop HD Webcam (Index 1)
        self.laptop_webcam_source = LocalWebcamSource(
            camera_id="cam-webcam-02",
            camera_name="Integrated Laptop HD Webcam (Index 1)",
            device_index=1,
            zone="Home Living Room",
            resident_id="P1",
            resolution=(1280, 720),
            target_fps=30.0
        )

        # 2. Production RTSP CCTV Source (Configurable via REJIVAN_RTSP_URL env var)
        default_rtsp = os.environ.get("REJIVAN_RTSP_URL", "rtsp://admin:ward123@192.168.1.120:554/stream1")
        self.rtsp_source = RtspCctvSource(
            camera_id="cam-rtsp-ward-01",
            camera_name="GB Pant Virtual Ward · Bed 1 CCTV",
            rtsp_url=default_rtsp,
            zone="GB Pant Hospital · Virtual Ward Bed 1",
            resident_id="P3",
            bed_id="BED1",
            resolution=(1280, 720),
            target_fps=25.0
        )

        # 3. Pre-recorded Demonstration Virtual Camera Source
        self.demo_source = PrerecordedVideoSource(
            camera_id="cam-prerecorded-demo",
            camera_name="GB Pant Ward 3 - Bed-Fall Clinical Demo Video",
            video_path=self.demo_video_path,
            zone="GB Pant Hospital · Virtual Ward Bed 1",
            resident_id="P3",
            bed_id="BED1",
            target_fps=25.0
        )

        self.edge_node.register_camera(self.webcam_source)
        self.edge_node.register_camera(self.laptop_webcam_source)
        self.edge_node.register_camera(self.rtsp_source)
        self.edge_node.register_camera(self.demo_source)
        self.edge_node.set_active_camera("cam-prerecorded-demo")

        # Telemetry State (Privacy-First Default: Hardware Powered Off)
        self.telemetry = {
            "status": "STANDBY_AWAITING_CONSENT",
            "camera_state": "CAMERA_OFFLINE",
            "camera_source_type": "PRERECORDED_VIDEO",
            "camera_id": "cam-prerecorded-demo",
            "edge_id": self.edge_node.edge_id,
            "playback_state": "STOPPED",
            "playback_speed": 1.0,
            "video_time": 0.0,
            "video_duration": 14.76,
            "timeline_stage": "STAGE_RESTING",
            "device": GPU_NAME,
            "cuda_enabled": CUDA_AVAILABLE,
            "engine": "Ultralytics YOLO11-Pose",
            "source": "PRERECORDED_VIDEO",
            "fps": 0.0,
            "person_detected": False,
            "persons_count": 0,
            "keypoints": [],
            "bbox": None,
            "torso_angle": 0.0,
            "downward_velocity": 0.0,
            "motion_energy": 0.0,
            "posture": "Hardware Standby (Camera Offline · Privacy Safe)",
            "risk_level": "SAFE",
            "confidence": 100.0,
            "hypothesis": {
                "id": "H0",
                "label": "Camera Standby",
                "mechanism": "Camera monitoring uninitialized."
            },
            "canonical_event": {
                "eventId": "EVT-STANDBY",
                "state": "NORMAL",
                "probableMechanism": "NORMAL_ACTIVITY",
                "detectionConfidence": 0,
                "mechanismConfidence": 100,
                "severityConfidence": 0,
                "recoveryStatus": "NOT_APPLICABLE",
                "evidence": [],
                "counterEvidence": ["Camera in standby mode"]
            },
            "timestamp": time.time()
        }

    @property
    def cap(self):
        active = self.edge_node.get_active_camera()
        return getattr(active, "cap", None) if active else None

    @cap.setter
    def cap(self, val):
        pass

    def reset_tracking_state(self):
        """Cleanly resets all temporal history, velocity, floor contact, and latches."""
        self.consecutive_valid_frames = 0
        self.prev_com_y = None
        self.prev_time = None
        self.smooth_velocity = 0.0
        self.recent_drop_time = 0.0
        self.recent_drop_velocity = 0.0
        self.fall_latched = False
        self.fall_latch_start_time = 0.0
        self.last_high_risk_time = 0.0
        self.immobility_start_time = None
        self.floor_contact_time = None
        self.calibration_frames_left = 25
        self.timeline_stage = "STAGE_RESTING"

        if hasattr(self, "edge_node") and self.edge_node:
            active = self.edge_node.get_active_camera()
            if active:
                active.reset_tracking()

hub = SentinelHub()

def compute_kinematics(
    keypoints,
    img_w,
    img_h,
    current_time,
    source=None,
    tracking_context=None,
    camera_id=None,
    edge_id=None
):
    """
    Computes genuine physical biomechanics from COCO 17 keypoints:
    - Torso Angle theta (0 upright to 90 horizontal)
    - Center of Mass (CoM) vertical position and velocity
    - Camera Calibration & Track Acquisition Safety
    - Multi-Hypothesis & Counterfactual Evaluation
    - Recovery Detection (<24 deg upright equilibrium)
    Operates on the provided tracking_context (or defaults to hub for backwards compatibility).
    """
    ctx = tracking_context if tracking_context is not None else hub
    # Normalize keypoints to [x, y, conf] safely handling NumPy ndarrays
    kp = []
    if keypoints is not None:
        if isinstance(keypoints, np.ndarray):
            raw_kp = keypoints.tolist()
        else:
            raw_kp = keypoints
        for item in raw_kp:
            if isinstance(item, dict):
                kp.append([float(item.get("x", 0)), float(item.get("y", 0)), float(item.get("conf", item.get("confidence", 0.0)))])
            elif isinstance(item, (list, tuple)):
                kp.append([float(v) for v in item])
            elif hasattr(item, "tolist"):
                kp.append([float(v) for v in item.tolist()])
            else:
                kp.append([0.0, 0.0, 0.0])
    if ctx.calibration_frames_left > 0:
        ctx.calibration_frames_left -= 1
        ctx.consecutive_valid_frames += 1
        return {
            "person_detected": True,
            "torso_angle": 12.0,
            "downward_velocity": 0.0,
            "posture": f"Calibrating Spatial Baseline ({ctx.calibration_frames_left} frames left)...",
            "risk_level": "SAFE",
            "confidence": 99.0,
            "hypothesis": {
                "id": "H0",
                "label": "Sensor Calibration Phase",
                "mechanism": "Establishing spatial reference and ambient lighting baseline. Alert triggers inhibited."
            },
            "canonical_event": {
                "eventId": f"EVT-CALIB-{int(current_time)}",
                "cameraId": camera_id or getattr(ctx, "camera_id", "cam-default"),
                "edgeId": edge_id or "edge-node-an-01",
                "sourceType": source or getattr(ctx, "source", "PRERECORDED_VIDEO"),
                "state": "NORMAL",
                "probableMechanism": "NORMAL_ACTIVITY",
                "detectionConfidence": 5,
                "mechanismConfidence": 98,
                "severityConfidence": 0,
                "recoveryStatus": "NOT_APPLICABLE",
                "evidence": [f"Calibration frame {DEFAULT_CALIBRATION_FRAMES - ctx.calibration_frames_left}/{DEFAULT_CALIBRATION_FRAMES}"],
                "counterEvidence": ["Camera startup calibration active"]
            }
        }

    # 2. Keypoint Availability Checks (Confidence threshold 0.25)
    def is_valid(idx):
        return idx < len(kp) and len(kp[idx]) >= 3 and kp[idx][2] > 0.25

    has_shoulders = is_valid(5) and is_valid(6)
    has_hips = is_valid(11) and is_valid(12)
    has_head = is_valid(0)

    # 3. Center of Mass & Spine Vector Calculations
    if has_shoulders and has_hips:
        sh_mid_x = (kp[5][0] + kp[6][0]) / 2.0
        sh_mid_y = (kp[5][1] + kp[6][1]) / 2.0
        hip_mid_x = (kp[11][0] + kp[12][0]) / 2.0
        hip_mid_y = (kp[11][1] + kp[12][1]) / 2.0

        com_x = (sh_mid_x + hip_mid_x) / 2.0
        com_y = (sh_mid_y + hip_mid_y) / 2.0

        dx_sh = abs(kp[5][0] - kp[6][0])
        dy_sh = abs(kp[5][1] - kp[6][1]) + 1e-5
        shoulder_tilt_deg = math.degrees(math.atan2(dy_sh, max(dx_sh, 1.0)))

        dx = abs(sh_mid_x - hip_mid_x)
        dy = abs(sh_mid_y - hip_mid_y) + 1e-5
        torso_angle_hips = math.degrees(math.atan2(dx, dy))
        torso_angle_deg = round(max(torso_angle_hips, shoulder_tilt_deg * 0.8), 1)
    elif has_shoulders:
        sh_mid_x = (kp[5][0] + kp[6][0]) / 2.0
        sh_mid_y = (kp[5][1] + kp[6][1]) / 2.0
        com_x = sh_mid_x
        com_y = sh_mid_y

        dx_sh = abs(kp[5][0] - kp[6][0])
        dy_sh = abs(kp[5][1] - kp[6][1]) + 1e-5
        shoulder_tilt_deg = math.degrees(math.atan2(dy_sh, dx_sh))

        head_tilt_deg = 0.0
        if has_head:
            dx_h = abs(kp[0][0] - sh_mid_x)
            dy_h = sh_mid_y - kp[0][1] # Upright head is above shoulders (dy_h > 0)
            if dy_h > 12.0:
                head_tilt_deg = math.degrees(math.atan2(dx_h, dy_h))
            else:
                # Head dropped level with or below shoulders
                head_tilt_deg = 45.0 + min(35.0, abs(dy_h) * 1.5)

        torso_angle_deg = round(max(shoulder_tilt_deg, head_tilt_deg * 0.8), 1)
    else:
        com_x = kp[0][0]
        com_y = kp[0][1]
        torso_angle_deg = 15.0

    torso_angle_deg = min(90.0, max(0.0, torso_angle_deg))

    # 4. Track Continuity, Motion Energy & Vertical Velocity Calculation
    # Guard against track acquisition spikes and temporal gaps
    time_since_prev = (current_time - ctx.prev_time) if ctx.prev_time is not None else 999.0
    src = source or "webcam"
    is_browser_frame = (src in ["browser_frame", "LIVE_WEBCAM", "webcam_browser"])
    max_gap = 1.2 if is_browser_frame else 0.45
    min_valid_frames = 2 if is_browser_frame else 4

    # Dynamic Keypoint Motion Energy Calculation (0% - 100%)
    motion_energy = 6
    if hasattr(ctx, "prev_kp") and ctx.prev_kp is not None:
        total_disp = 0.0
        kp_count = 0
        for i in range(min(len(kp), len(ctx.prev_kp))):
            if kp[i][2] > 0.25 and ctx.prev_kp[i][2] > 0.25:
                dx_k = kp[i][0] - ctx.prev_kp[i][0]
                dy_k = kp[i][1] - ctx.prev_kp[i][1]
                total_disp += math.hypot(dx_k, dy_k)
                kp_count += 1
        if kp_count > 0:
            avg_disp = total_disp / kp_count
            dt_motion = max(0.015, min(0.35, time_since_prev if time_since_prev < 900.0 else 0.04))
            motion_speed = (avg_disp / max(img_h, 1)) / dt_motion
            # Scale so normal conversational gesture ~ 25-45%, rapid descent ~ 80-100%
            motion_energy = min(100, max(4, int(motion_speed * 420)))
    ctx.prev_kp = np.array(kp, copy=True)

    if ctx.prev_com_y is None or time_since_prev > max_gap or time_since_prev <= 0.001:
        ctx.consecutive_valid_frames = 1
        ctx.smooth_velocity = 0.0
        velocity_down = 0.0
    else:
        ctx.consecutive_valid_frames += 1
        if ctx.consecutive_valid_frames < min_valid_frames:
            ctx.smooth_velocity = 0.0
            velocity_down = 0.0
        else:
            dt = max(min(time_since_prev, 0.25), 0.015)
            dy_pixels = com_y - ctx.prev_com_y
            # Discard extreme optical teleports (>65% of screen in one frame)
            if abs(dy_pixels) > (img_h * 0.65):
                dy_pixels = 0.0
            instant_vel = (dy_pixels / img_h) / dt * 2.2
            ctx.smooth_velocity = 0.50 * instant_vel + 0.50 * ctx.smooth_velocity
            velocity_down = round(ctx.smooth_velocity, 2)

            if velocity_down > 0.65:
                ctx.recent_drop_time = current_time
                ctx.recent_drop_velocity = velocity_down

    ctx.prev_com_y = com_y
    ctx.prev_time = current_time

    # 5. Physical Mechanism Classification & Multi-Hypothesis Evaluation
    is_recent_drop = (current_time - ctx.recent_drop_time) < 2.0
    src = source or "webcam"
    is_overhead = (src in ["PRERECORDED_VIDEO", "bed_fall_demo", "RTSP_CAMERA", "RTSP_CCTV"])

    if is_overhead:
        is_on_floor = com_y > (img_h * 0.62)
        is_in_bed = com_y <= (img_h * 0.55)
    else:
        is_on_floor = has_hips and (com_y > img_h * 0.82)
        is_in_bed = False

    # Check for recovery (<24 deg restores equilibrium)
    is_recovered = False
    if (ctx.floor_contact_time is not None or ctx.fall_latched):
        if torso_angle_deg < 24.0 and velocity_down < 0.25:
            ctx.floor_contact_time = None
            ctx.fall_latched = False
            is_recovered = True

    # Floor stillness tracking
    floor_stillness = 0.0
    if is_on_floor and torso_angle_deg > 45.0:
        if ctx.floor_contact_time is None:
            ctx.floor_contact_time = current_time
        floor_stillness = max(0.0, current_time - ctx.floor_contact_time)
        ctx.fall_latched = True
        ctx.last_high_risk_time = current_time
    elif not is_on_floor and torso_angle_deg < 35.0:
        ctx.floor_contact_time = None

    # Check for genuine fall trigger
    fall_active = (velocity_down > 0.85 and torso_angle_deg > 40.0)
    fall_post_drop = is_recent_drop and (torso_angle_deg > 50.0 or is_on_floor)
    is_fall = fall_active or fall_post_drop or (is_on_floor and torso_angle_deg > 45.0)

    if is_fall and not ctx.fall_latched:
        ctx.fall_latched = True
        ctx.fall_latch_start_time = current_time
        ctx.last_high_risk_time = current_time

    # 6. Final State & Hypothesis Determination
    if is_recovered:
        risk_level = "SAFE"
        event_state = "RESOLVED"
        probable_mechanism = "TRIP"
        posture = "Upright Recovery (Incident Self-Resolved)"
        stage = "STAGE_RESOLVED"
        hypothesis = {
            "id": "H0",
            "label": "Postural Recovery Restored",
            "mechanism": f"Resident stood back up or restored vertical equilibrium ({torso_angle_deg}°). Acute emergency self-resolved."
        }
        det_conf = 70
        mech_conf = 85
        sev_conf = 10
        evidence = ["Upright posture restored (<24°)", "Locomotion resumed"]
        counter_evidence = ["Rapid recovery observed (<4s)", "Zero lingering floor immobility"]
        recovery_status = "RECOVERED_RAPID"
    elif ctx.floor_contact_time is not None and floor_stillness >= 2.5:
        risk_level = "HIGH_RISK"
        event_state = "VERIFICATION"
        probable_mechanism = "FALL_WITH_IMMOBILITY"
        posture = f"Unrecovered Floor Immobility ({floor_stillness:.1f}s) · Resident Check-in Active"
        stage = "STAGE_VERIFY"
        hypothesis = {
            "id": "H7",
            "label": "Fall with Prolonged Post-Impact Immobility",
            "mechanism": f"Rapid descent ({max(velocity_down, ctx.recent_drop_velocity)} m/s) followed by {floor_stillness:.1f}s immobility at {torso_angle_deg}° on floor."
        }
        det_conf = 97
        mech_conf = 94
        sev_conf = 88
        evidence = [
            f"Descent velocity: {max(velocity_down, ctx.recent_drop_velocity)} m/s",
            f"Torso horizontal on floor: {torso_angle_deg}°",
            f"Floor immobility: {floor_stillness:.1f}s"
        ]
        counter_evidence = ["Zero upright postural recovery observed (<24°)", "Resident check-in grace window open"]
        recovery_status = "UNRECOVERED_STILLNESS"
    elif ctx.fall_latched or (is_on_floor and torso_angle_deg > 45.0):
        risk_level = "HIGH_RISK"
        event_state = "CONTACT_OR_FALL" if floor_stillness < 1.0 else "RECOVERY_MONITORING"
        probable_mechanism = "FALL"
        posture = f"Acute Fall / Horizontal Floor Contact ({floor_stillness:.1f}s)"
        stage = "STAGE_CONTACT" if floor_stillness < 1.0 else "STAGE_RECOVERY"
        hypothesis = {
            "id": "H1",
            "label": "Sudden Fall Event Detected",
            "mechanism": f"Rapid descent ({max(velocity_down, ctx.recent_drop_velocity)} m/s) with impact collapse at {torso_angle_deg}°."
        }
        det_conf = 95
        mech_conf = 88
        sev_conf = 75
        evidence = [
            f"Descent velocity: {max(velocity_down, ctx.recent_drop_velocity)} m/s",
            f"Torso angle: {torso_angle_deg}°",
            "Body collapsed onto floor perimeter"
        ]
        counter_evidence = ["Recovery observation window active (<3s)"]
        recovery_status = "MONITORING"
    elif velocity_down > 0.25 and torso_angle_deg <= 30.0 and not is_on_floor:
        # Controlled descent: intentional sitting transfer
        risk_level = "SAFE"
        event_state = "NORMAL"
        probable_mechanism = "INTENTIONAL_SITTING"
        posture = "Controlled Sitting / Intentional Descent"
        stage = "STAGE_BED_EDGE"
        hypothesis = {
            "id": "H2",
            "label": "Controlled Sitting",
            "mechanism": f"Controlled descent ({velocity_down} m/s) with upright spine ({torso_angle_deg}°). Muscular deceleration intact."
        }
        det_conf = 30
        mech_conf = 95
        sev_conf = 0
        evidence = ["Muscular deceleration intact", f"Spine vertical ({torso_angle_deg}°)", "Zero floor impact shock"]
        counter_evidence = ["Intentional sitting trajectory"]
        recovery_status = "NOT_APPLICABLE"
    elif velocity_down > 0.65 and not is_on_floor:
        risk_level = "CAUTION"
        event_state = "ANOMALY"
        probable_mechanism = "LOSS_OF_BALANCE"
        posture = f"Descent Motion Toward Floor ({velocity_down} m/s)"
        stage = "STAGE_DESCENT"
        hypothesis = {
            "id": "H3",
            "label": "Descent Motion / Loss of Balance",
            "mechanism": f"Downward descent velocity at {velocity_down} m/s. Torso inclination at {torso_angle_deg}°."
        }
        det_conf = 65
        mech_conf = 70
        sev_conf = 30
        evidence = [f"Downward descent velocity: {velocity_down} m/s", "Displacement toward floor boundary"]
        counter_evidence = ["Floor impact pending confirmation", "Upright recovery possible"]
        recovery_status = "MONITORING"
    elif is_in_bed and torso_angle_deg <= 25.0:
        risk_level = "SAFE"
        event_state = "NORMAL"
        probable_mechanism = "INTENTIONAL_SITTING"
        posture = "Upright Bed-Edge Sitting (Spine Stable)"
        stage = "STAGE_BED_EDGE"
        hypothesis = {
            "id": "H2",
            "label": "Controlled Bed-Edge Sitting",
            "mechanism": f"Patient seated upright on mattress perimeter (Torso {torso_angle_deg}°). Muscular deceleration intact."
        }
        det_conf = 15
        mech_conf = 95
        sev_conf = 0
        evidence = ["Patient seated upright at mattress perimeter", "Upright spinal stability retained (<35°)"]
        counter_evidence = ["Muscular deceleration intact", "Zero floor impact shock"]
        recovery_status = "NOT_APPLICABLE"
    elif is_in_bed and torso_angle_deg > 35.0:
        risk_level = "SAFE"
        event_state = "NORMAL"
        probable_mechanism = "INTENTIONAL_LYING"
        posture = "Supine Resting in Bed (Nominal)"
        stage = "STAGE_RESTING"
        hypothesis = {
            "id": "H0",
            "label": "Resting Safely in Care Bed",
            "mechanism": "Patient in supine resting posture within mattress perimeter. Zero downward velocity."
        }
        det_conf = 5
        mech_conf = 96
        sev_conf = 0
        evidence = ["Mattress perimeter proximity", "Zero downward velocity"]
        counter_evidence = ["Supine bed rest intentional", "Stable vitals baseline"]
        recovery_status = "NOT_APPLICABLE"
    elif torso_angle_deg > 32.0 or velocity_down > 0.40:
        risk_level = "CAUTION"
        event_state = "ANOMALY"
        probable_mechanism = "LOSS_OF_BALANCE"
        posture = "Low Posture / Transitioning"
        stage = "STAGE_DESCENT"
        hypothesis = {
            "id": "H3",
            "label": "Postural Transition / Mild Sway",
            "mechanism": f"Torso inclination at {torso_angle_deg}° (Descent: {velocity_down} m/s). Monitoring stability."
        }
        det_conf = 55
        mech_conf = 60
        sev_conf = 25
        evidence = [f"Torso inclination: {torso_angle_deg}°"]
        counter_evidence = ["Descent velocity within non-emergency range", "Person actively moving"]
        recovery_status = "MONITORING"
    else:
        risk_level = "SAFE"
        event_state = "NORMAL"
        probable_mechanism = "NORMAL_ACTIVITY"
        posture = "Upright Ambulation / Nominal"
        stage = "STAGE_RESTING"
        hypothesis = {
            "id": "H0",
            "label": "Stable Upright Posture",
            "mechanism": f"Upright equilibrium maintained (Torso {torso_angle_deg}°). Biomechanics nominal."
        }
        det_conf = 5
        mech_conf = 98
        sev_conf = 0
        evidence = [f"Upright posture: {torso_angle_deg}°", "Nominal biomechanics"]
        counter_evidence = ["Zero downward acceleration", "Continuous equilibrium"]
        recovery_status = "NOT_APPLICABLE"

    ctx.timeline_stage = stage
    if ctx is not hub:
        hub.timeline_stage = stage

    canonical_event = {
        "eventId": f"EVT-{source or getattr(ctx, 'source_type', 'CAM')}-{int(current_time * 1000)}",
        "cameraId": camera_id or getattr(ctx, "camera_id", "cam-default"),
        "edgeId": edge_id or "edge-node-an-01",
        "sourceType": source or getattr(ctx, "source_type", "PRERECORDED_VIDEO"),
        "state": event_state,
        "probableMechanism": probable_mechanism,
        "stage": stage,
        "timelineStage": stage,
        "detectionConfidence": det_conf,
        "mechanismConfidence": mech_conf,
        "severityConfidence": sev_conf,
        "recoveryStatus": recovery_status,
        "evidence": evidence,
        "counterEvidence": counter_evidence,
        "timestamp": current_time
    }

    return {
        "person_detected": True,
        "torso_angle": torso_angle_deg,
        "downward_velocity": -velocity_down,
        "motion_energy_percent": motion_energy,
        "posture": posture,
        "risk_level": risk_level,
        "confidence": mech_conf,
        "hypothesis": hypothesis,
        "canonical_event": canonical_event,
        "stage": stage,
        "timeline_stage": stage,
        "detection_confidence": det_conf,
        "mechanism_confidence": mech_conf,
        "severity_confidence": sev_conf,
        "evidence": evidence,
        "counter_evidence": counter_evidence
    }

def draw_pose_overlays(frame, results, kinematics, privacy_mode=False):
    """
    Renders skeletal vectors, keypoints, and targeting brackets.
    In Privacy Mode, renders over dark navy radar grid (DPDP Act compliance).
    """
    h, w = frame.shape[:2]

    if privacy_mode:
        canvas = np.full((h, w, 3), (18, 13, 9), dtype=np.uint8) # Dark clinical navy
        grid_step = 40
        for x in range(0, w, grid_step):
            cv2.line(canvas, (x, 0), (x, h), (38, 29, 20), 1)
        for y in range(0, h, grid_step):
            cv2.line(canvas, (0, y), (w, y), (38, 29, 20), 1)
    else:
        canvas = frame.copy()

    if not results or len(results[0].boxes) == 0:
        cv2.putText(canvas, "Prajna Vision Sentinel: Scanning Perimeter...", (20, 35),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (140, 140, 140), 1, cv2.LINE_AA)
        return canvas

    r = results[0]
    is_danger = kinematics.get("risk_level") == "HIGH_RISK"
    is_caution = kinematics.get("risk_level") == "CAUTION"

    if is_danger:
        accent_color = (94, 63, 244)   # Rose Red
        joint_color = (120, 100, 255)
    elif is_caution:
        accent_color = (50, 190, 245)   # Amber/Yellow
        joint_color = (80, 210, 255)
    else:
        accent_color = (129, 185, 16)   # Emerald Green
        joint_color = (180, 220, 50)

    boxes = r.boxes.xyxy.cpu().numpy()
    kpts_list = r.keypoints.data.cpu().numpy() if r.keypoints is not None else []

    for i, (box, kp) in enumerate(zip(boxes, kpts_list)):
        bx1, by1, bx2, by2 = map(int, box[:4])
        bw, bh = bx2 - bx1, by2 - by1

        # Corner brackets on primary person
        if i == 0:
            corner_len = max(14, int(min(bw, bh) * 0.18))
            thick = 2
            # Top-left
            cv2.line(canvas, (bx1, by1), (bx1 + corner_len, by1), accent_color, thick, cv2.LINE_AA)
            cv2.line(canvas, (bx1, by1), (bx1, by1 + corner_len), accent_color, thick, cv2.LINE_AA)
            # Top-right
            cv2.line(canvas, (bx2, by1), (bx2 - corner_len, by1), accent_color, thick, cv2.LINE_AA)
            cv2.line(canvas, (bx2, by1), (bx2, by1 + corner_len), accent_color, thick, cv2.LINE_AA)
            # Bottom-left
            cv2.line(canvas, (bx1, by2), (bx1 + corner_len, by2), accent_color, thick, cv2.LINE_AA)
            cv2.line(canvas, (bx1, by2), (bx1, by2 - corner_len), accent_color, thick, cv2.LINE_AA)
            # Bottom-right
            cv2.line(canvas, (bx2, by2), (bx2 - corner_len, by2), accent_color, thick, cv2.LINE_AA)
            cv2.line(canvas, (bx2, by2), (bx2, by2 - corner_len), accent_color, thick, cv2.LINE_AA)

        # Draw COCO skeletal bones
        for p1_idx, p2_idx in SKELETON_PAIRS:
            if p1_idx < len(kp) and p2_idx < len(kp):
                pt1, pt2 = kp[p1_idx], kp[p2_idx]
                if pt1[2] > 0.25 and pt2[2] > 0.25:
                    cv2.line(canvas, (int(pt1[0]), int(pt1[1])),
                             (int(pt2[0]), int(pt2[1])), accent_color, 2, cv2.LINE_AA)

        # Draw joint nodes
        for k_idx, pt in enumerate(kp):
            if pt[2] > 0.25:
                kx, ky = pt[0], pt[1]
                radius = 3 if k_idx > 4 else 2
                cv2.circle(canvas, (int(kx), int(ky)), radius, joint_color, -1, cv2.LINE_AA)

    # Top Telemetry HUD Strip
    cv2.rectangle(canvas, (0, 0), (w, 45), (10, 10, 10), -1)
    status_text = f"YOLO11-Pose | {kinematics.get('posture', 'Active')} | {hub.fps:.1f} FPS"
    risk_text = f"RISK: {kinematics.get('risk_level', 'SAFE')} (Torso: {kinematics.get('torso_angle', 0)} deg)"
    cv2.putText(canvas, status_text, (15, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (230, 230, 230), 1, cv2.LINE_AA)
    cv2.putText(canvas, risk_text, (15, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.44, accent_color, 1, cv2.LINE_AA)

    return canvas

def camera_processing_thread():
    """
    Continuous background worker reading from the active CameraSource on EdgeNode.
    Maintains on-demand privacy, paces playback for virtual video, and updates telemetry.
    """
    print("[*] Unified Camera Ingestion Worker initialized (Interchangeable Sources: WEBCAM, RTSP, PRERECORDED).")
    active_camera: Optional[CameraSource] = None
    frame_counter = 0

    while hub.running:
        with hub.lock:
            should_run = bool(hub.camera_active or hub.active_streamers > 0)
            target_camera = hub.edge_node.get_active_camera()

        if not should_run:
            if active_camera is not None:
                print(f"[*] Privacy Gate: Zero active stream clients. Releasing camera {active_camera.camera_id}...")
                active_camera.release()
                active_camera = None
                with hub.lock:
                    hub.fps = 0.0
                    hub.latest_rendered_frame = None
                    hub.latest_radar_frame = None
                    hub.telemetry.update({
                        "status": "STANDBY_AWAITING_CONSENT",
                        "fps": 0.0,
                        "person_detected": False,
                        "persons_count": 0,
                        "posture": "Hardware Standby (Camera Released · Privacy Safe)",
                        "risk_level": "SAFE",
                        "confidence": 100.0,
                        "hypothesis": {
                            "id": "H0",
                            "label": "Camera Standby",
                            "mechanism": "Camera monitoring idle. Privacy safe."
                        }
                    })
            time.sleep(0.1)
            continue

        # Check if active camera selection changed dynamically
        if active_camera is not None and active_camera.camera_id != (target_camera.camera_id if target_camera else None):
            print(f"[*] Switching active camera from {active_camera.camera_id} to {target_camera.camera_id}...")
            active_camera.release()
            active_camera = None

        active_camera = target_camera
        if active_camera is None:
            time.sleep(0.1)
            continue

        # Open camera on-demand if not already open
        if active_camera.lifecycle_state in [CameraLifecycleState.OFFLINE, CameraLifecycleState.STOPPED]:
            success = active_camera.open()
            if not success:
                with hub.lock:
                    hub.telemetry["status"] = "CAMERA_UNAVAILABLE"
                    hub.camera_state = active_camera.lifecycle_state
                time.sleep(0.5)
                continue

        # Read normalized frame from current camera source
        frame_read_start = time.time()
        norm_frame = active_camera.read_frame()

        if norm_frame is None:
            state = active_camera.lifecycle_state
            if state == CameraLifecycleState.VIDEO_ENDED:
                with hub.lock:
                    hub.playback_state = "VIDEO_ENDED"
                    hub.camera_state = "VIDEO_ENDED"
                    hub.telemetry.update({
                        "status": "VIDEO_ENDED",
                        "camera_state": "VIDEO_ENDED",
                        "playback_state": "VIDEO_ENDED",
                        "event_state": "MONITORING_IDLE",
                        "posture": "Demonstration Concluded (Monitoring Idle)",
                        "risk_level": "SAFE",
                        "timeline_stage": "STAGE_RESOLVED",
                        "stage": "STAGE_RESOLVED"
                    })
                time.sleep(0.04)
                continue
            elif state == CameraLifecycleState.RECONNECTING:
                with hub.lock:
                    hub.camera_state = "RECONNECTING"
                    hub.telemetry.update({
                        "status": "CAMERA_RECONNECTING",
                        "camera_state": "RECONNECTING",
                        "posture": "Camera Reconnecting (Infrastructure Recovery)",
                        "risk_level": "SAFE" # NEVER trigger false patient emergency!
                    })
                time.sleep(0.05)
                continue
            elif state == CameraLifecycleState.OFFLINE:
                with hub.lock:
                    hub.camera_state = "OFFLINE"
                    hub.telemetry.update({
                        "status": "CAMERA_OFFLINE",
                        "camera_state": "OFFLINE",
                        "risk_level": "SAFE"
                    })
                time.sleep(0.2)
                continue
            time.sleep(0.02)
            continue

        # Frame pacing for prerecorded video based on playback speed
        if norm_frame.source_type == CameraSourceType.PRERECORDED_VIDEO:
            speed = getattr(active_camera, "playback_speed", 1.0)
            target_fps = getattr(active_camera, "target_fps", 25.0)
            frame_target_dt = 1.0 / (target_fps * max(0.25, min(speed, 4.0)))
            read_elapsed = time.time() - frame_read_start
            sleep_target = max(0.002, frame_target_dt - read_elapsed)
            time.sleep(sleep_target)

        current_time = norm_frame.timestamp
        frame = norm_frame.frame
        frame_counter += 1

        # Synchronize hub state with active camera
        with hub.lock:
            hub.camera_state = active_camera.lifecycle_state
            hub.fps = active_camera.health_metrics.received_fps
            hub.video_time = norm_frame.timestamp
            hub.video_frame_index = norm_frame.frame_index
            if hasattr(active_camera, "playback_state"):
                hub.playback_state = active_camera.playback_state
            if hasattr(active_camera, "playback_speed"):
                hub.playback_speed = active_camera.playback_speed

        try:
            # Run Ultralytics YOLO-Pose inference
            t_infer_start = time.time()
            with inference_lock:
                results = yolo_model(frame, imgsz=320, verbose=False, device=DEVICE_TARGET)
            hub.last_inference_latency = time.time() - t_infer_start
            r = results[0]

            persons_count = len(r.boxes) if r.boxes is not None else 0
            h_img, w_img = frame.shape[:2]

            ctx = active_camera.tracking_context
            # Check floor occlusion latch
            is_latch = ctx.fall_latched and (current_time - ctx.fall_latch_start_time < 4.0)

            if is_latch and persons_count == 0:
                kinematics_data = {
                    "person_detected": False,
                    "posture": "Acute Fall / Subject Below Camera View",
                    "risk_level": "HIGH_RISK",
                    "confidence": 92.0,
                    "torso_angle": 75.0,
                    "downward_velocity": -abs(ctx.recent_drop_velocity or 0.8),
                    "hypothesis": {
                        "id": "H1",
                        "label": "Floor Occlusion Fall",
                        "mechanism": "Subject fallen below camera field of view. Recovery monitoring active."
                    },
                    "canonical_event": {
                        "eventId": f"EVT-OCCL-{int(current_time * 1000)}",
                        "cameraId": active_camera.camera_id,
                        "edgeId": hub.edge_node.edge_id,
                        "sourceType": norm_frame.source_type,
                        "state": "CONTACT_OR_FALL",
                        "probableMechanism": "FALL",
                        "detectionConfidence": 90,
                        "mechanismConfidence": 85,
                        "severityConfidence": 80,
                        "recoveryStatus": "MONITORING",
                        "evidence": ["Subject transitioned below floor perimeter"],
                        "counterEvidence": [],
                        "timestamp": current_time
                    }
                }
            elif persons_count == 0:
                ctx.fall_latched = False
                ctx.prev_com_y = None
                ctx.prev_time = None
                ctx.consecutive_valid_frames = 0
                kinematics_data = {
                    "person_detected": False,
                    "posture": "Perimeter Clear (No Subject)",
                    "risk_level": "SAFE",
                    "confidence": 99.2,
                    "torso_angle": 0.0,
                    "downward_velocity": 0.0,
                    "hypothesis": {
                        "id": "H0",
                        "label": "Clear Perimeter",
                        "mechanism": "Zero subjects detected in monitored clinical zone."
                    },
                    "canonical_event": {
                        "eventId": f"EVT-SCAN-{int(current_time * 1000)}",
                        "cameraId": active_camera.camera_id,
                        "edgeId": hub.edge_node.edge_id,
                        "sourceType": norm_frame.source_type,
                        "state": "NORMAL",
                        "probableMechanism": "NORMAL_ACTIVITY",
                        "detectionConfidence": 0,
                        "mechanismConfidence": 100,
                        "severityConfidence": 0,
                        "recoveryStatus": "NOT_APPLICABLE",
                        "evidence": [],
                        "counterEvidence": []
                    }
                }
            else:
                primary_kp = r.keypoints.data[0].cpu().numpy()
                kinematics_data = compute_kinematics(
                    primary_kp, w_img, h_img, current_time,
                    source=norm_frame.source_type,
                    tracking_context=ctx,
                    camera_id=active_camera.camera_id,
                    edge_id=hub.edge_node.edge_id
                )

            rendered_frame = draw_pose_overlays(frame, results, kinematics_data, privacy_mode=False)
            radar_frame = draw_pose_overlays(frame, results, kinematics_data, privacy_mode=True)
        except Exception as frame_proc_err:
            print(f"[!] Warning: Frame processing error: {frame_proc_err}")
            rendered_frame = frame
            radar_frame = frame
            kinematics_data = {"person_detected": False, "posture": "Monitoring", "risk_level": "SAFE"}
            persons_count = 0

        with hub.lock:
            hub.latest_raw_frame = frame
            hub.latest_rendered_frame = rendered_frame
            hub.latest_radar_frame = radar_frame
            hub.last_seen = time.time()
            hub.telemetry = {
                "status": "ONLINE_STREAMING" if active_camera.lifecycle_state == CameraLifecycleState.ONLINE else active_camera.lifecycle_state,
                "camera_state": active_camera.lifecycle_state,
                "camera_source_type": norm_frame.source_type,
                "camera_id": active_camera.camera_id,
                "camera_name": active_camera.camera_name,
                "edge_id": hub.edge_node.edge_id,
                "playback_state": getattr(active_camera, "playback_state", "PLAYING"),
                "playback_speed": getattr(active_camera, "playback_speed", 1.0),
                "video_time": norm_frame.timestamp,
                "video_duration": getattr(active_camera, "video_duration", 14.76),
                "timeline_stage": kinematics_data.get("timeline_stage", "STAGE_RESTING"),
                "stage": kinematics_data.get("stage", "STAGE_RESTING"),
                "detection_confidence": kinematics_data.get("detection_confidence", 85),
                "mechanism_confidence": kinematics_data.get("mechanism_confidence", 90),
                "severity_confidence": kinematics_data.get("severity_confidence", 0),
                "evidence": kinematics_data.get("evidence", []),
                "counter_evidence": kinematics_data.get("counter_evidence", []),
                "device": GPU_NAME,
                "cuda_enabled": CUDA_AVAILABLE,
                "engine": "Ultralytics YOLO11-Pose",
                "fps": active_camera.health_metrics.received_fps or hub.fps,
                "inference_latency_ms": round(hub.last_inference_latency * 1000, 1),
                "person_detected": persons_count > 0,
                "persons_count": persons_count,
                "torso_angle": kinematics_data.get("torso_angle", 0.0),
                "downward_velocity": kinematics_data.get("downward_velocity", 0.0),
                "motion_energy_percent": kinematics_data.get("motion_energy_percent", 6 if persons_count == 0 else 12),
                "posture": kinematics_data.get("posture", "Upright Ambulation"),
                "risk_level": kinematics_data.get("risk_level", "SAFE"),
                "confidence": kinematics_data.get("confidence", 95.0),
                "hypothesis": kinematics_data.get("hypothesis", {}),
                "canonical_event": kinematics_data.get("canonical_event", {}),
                "timestamp": current_time
            }
        hub.new_frame_event.set()

    if active_camera is not None:
        active_camera.release()
    print("[*] Camera processing thread stopped.")

class NumpyJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer, np.int64, np.int32)):
            return int(obj)
        elif isinstance(obj, (np.floating, np.float32, np.float64)):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

# HTTP API and Video Stream Server
class SentinelRequestHandler(BaseHTTPRequestHandler):
    def send_cors_headers(self, content_type="application/json"):
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # 1. Edge Discovery Endpoint
        if path == "/api/yolo/edge":
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                hb = hub.edge_node.get_heartbeat(
                    model_status="ONLINE",
                    inference_latency_ms=hub.last_inference_latency * 1000
                )
            self.wfile.write(json.dumps(hb, indent=2, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 2. Camera Registry Endpoint
        if path == "/api/yolo/cameras":
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                cam_list = []
                for c in hub.edge_node.cameras.values():
                    item = c.to_config_dict()
                    item.update(c.get_health())
                    cam_list.append(item)
                resp = {
                    "ok": True,
                    "activeCameraId": hub.edge_node.active_camera_id,
                    "cameras": cam_list
                }
            self.wfile.write(json.dumps(resp, indent=2, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 3. 7-Tier Hierarchy Health Endpoint
        if path in ["/api/yolo/health/hierarchy", "/api/yolo/hierarchy"]:
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                h = hub.edge_node.get_hierarchy_health()
            self.wfile.write(json.dumps(h, indent=2, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 4. Status Discovery Endpoint (Preserved + Enhanced)
        if path in ["/api/yolo/status", "/"]:
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                active_src = hub.edge_node.get_active_camera()
                is_hardware_on = bool(active_src and active_src.lifecycle_state not in [CameraLifecycleState.OFFLINE, CameraLifecycleState.STOPPED])
                status_payload = {
                    "engine": "Ultralytics YOLO11-Pose",
                    "device": GPU_NAME,
                    "cuda_enabled": CUDA_AVAILABLE,
                    "status": hub.telemetry.get("status", "STANDBY_AWAITING_CONSENT"),
                    "source": hub.source,
                    "camera_source_type": active_src.source_type if active_src else hub.camera_source_type,
                    "camera_id": active_src.camera_id if active_src else "cam-default",
                    "edge_id": hub.edge_node.edge_id,
                    "playback_state": hub.playback_state,
                    "playback_speed": hub.playback_speed,
                    "video_time": hub.video_time,
                    "video_duration": hub.video_duration,
                    "timeline_stage": hub.timeline_stage,
                    "demo_video_available": os.path.exists(hub.demo_video_path),
                    "hardware_active": is_hardware_on,
                    "camera_led_state": ("ON" if (is_hardware_on and hub.source == "webcam") else "OFF"),
                    "active_streamers": int(hub.active_streamers),
                    "fps": float(hub.fps),
                    "model": "yolo11n-pose.pt",
                    "camera_index": hub.camera_index,
                    "active_zone": active_src.zone if active_src else "Virtual Ward Bed 1",
                    "last_seen": float(hub.last_seen)
                }
            self.wfile.write(json.dumps(status_payload, indent=2, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 5. Live Telemetry Endpoint
        if path == "/api/yolo/telemetry":
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                payload = dict(hub.telemetry)
            self.wfile.write(json.dumps(payload, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 6. Edge Heartbeat Endpoint (Every 2–5s)
        if path == "/api/yolo/heartbeat":
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            with hub.lock:
                active_src = hub.edge_node.get_active_camera()
                is_hardware_on = bool(active_src and active_src.lifecycle_state not in [CameraLifecycleState.OFFLINE, CameraLifecycleState.STOPPED])
                heartbeat_payload = {
                    "edgeId": hub.edge_node.edge_id,
                    "name": hub.edge_node.name,
                    "hostIdentifier": hub.edge_node.host_identifier,
                    "timestamp": time.time(),
                    "processStatus": "RUNNING",
                    "cameraStatus": active_src.lifecycle_state if active_src else "STANDBY",
                    "modelStatus": "MODEL_READY",
                    "fps": float(hub.fps),
                    "trackedPersons": int(hub.telemetry.get("persons_count", 0)),
                    "inferenceLatencyMs": round(float(hub.last_inference_latency) * 1000, 1),
                    "version": hub.edge_node.software_version,
                    "device": GPU_NAME,
                    "cudaEnabled": CUDA_AVAILABLE,
                    "status": "EDGE_ONLINE",
                    "activeCameraId": hub.edge_node.active_camera_id,
                    "cameras": [c.get_health() for c in hub.edge_node.cameras.values()]
                }
            self.wfile.write(json.dumps(heartbeat_payload, indent=2, cls=NumpyJSONEncoder).encode("utf-8"))
            return

        # 7. Live MJPEG Video Stream
        if path in ["/api/yolo/stream", "/api/yolo/video_feed"]:
            privacy = query.get("privacy", ["0"])[0] == "1"
            req_source = query.get("source", [None])[0]

            with hub.lock:
                if req_source in ["webcam", "bed_fall_demo", "RTSP_CAMERA"]:
                    if req_source == "webcam":
                        hub.edge_node.set_active_camera("cam-webcam-01")
                        hub.source = "webcam"
                    elif req_source == "bed_fall_demo":
                        hub.edge_node.set_active_camera("cam-prerecorded-demo")
                        hub.source = "bed_fall_demo"
                    elif req_source == "RTSP_CAMERA":
                        hub.edge_node.set_active_camera("cam-rtsp-ward-01")
                        hub.source = "RTSP_CAMERA"

                hub.active_streamers += 1
                hub.camera_active = True
                print(f"[+] Client connected to video feed (Viewers: {hub.active_streamers}, Active Camera: {hub.edge_node.active_camera_id}).")

            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()

            try:
                last_streamed_time = 0
                while hub.running:
                    with hub.lock:
                        if not hub.camera_active and hub.active_streamers <= 0:
                            break
                        frame_to_stream = hub.latest_radar_frame if privacy else hub.latest_rendered_frame
                        current_frame_time = hub.last_seen

                    if frame_to_stream is not None and current_frame_time != last_streamed_time:
                        last_streamed_time = current_frame_time
                        # High-speed turbo JPEG encoding (Quality 68 for 40% faster encoding & lower payload)
                        ret, jpeg = cv2.imencode(".jpg", frame_to_stream, [int(cv2.IMWRITE_JPEG_QUALITY), 68])
                        if ret:
                            data = jpeg.tobytes()
                            self.wfile.write(b"--frame\r\n")
                            self.wfile.write(b"Content-Type: image/jpeg\r\n")
                            self.wfile.write(f"Content-Length: {len(data)}\r\n\r\n".encode("utf-8"))
                            self.wfile.write(data)
                            self.wfile.write(b"\r\n")
                            self.wfile.flush()

                    # High-efficiency event-driven frame wait (wakes immediately when new frame arrives)
                    hub.new_frame_event.wait(timeout=0.030)
                    hub.new_frame_event.clear()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                with hub.lock:
                    hub.active_streamers = max(0, hub.active_streamers - 1)
                    if hub.active_streamers == 0:
                        hub.camera_active = False
                    print(f"[-] Client disconnected from video feed (Remaining viewers: {hub.active_streamers}).")
            return

        # 7B. Single-Frame Snapshot (reliable alternative to MJPEG streaming)
        # The frontend polls this at ~25fps using setInterval + <img>.src swap.
        # This avoids all MJPEG browser stalls and long-lived TCP issues.
        if path == "/api/yolo/snapshot":
            privacy = query.get("privacy", ["0"])[0] == "1"
            with hub.lock:
                frame = hub.latest_radar_frame if privacy else hub.latest_rendered_frame
                # Activate camera on-demand (same as MJPEG endpoint)
                if not hub.camera_active:
                    hub.camera_active = True
            if frame is None:
                # Camera is starting up, no frame yet — 204 No Content with explicit 0 length
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.send_cors_headers("text/plain")
                self.end_headers()
                return
            ret, jpeg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 68])
            if not ret:
                self.send_response(500)
                self.send_cors_headers("text/plain")
                self.end_headers()
                return
            data = jpeg.tobytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                self.wfile.write(data)
                self.wfile.flush()
            except Exception:
                pass
            return

        # 404 Fallback
        self.send_response(404)
        self.send_cors_headers("text/plain")
        self.end_headers()
        try:
            self.wfile.write(b"Endpoint not found")
        except Exception:
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # 1. Browser Camera Frame Inference Endpoint
        if path == "/api/yolo/process_frame":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                raw_bytes = self.rfile.read(content_len) if content_len > 0 else None
                if not raw_bytes:
                    raise ValueError("Empty body")

                client_vtime = None
                req_source = None

                if raw_bytes.startswith(b"{"):
                    req = json.loads(raw_bytes.decode("utf-8"))
                    b64_str = req.get("image", "")
                    if "," in b64_str:
                        b64_str = b64_str.split(",", 1)[1]
                    raw_bytes = base64.b64decode(b64_str)
                    client_vtime = req.get("video_timestamp", None)
                    req_source = req.get("source", None)

                if client_vtime is None and self.headers.get("X-Video-Timestamp"):
                    try:
                        client_vtime = float(self.headers.get("X-Video-Timestamp"))
                    except Exception:
                        pass
                if req_source is None and self.headers.get("X-Source"):
                    req_source = self.headers.get("X-Source")

                nparr = np.frombuffer(raw_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is None:
                    raise ValueError("Failed to decode image frame")

                h_img, w_img = frame.shape[:2]
                with inference_lock:
                    results = yolo_model(frame, imgsz=320, verbose=False, device=DEVICE_TARGET)
                r = results[0]

                persons_count = len(r.boxes) if r.boxes is not None else 0
                kin_time = float(client_vtime) if (client_vtime is not None and float(client_vtime) > 1.0) else time.time()
                src_for_kin = req_source or hub.source

                if persons_count > 0 and r.keypoints is not None and len(r.keypoints.data) > 0:
                    primary_kp = r.keypoints.data[0].cpu().numpy()
                    kinematics = compute_kinematics(primary_kp, w_img, h_img, kin_time, source=src_for_kin)
                    boxes = r.boxes.xyxy.cpu().numpy()
                    primary_box = boxes[0].tolist() if len(boxes) > 0 else None

                    resp = {
                        "ok": True,
                        "person_detected": True,
                        "keypoints": primary_kp.tolist(),
                        "bbox": primary_box,
                        "torso_angle": kinematics.get("torso_angle", 0.0),
                        "downward_velocity": kinematics.get("downward_velocity", 0.0),
                        "motion_energy_percent": kinematics.get("motion_energy_percent", 25),
                        "posture": kinematics.get("posture", "Upright Ambulation"),
                        "risk_level": kinematics.get("risk_level", "SAFE"),
                        "confidence": kinematics.get("confidence", 95.0),
                        "stage": kinematics.get("stage", "STAGE_RESTING"),
                        "timeline_stage": kinematics.get("timeline_stage", "STAGE_RESTING"),
                        "detection_confidence": kinematics.get("detection_confidence", 85),
                        "mechanism_confidence": kinematics.get("mechanism_confidence", 90),
                        "severity_confidence": kinematics.get("severity_confidence", 0),
                        "evidence": kinematics.get("evidence", []),
                        "counter_evidence": kinematics.get("counter_evidence", []),
                        "canonical_event": kinematics.get("canonical_event", {}),
                        "consensus_summary": kinematics.get("hypothesis", {}).get("mechanism", "YOLO Pose tracking nominal.")
                    }
                else:
                    resp = {
                        "ok": True,
                        "person_detected": False,
                        "keypoints": [],
                        "bbox": None,
                        "torso_angle": 0.0,
                        "downward_velocity": 0.0,
                        "motion_energy_percent": 6,
                        "posture": "Scanning Perimeter (No Person Detected)",
                        "risk_level": "SAFE",
                        "confidence": 98.0,
                        "stage": "STAGE_RESTING",
                        "timeline_stage": "STAGE_RESTING",
                        "detection_confidence": 0,
                        "mechanism_confidence": 100,
                        "severity_confidence": 0,
                        "evidence": ["Subject out of frame or occluded"],
                        "counter_evidence": ["Perimeter nominal"],
                        "canonical_event": {
                            "eventId": f"EVT-SCAN-{int(kin_time)}",
                            "state": "NORMAL",
                            "probableMechanism": "NORMAL_ACTIVITY",
                            "detectionConfidence": 0,
                            "mechanismConfidence": 100,
                            "severityConfidence": 0,
                            "recoveryStatus": "NOT_APPLICABLE",
                            "evidence": [],
                            "counterEvidence": []
                        },
                        "consensus_summary": "Subject out of frame or occluded. Perimeter nominal."
                    }

                self.send_response(200)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps(resp).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 1B. Set Webcam Physical Device Index (e.g. 0 for Phone, 1 for Built-in Laptop Webcam)
        if path == "/api/yolo/webcam/device":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(content_len).decode("utf-8")) if content_len > 0 else {}
                new_idx = int(body.get("deviceIndex", 0))
                target_cam_id = "cam-webcam-02" if new_idx == 1 else "cam-webcam-01"
                with hub.lock:
                    hub.camera_index = new_idx
                    if hub.source == "webcam":
                        hub.edge_node.set_active_camera(target_cam_id)
                self.send_response(200)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "deviceIndex": new_idx, "cameraId": target_cam_id}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 2. Add / Configure Camera Source Endpoint
        if path == "/api/yolo/cameras":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(content_len).decode("utf-8")) if content_len > 0 else {}
                cid = body.get("cameraId") or f"cam-rtsp-{int(time.time())}"
                stype = body.get("sourceType", "RTSP_CCTV")
                cname = body.get("cameraName", "Hospital Ward Camera")
                zone = body.get("zone", "GB Pant Hospital · Virtual Ward Bed 1")
                resident_id = body.get("residentId", "P3")
                bed_id = body.get("bedId", "BED1")

                if stype == "RTSP_CCTV":
                    rtsp_url = body.get("rtspUrl", "")
                    valid, vmsg = validate_rtsp_url(rtsp_url)
                    if not valid:
                        self.send_response(400)
                        self.send_cors_headers("application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"ok": False, "error": vmsg}).encode("utf-8"))
                        return
                    new_cam = RtspCctvSource(cid, cname, rtsp_url, zone=zone, resident_id=resident_id, bed_id=bed_id)
                elif stype == "LOCAL_WEBCAM":
                    didx = int(body.get("deviceIndex", 0))
                    new_cam = LocalWebcamSource(cid, cname, device_index=didx, zone=zone, resident_id=resident_id)
                else:
                    vpath = body.get("videoPath")
                    new_cam = PrerecordedVideoSource(cid, cname, video_path=vpath, zone=zone, resident_id=resident_id)

                with hub.lock:
                    hub.edge_node.register_camera(new_cam)

                self.send_response(201)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "camera": new_cam.to_config_dict()}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 3. Test Camera Connection Endpoint (/api/yolo/cameras/<id>/test or /api/yolo/cameras/test)
        if "/test" in path and "/api/yolo/cameras" in path:
            try:
                cam_id = path.replace("/api/yolo/cameras/", "").replace("/test", "")
                content_len = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(content_len).decode("utf-8")) if content_len > 0 else {}

                # If testing a raw RTSP URL before saving
                test_url = body.get("rtspUrl")
                if test_url:
                    temp_cam = RtspCctvSource("temp-test", "Test Camera", test_url)
                    ok, msg = temp_cam.test_connection()
                    self.send_response(200)
                    self.send_cors_headers("application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": ok, "message": msg}).encode("utf-8"))
                    return

                with hub.lock:
                    cam = hub.edge_node.get_camera(cam_id)
                if not cam:
                    self.send_response(404)
                    self.send_cors_headers("application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "error": "Camera not found"}).encode("utf-8"))
                    return

                ok, msg = cam.test_connection()
                self.send_response(200)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": ok, "message": msg}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 4. Activate Camera Source Endpoint (/api/yolo/cameras/<id>/activate)
        if "/activate" in path and "/api/yolo/cameras" in path:
            try:
                cam_id = path.replace("/api/yolo/cameras/", "").replace("/activate", "")
                with hub.lock:
                    success = hub.edge_node.set_active_camera(cam_id)
                    if success:
                        active = hub.edge_node.get_active_camera()
                        hub.camera_source_type = active.source_type
                        if active.source_type == CameraSourceType.PRERECORDED_VIDEO:
                            hub.source = "bed_fall_demo"
                        elif active.source_type == CameraSourceType.LOCAL_WEBCAM:
                            hub.source = "webcam"
                        else:
                            hub.source = "RTSP_CAMERA"
                        hub.camera_active = True
                self.send_response(200 if success else 404)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": success, "activeCameraId": cam_id}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 5. Video Source Selection Endpoint (Backwards-Compatible Abstraction)
        if path == "/api/yolo/source":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                req_data = json.loads(body) if body else {}
                target_src = req_data.get("source", "bed_fall_demo")
                auto_start = req_data.get("autoStart", True)

                with hub.lock:
                    if target_src in ["PRERECORDED_VIDEO", "bed_fall_demo"]:
                        hub.camera_source_type = "PRERECORDED_VIDEO"
                        hub.source = "bed_fall_demo"
                        hub.edge_node.set_active_camera("cam-prerecorded-demo")
                    elif target_src in ["LIVE_WEBCAM", "webcam"]:
                        hub.camera_source_type = "LIVE_WEBCAM"
                        hub.source = "webcam"
                        hub.edge_node.set_active_camera("cam-webcam-01")
                    elif target_src in ["RTSP_CAMERA", "RTSP_CCTV"]:
                        hub.camera_source_type = "RTSP_CAMERA"
                        hub.source = "RTSP_CAMERA"
                        hub.edge_node.set_active_camera("cam-rtsp-ward-01")
                    if auto_start:
                        hub.camera_active = True
                    # Clear stale frames from the previous source so the MJPEG
                    # stream doesn't briefly serve an old frame before the new
                    # camera finishes opening and produces fresh output.
                    hub.latest_rendered_frame = None
                    hub.latest_radar_frame = None
                    hub.last_seen = 0

                print(f"[+] Source switched via API to: {hub.source} (Active: {hub.edge_node.active_camera_id})")
                self.send_response(200)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "source": hub.source,
                    "camera_source_type": hub.camera_source_type,
                    "activeCameraId": hub.edge_node.active_camera_id
                }).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 6. Playback Control Endpoint (START, PAUSE, RESUME, STOP, RESTART, SPEED)
        if path == "/api/yolo/control":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8") if content_len > 0 else "{}"
                data = json.loads(body) if body else {}
                action = data.get("action", "start")

                with hub.lock:
                    active_cam = hub.edge_node.get_active_camera()
                    if action in ["start", "play", "resume"]:
                        hub.playback_state = "PLAYING"
                        hub.camera_active = True
                        if hasattr(active_cam, "resume"):
                            active_cam.resume()
                        if hub.camera_state == "VIDEO_ENDED" or hub.playback_state == "STOPPED":
                            hub.reset_tracking_state()
                            hub.camera_state = "MONITORING"
                    elif action == "pause":
                        hub.playback_state = "PAUSED"
                        if hasattr(active_cam, "pause"):
                            active_cam.pause()
                    elif action == "stop":
                        hub.playback_state = "STOPPED"
                        hub.camera_active = False
                        if hasattr(active_cam, "stop"):
                            active_cam.stop()
                        hub.reset_tracking_state()
                    elif action == "restart":
                        hub.playback_state = "PLAYING"
                        hub.camera_active = True
                        hub.camera_state = "CAMERA_CALIBRATING"
                        hub.calibration_frames_left = 20
                        if hasattr(active_cam, "restart"):
                            active_cam.restart()
                        hub.reset_tracking_state()
                    elif action == "speed":
                        new_speed = float(data.get("speed", 1.0))
                        hub.playback_speed = max(0.25, min(new_speed, 4.0))
                        if hasattr(active_cam, "set_speed"):
                            active_cam.set_speed(hub.playback_speed)

                self.send_response(200)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "action": action,
                    "playback_state": hub.playback_state,
                    "playback_speed": hub.playback_speed,
                    "video_time": hub.video_time,
                    "timeline_stage": hub.timeline_stage
                }).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(400)
                self.send_cors_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        # 7. Explicit Camera Start Endpoint
        if path == "/api/yolo/start":
            with hub.lock:
                hub.camera_active = True
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            try:
                led_state = "ON" if hub.source == "webcam" else "OFF (Demo/RTSP)"
                self.wfile.write(json.dumps({"ok": True, "camera_active": True, "source": hub.source, "camera_led": led_state}).encode("utf-8"))
            except Exception:
                pass
            return

        # 8. Explicit Camera Stop Endpoint
        if path == "/api/yolo/stop":
            with hub.lock:
                hub.camera_active = False
                hub.active_streamers = 0
            self.send_response(200)
            self.send_cors_headers("application/json")
            self.end_headers()
            try:
                self.wfile.write(json.dumps({"ok": True, "camera_active": False, "camera_led": "OFF"}).encode("utf-8"))
            except Exception:
                pass
            return

        # 404 Fallback
        self.send_response(404)
        self.send_cors_headers("application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": False, "error": "Not found"}).encode("utf-8"))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/yolo/cameras/"):
            cam_id = path.replace("/api/yolo/cameras/", "").strip()
            with hub.lock:
                removed = hub.edge_node.remove_camera(cam_id)
            self.send_response(200 if removed else 404)
            self.send_cors_headers("application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": removed, "cameraId": cam_id}).encode("utf-8"))
            return

        self.send_response(404)
        self.send_cors_headers("application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": False, "error": "Endpoint not found"}).encode("utf-8"))

class SingleInstanceHTTPServer(ThreadingHTTPServer):
    """
    HTTP server that REFUSES to share its port.

    Python's ThreadingHTTPServer inherits allow_reuse_address = True, which sets
    SO_REUSEADDR. On Linux that only allows rebinding a socket in TIME_WAIT; on
    WINDOWS it lets a SECOND process bind a port that is already actively
    listening. Two sentinels then split incoming connections unpredictably, each
    with its own independent camera state - which reaches the browser as a live
    stream that freezes on its first frame while telemetry stalls.

    Setting this False makes a second instance fail loudly instead.
    """
    allow_reuse_address = False
    daemon_threads = True


def run_server(port=EDGE_PORT):
    # Re-checked here as well: the port could have been taken during the model
    # load above. (The fast path is the early guard near the top of the file.)
    if _edge_port_in_use(port):
        print(f"\n[!] Port {port} became occupied while loading. Refusing to start.")
        print("[!] Run tools\\stop_yolo.bat and retry.\n")
        sys.exit(1)

    server_address = ("0.0.0.0", port)
    try:
        httpd = SingleInstanceHTTPServer(server_address, SentinelRequestHandler)
    except OSError as e:
        print(f"\n[!] Could not bind port {port}: {e}")
        print("[!] Another process is using it. Run tools\\stop_yolo.bat and retry.\n")
        sys.exit(1)

    print(f"\n[+] ReJivan Edge Sentinel REST API & MJPEG Server listening on 0.0.0.0:{port}")
    print(f"[*] Discovery URL: http://127.0.0.1:{port}/api/yolo/status")
    print(f"[*] Heartbeat URL: http://127.0.0.1:{port}/api/yolo/heartbeat")
    print(f"[*] Camera Registry URL: http://127.0.0.1:{port}/api/yolo/cameras")
    print(f"[*] Edge Health Hierarchy: http://127.0.0.1:{port}/api/yolo/health/hierarchy")
    print(f"[*] Live Stream URL: http://127.0.0.1:{port}/api/yolo/video_feed\n")

    cam_thread = threading.Thread(target=camera_processing_thread, daemon=True)
    cam_thread.start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down ReJivan Edge Sentinel...")
        hub.running = False
        httpd.shutdown()
        cam_thread.join(timeout=2.0)
        print("[+] ReJivan Edge Sentinel daemon terminated cleanly.")
    except Exception as srv_err:
        import traceback
        print(f"\n[!] Unexpected server error: {srv_err}")
        traceback.print_exc()
        hub.running = False
        try:
            httpd.shutdown()
        except Exception:
            pass

if __name__ == "__main__":
    port_num = 5050
    if len(sys.argv) > 1:
        try:
            port_num = int(sys.argv[1])
        except ValueError:
            pass
    run_server(port_num)
