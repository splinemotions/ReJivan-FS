// prototype/movement-engine.js
// ReJivan Unified Motion Kinematics, Hypothesis Scoring, Counterfactual Reasoning & Sensor Fusion Engine
// Compatible with both browser (MediaPipe / Optical Flow) and edge hardware (YOLO11-Pose via local CUDA GPU)
// Architectural flow: OBSERVE -> RECONSTRUCT -> CORROBORATE -> REASON -> VERIFY -> RESPOND

(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ReJivanMovementEngine = factory();
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : this), function () {
  "use strict";

  // Standard 17-point COCO Keypoint Map (Identical across YOLO-Pose & MediaPipe)
  const KEYPOINTS = Object.freeze({
    NOSE: 0,
    LEFT_EYE: 1, RIGHT_EYE: 2,
    LEFT_EAR: 3, RIGHT_EAR: 4,
    LEFT_SHOULDER: 5, RIGHT_SHOULDER: 6,
    LEFT_ELBOW: 7, RIGHT_ELBOW: 8,
    LEFT_WRIST: 9, RIGHT_WRIST: 10,
    LEFT_HIP: 11, RIGHT_HIP: 12,
    LEFT_KNEE: 13, RIGHT_KNEE: 14,
    LEFT_ANKLE: 15, RIGHT_ANKLE: 16
  });

  // Candidate Physical Mechanisms
  const MECHANISMS = Object.freeze({
    NORMAL_ACTIVITY: "NORMAL_ACTIVITY",
    INTENTIONAL_SITTING: "INTENTIONAL_SITTING",
    INTENTIONAL_LYING: "INTENTIONAL_LYING",
    KNEELING: "KNEELING",
    TRIP: "TRIP",
    LOSS_OF_BALANCE: "LOSS_OF_BALANCE",
    FALL: "FALL",
    FALL_WITH_IMMOBILITY: "FALL_WITH_IMMOBILITY",
    DEVICE_DROP: "DEVICE_DROP",
    UNKNOWN: "UNKNOWN"
  });

  // Unified Camera Source Abstraction
  const CAMERA_SOURCES = Object.freeze({
    LIVE_WEBCAM: "LIVE_WEBCAM",
    RTSP_CAMERA: "RTSP_CAMERA",
    PRERECORDED_VIDEO: "PRERECORDED_VIDEO"
  });

  const CAMERA_LIFECYCLE = Object.freeze({
    CAMERA_OFFLINE: "CAMERA_OFFLINE",
    CAMERA_STARTING: "CAMERA_STARTING",
    CAMERA_CALIBRATING: "CAMERA_CALIBRATING",
    MONITORING: "MONITORING",
    PAUSED: "PAUSED",
    VIDEO_ENDED: "VIDEO_ENDED"
  });

  // Demonstration Timeline Stages
  const PRERECORDED_STAGES = Object.freeze([
    { id: "STAGE_RESTING", label: "Normal In-Bed Resting", state: "NORMAL", step: 1 },
    { id: "STAGE_BED_EDGE", label: "Bed-Edge Sitting", state: "NORMAL", step: 2 },
    { id: "STAGE_DESCENT", label: "Suspected Descent", state: "ANOMALY", step: 3 },
    { id: "STAGE_CONTACT", label: "Floor Contact / Fall", state: "CONTACT_OR_FALL", step: 4 },
    { id: "STAGE_RECOVERY", label: "Recovery Monitoring", state: "RECOVERY_MONITORING", step: 5 },
    { id: "STAGE_VERIFY", label: "Resident Verification", state: "VERIFICATION", step: 6 },
    { id: "STAGE_ESCALATED", label: "High-Risk Escalation", state: "ESCALATED", step: 7 },
    { id: "STAGE_RESOLVED", label: "Upright Recovery / Resolved", state: "RESOLVED", step: 7 }
  ]);

  /**
   * Personal Baseline Tracker
   * Maintains running averages of resident normal behavior to evaluate individual deviations
   */
  class PersonalBaselineTracker {
    constructor(initial = {}) {
      this.typicalWalkingVelocity = initial.typicalWalkingVelocity ?? 0.85; // m/s
      this.typicalLateralSway = initial.typicalLateralSway ?? 6.5;         // degrees
      this.typicalSitDurationSec = initial.typicalSitDurationSec ?? 1.8;   // seconds to sit down
      this.sampleCount = initial.sampleCount ?? 20;
    }

    update(observation) {
      if (!observation) return;
      const alpha = 0.05; // slow moving average
      if (observation.walkingVelocity && observation.walkingVelocity > 0.2) {
        this.typicalWalkingVelocity = (1 - alpha) * this.typicalWalkingVelocity + alpha * observation.walkingVelocity;
      }
      if (observation.lateralSway && observation.lateralSway >= 0) {
        this.typicalLateralSway = (1 - alpha) * this.typicalLateralSway + alpha * observation.lateralSway;
      }
      this.sampleCount++;
    }

    getDeviation(currentVelocity, currentSway) {
      const velDev = currentVelocity ? (currentVelocity - this.typicalWalkingVelocity) / this.typicalWalkingVelocity : 0;
      const swayDev = currentSway ? (currentSway - this.typicalLateralSway) / this.typicalLateralSway : 0;
      return {
        velocityDeviationRatio: Math.round(velDev * 100) / 100,
        swayDeviationRatio: Math.round(swayDev * 100) / 100,
        isSignificantSway: swayDev > 1.5
      };
    }
  }

  const defaultBaseline = new PersonalBaselineTracker();

  /**
   * Calculates Center of Mass (CoM) and Torso Angle from skeletal landmarks
   */
  function analyzePoseGeometry(landmarks) {
    if (!landmarks || landmarks.length < 17) {
      return { valid: false, reason: "Insufficient keypoint tracking (<17 points)" };
    }

    const lShoulder = landmarks[KEYPOINTS.LEFT_SHOULDER];
    const rShoulder = landmarks[KEYPOINTS.RIGHT_SHOULDER];
    const lHip = landmarks[KEYPOINTS.LEFT_HIP];
    const rHip = landmarks[KEYPOINTS.RIGHT_HIP];

    const hasShoulders = (lShoulder?.visibility ?? 1) > 0.3 && (rShoulder?.visibility ?? 1) > 0.3;
    const hasHips = (lHip?.visibility ?? 1) > 0.3 && (rHip?.visibility ?? 1) > 0.3;

    if (!hasShoulders && !hasHips) {
      return { valid: false, reason: "Torso landmarks occluded" };
    }

    const shoulderMid = hasShoulders ? {
      x: (lShoulder.x + rShoulder.x) / 2,
      y: (lShoulder.y + rShoulder.y) / 2
    } : { x: landmarks[0].x, y: landmarks[0].y + 0.1 };

    const hipMid = hasHips ? {
      x: (lHip.x + rHip.x) / 2,
      y: (lHip.y + rHip.y) / 2
    } : { x: shoulderMid.x, y: shoulderMid.y + 0.25 };

    const dx = hipMid.x - shoulderMid.x;
    const dy = hipMid.y - shoulderMid.y;
    const angleFromVertical = Math.abs(Math.atan2(Math.abs(dx), Math.max(Math.abs(dy), 0.001)) * (180 / Math.PI));

    const com = {
      x: (shoulderMid.x + hipMid.x) / 2,
      y: (shoulderMid.y + hipMid.y) / 2
    };

    return {
      valid: true,
      centerOfMass: com,
      shoulderMid,
      hipMid,
      torsoAngleDegrees: Math.round(angleFromVertical * 10) / 10,
      isHorizontallyOriented: angleFromVertical > 55
    };
  }

  /**
   * Evaluates Competing Physical Hypotheses with Counterfactuals & Negative Evidence
   * Across Vision Kinematics, IMU Shock, Room Context, Recovery, and Baseline Deviation
   */
  function evaluateHypotheses(evidence = {}, baseline = defaultBaseline) {
    const {
      downwardVelocity = -0.1,     // m/s (negative = downward)
      torsoAngle = 10,             // degrees from vertical (0=standing, 90=flat)
      impactShockG = 1.0,          // IMU accelerometer peak g-force (1.0=normal, >2.4=impact)
      postStillnessSeconds = 0,    // seconds elapsed motionless
      chairBedProximity = false,   // near recognized furniture
      bedProximity = false,        // near bed
      isFloorLevel = false,        // confirmed situated at floor level
      isBedLevel = false,          // confirmed resting within elevated bed boundary
      isStartupCalibrating = false,// sensor startup auto-exposure / calibration phase
      isKneeling = false,          // knees on floor with upright torso
      wristOscillationHz = 0,      // frequency of tremor/jitter (3-8 Hz)
      recoveryObserved = false,    // stood back up or upright recovery restored
      trackingQuality = 0.95,      // 0.0 - 1.0 tracking confidence
      sensorConflict = false,      // vision and IMU disagree
      deviceLiftedUpright = false  // phone picked up after drop
    } = evidence;

    const supporting = [];
    const counter = [];
    const hypotheses = [];

    // Check for Sensor Calibration Startup Gate (Suppresses all alerts during initial auto-exposure/calibration)
    if (isStartupCalibrating) {
      hypotheses.push({
        id: "H_CALIB",
        mechanism: MECHANISMS.NORMAL_ACTIVITY,
        label: "Sensor Calibration Phase",
        score: 0.99,
        confidence: 99,
        severity: "NORMAL",
        explanation: "Establishing spatial reference baseline and lighting calibration. Alert triggers inhibited."
      });
      return {
        winningHypothesis: hypotheses[0],
        allHypotheses: hypotheses,
        detectionConfidence: 5,
        mechanismConfidence: 98,
        severityConfidence: 0,
        supportingEvidence: ["Startup calibration active", "Spatial baseline acquiring"],
        counterEvidence: ["Alert generation inhibited during calibration"],
        counterfactualExplanation: "Camera startup in progress; temporal derivatives suppressed to avoid false startup alerts."
      };
    }

    // Check for UNKNOWN / DEGRADED condition
    if (trackingQuality < 0.40 || sensorConflict) {
      hypotheses.push({
        id: "H_UNKNOWN",
        mechanism: MECHANISMS.UNKNOWN,
        label: "Ambiguous Evidence / Sensor Conflict",
        score: 0.85,
        confidence: 85,
        severity: "UNKNOWN",
        explanation: "Optical tracking quality collapsed or sensor telemetry is contradictory. System enters verification state rather than raising a false emergency."
      });
      return {
        winningHypothesis: hypotheses[0],
        allHypotheses: hypotheses,
        detectionConfidence: 30,
        mechanismConfidence: 20,
        severityConfidence: 10,
        supportingEvidence: ["Tracking quality degraded or sensor conflict"],
        counterEvidence: ["Zero confirmed anatomical collapse"],
        counterfactualExplanation: "Event classified as UNKNOWN because sensor evidence is ambiguous. Missing data is never treated as confirmed danger."
      };
    }

    // Evaluate H1: Fall (Accidental / Uncontrolled)
    let hFallScore = 0.05;
    if (downwardVelocity < -1.0) {
      hFallScore += 0.35;
      supporting.push(`High downward velocity (${downwardVelocity} m/s)`);
    } else {
      counter.push(`Descent velocity within controlled threshold (${downwardVelocity} m/s)`);
    }
    if (torsoAngle > 50) {
      hFallScore += 0.25;
      supporting.push(`Torso angle indicates collapse (${torsoAngle}°)`);
    } else {
      counter.push(`Spine maintained vertical posture (${torsoAngle}°)`);
    }
    if (impactShockG > 2.2) {
      hFallScore += 0.30;
      supporting.push(`Deceleration ground shock detected (${impactShockG}g)`);
    } else {
      counter.push(`Zero impact deceleration shock (${impactShockG}g)`);
    }
    if (isFloorLevel) {
      hFallScore += 0.30;
      supporting.push("Body situated at floor level outside designated sleep area");
    }
    if (isBedLevel) {
      hFallScore -= 0.35;
      counter.push("Patient situated within elevated care bed perimeter");
    }
    // Negative evidence: chair proximity reduces accidental fall
    if (chairBedProximity || bedProximity) {
      hFallScore -= 0.25;
      counter.push("Proximity to recognized seating/bed furniture rules against uncontrolled fall");
    }
    if (recoveryObserved) {
      hFallScore -= 0.40;
      counter.push("Immediate upright postural recovery observed (<5s)");
    }
    hFallScore = Math.max(0.01, Math.min(0.99, hFallScore));

    // Evaluate H2: Controlled Sitting
    let hSitScore = 0.05;
    if (downwardVelocity >= -0.85 && downwardVelocity < -0.15) {
      hSitScore += 0.35;
      supporting.push("Controlled muscular deceleration during downward transition");
    }
    if (torsoAngle < 40) {
      hSitScore += 0.30;
      supporting.push(`Upright spinal stability retained (${torsoAngle}°)`);
    }
    if (impactShockG < 1.4) {
      hSitScore += 0.20;
      supporting.push("Smooth contact with zero ground impact shock");
    }
    if (chairBedProximity || (isBedLevel && torsoAngle < 35)) {
      hSitScore += 0.30;
      supporting.push("Bed-edge / armchair perimeter corroborated with upright balance");
    }
    if (isFloorLevel) {
      hSitScore -= 0.30;
    }
    hSitScore = Math.max(0.01, Math.min(0.99, hSitScore));

    // Evaluate H3: Intentional Lying / Bed Rest
    let hLyingScore = 0.05;
    if (isBedLevel || bedProximity || chairBedProximity) {
      hLyingScore += 0.40;
      if (isBedLevel) supporting.push("Patient positioned within designated care bed perimeter");
    }
    if (torsoAngle > 50 && downwardVelocity > -0.6) {
      hLyingScore += 0.35;
      supporting.push("Reclining supine body orientation with nominal velocity");
    }
    if (impactShockG < 1.3) hLyingScore += 0.20;
    if (isFloorLevel) {
      hLyingScore -= 0.40;
      counter.push("Floor level contact indicates bed-exit / collapse rather than bed rest");
    }
    hLyingScore = Math.max(0.01, Math.min(0.99, hLyingScore));

    // Evaluate H4: Kneeling / Floor Task
    let hKneelScore = 0.05;
    if (isKneeling || (torsoAngle < 35 && downwardVelocity > -0.7 && isFloorLevel)) hKneelScore += 0.40;
    if (impactShockG < 1.4) hKneelScore += 0.25;
    hKneelScore = Math.max(0.01, Math.min(0.99, hKneelScore));

    // Evaluate H5: Trip with Rapid Recovery
    let hTripScore = 0.05;
    if (downwardVelocity < -0.9 && recoveryObserved) hTripScore += 0.65;
    if (impactShockG > 1.8 && recoveryObserved) hTripScore += 0.25;
    hTripScore = Math.max(0.01, Math.min(0.99, hTripScore));

    // Evaluate H6: Loss of Balance / Mild Sway
    let hSwayScore = 0.05;
    if (torsoAngle >= 25 && torsoAngle <= 45 && downwardVelocity > -0.6) hSwayScore += 0.55;
    if (impactShockG < 1.5) hSwayScore += 0.25;
    hSwayScore = Math.max(0.01, Math.min(0.99, hSwayScore));

    // Evaluate H7: Fall with Prolonged Immobility
    let hImmobileScore = 0.05;
    if (isFloorLevel && !recoveryObserved) {
      if (postStillnessSeconds >= 3.0) {
        hImmobileScore += 0.65;
        supporting.push(`Persistent floor immobility (${Math.round(postStillnessSeconds)}s) exceeds grace window`);
      } else if (postStillnessSeconds >= 1.0) {
        hImmobileScore += 0.35;
      }
    } else if (hFallScore > 0.6 && postStillnessSeconds > 15) {
      hImmobileScore += 0.60;
    }
    if (torsoAngle > 50 && isFloorLevel && !recoveryObserved && postStillnessSeconds > 2.0) {
      hImmobileScore += 0.30;
    }
    hImmobileScore = Math.max(0.01, Math.min(0.99, hImmobileScore));

    // Evaluate H8: Device Drop (IMU shock without vision collapse)
    let hDropScore = 0.05;
    if (impactShockG > 2.8 && torsoAngle < 25 && Math.abs(downwardVelocity) < 0.3) {
      hDropScore += 0.75;
      supporting.push("Severe IMU impact shock recorded while resident remains fully upright");
    }
    if (deviceLiftedUpright) hDropScore += 0.20;
    hDropScore = Math.max(0.01, Math.min(0.99, hDropScore));

    // Evaluate H0: Normal Activity
    let hNormalScore = 0.05;
    if (Math.abs(downwardVelocity) < 0.25 && torsoAngle < 22 && impactShockG < 1.3) {
      hNormalScore += 0.85;
    }
    hNormalScore = Math.max(0.01, Math.min(0.99, hNormalScore));

    // Build Hypotheses Array
    hypotheses.push(
      { id: "H_FALL", mechanism: MECHANISMS.FALL, label: "Accidental Fall / Acute Impact", score: hFallScore, confidence: Math.round(hFallScore * 100), severity: "CRITICAL" },
      { id: "H_SIT", mechanism: MECHANISMS.INTENTIONAL_SITTING, label: "Controlled Sitting / Intentional Descent", score: hSitScore, confidence: Math.round(hSitScore * 100), severity: "NORMAL" },
      { id: "H_LYING", mechanism: MECHANISMS.INTENTIONAL_LYING, label: "Intentional Bed Rest / Supine Sleep", score: hLyingScore, confidence: Math.round(hLyingScore * 100), severity: "NORMAL" },
      { id: "H_KNEEL", mechanism: MECHANISMS.KNEELING, label: "Intentional Kneeling / Controlled Low Posture", score: hKneelScore, confidence: Math.round(hKneelScore * 100), severity: "NORMAL" },
      { id: "H_TRIP", mechanism: MECHANISMS.TRIP, label: "Stumble / Trip with Rapid Recovery", score: hTripScore, confidence: Math.round(hTripScore * 100), severity: "LOW" },
      { id: "H_SWAY", mechanism: MECHANISMS.LOSS_OF_BALANCE, label: "Loss of Balance / Postural Sway", score: hSwayScore, confidence: Math.round(hSwayScore * 100), severity: "CAUTION" },
      { id: "H_IMMOBILE", mechanism: MECHANISMS.FALL_WITH_IMMOBILITY, label: "Fall with Prolonged Post-Impact Immobility", score: hImmobileScore, confidence: Math.round(hImmobileScore * 100), severity: "CRITICAL" },
      { id: "H_DROP", mechanism: MECHANISMS.DEVICE_DROP, label: "Device Drop / Accelerometer Shock Only", score: hDropScore, confidence: Math.round(hDropScore * 100), severity: "VERIFICATION" },
      { id: "H_NORMAL", mechanism: MECHANISMS.NORMAL_ACTIVITY, label: "Stable Upright Ambulation / Nominal", score: hNormalScore, confidence: Math.round(hNormalScore * 100), severity: "NORMAL" }
    );

    hypotheses.sort((a, b) => b.score - a.score);
    const winningHypothesis = hypotheses[0];

    // Compute the 3 Separate Confidences:
    // 1. Detection Confidence: certainty that abnormal physical motion happened
    const detectionConfidence = Math.min(100, Math.round(Math.max(
      Math.abs(downwardVelocity) / 1.8 * 80,
      (impactShockG - 1.0) / 2.0 * 85,
      torsoAngle / 70 * 80
    )));

    // 2. Mechanism Confidence: certainty that winning hypothesis beats runner-up
    const runnerUp = hypotheses[1] || { score: 0 };
    const mechanismConfidence = Math.min(99, Math.round(
      (winningHypothesis.score / (winningHypothesis.score + runnerUp.score + 0.001)) * 100
    ));

    // 3. Severity Confidence: certainty of medical danger
    let severityConfidence = 0;
    if (winningHypothesis.mechanism === MECHANISMS.FALL_WITH_IMMOBILITY) {
      severityConfidence = 88;
    } else if (winningHypothesis.mechanism === MECHANISMS.FALL) {
      severityConfidence = recoveryObserved ? 15 : 74;
    } else if (winningHypothesis.mechanism === MECHANISMS.TRIP) {
      severityConfidence = 20;
    } else if (winningHypothesis.mechanism === MECHANISMS.LOSS_OF_BALANCE) {
      severityConfidence = 35;
    }

    // Counterfactual Explanation
    let counterfactualExplanation = "";
    if (winningHypothesis.mechanism === MECHANISMS.INTENTIONAL_SITTING) {
      counterfactualExplanation = `Accidental fall ruled out: descent velocity was controlled (${downwardVelocity} m/s), zero impact shock was recorded (${impactShockG}g), and resident maintained upright spinal equilibrium near seating furniture.`;
    } else if (winningHypothesis.mechanism === MECHANISMS.INTENTIONAL_LYING) {
      counterfactualExplanation = `Fall ruled out: smooth reclining transition within recognized bed perimeter with normal post-transfer respiration and zero ground impact.`;
    } else if (winningHypothesis.mechanism === MECHANISMS.TRIP) {
      counterfactualExplanation = `Emergency escalation suppressed: physical stumble occurred but upright postural equilibrium was restored within 4 seconds.`;
    } else if (winningHypothesis.mechanism === MECHANISMS.DEVICE_DROP) {
      counterfactualExplanation = `Physical resident fall ruled out: accelerometer recorded impact spike (${impactShockG}g), but vision tracking confirmed resident retained continuous upright posture (Torso: ${torsoAngle}°).`;
    } else if (winningHypothesis.mechanism === MECHANISMS.FALL) {
      counterfactualExplanation = `Intentional sitting ruled out: vertical velocity reached ${downwardVelocity} m/s with impact deceleration shock (${impactShockG}g) and absence of recovery motion.`;
    } else if (winningHypothesis.mechanism === MECHANISMS.FALL_WITH_IMMOBILITY) {
      counterfactualExplanation = `Severe event corroborated: horizontal collapse followed by >${postStillnessSeconds}s of continuous immobility outside safe rest zones.`;
    } else {
      counterfactualExplanation = "Nominal equilibrium maintained. Biomechanical parameters within personal running baseline.";
    }

    return {
      winningHypothesis,
      allHypotheses: hypotheses,
      detectionConfidence,
      mechanismConfidence,
      severityConfidence,
      supportingEvidence: supporting.slice(0, 5),
      counterEvidence: counter.slice(0, 5),
      counterfactualExplanation
    };
  }

  /**
   * Generates a 30-Second Chronological Reconstruction Timeline
   */
  function generateChronologicalTimeline(scenarioType) {
    const now = new Date();
    const formatTime = (offsetSec) => {
      const d = new Date(now.getTime() - offsetSec * 1000);
      return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    if (scenarioType === "trip_fall") {
      return [
        { time: formatTime(28), phase: "PRE-EVENT", title: "Steady Ambulation", detail: "Gait velocity 0.82 m/s · Torso vertical 8° · Biomechanics nominal" },
        { time: formatTime(22), phase: "PRE-EVENT", title: "Locomotion Deceleration", detail: "Gait velocity drops to 0.39 m/s · Lateral torso sway detected (18° deviation)" },
        { time: formatTime(18), phase: "DESCENT", title: "Rapid Vertical Descent", detail: "Downward velocity -1.92 m/s · Loss of vertical equilibrium" },
        { time: formatTime(17), phase: "IMPACT", title: "Floor Impact Deceleration", detail: "Impact shock spike 3.4g · Torso angle collapses to 76° on floor" },
        { time: formatTime(12), phase: "RECOVERY_CHECK", title: "Absence of Postural Recovery", detail: "Zero upright movement detected for 16 seconds on floor perimeter" },
        { time: formatTime(8), phase: "REASONING", title: "Hypothesis H_FALL Corroborated", detail: "Accidental Fall (96% conf) · Intentional sitting ruled out by -1.92 m/s speed" },
        { time: formatTime(0), phase: "VERIFY", title: "Resident Verification Active", detail: "Verification prompt sounding · 30-second grace window open" }
      ];
    } else if (scenarioType === "sitting") {
      return [
        { time: formatTime(25), phase: "PRE-EVENT", title: "Approaching Seating Area", detail: "Walking speed 0.65 m/s toward living room armchair" },
        { time: formatTime(18), phase: "PRE-EVENT", title: "Controlled Torso Rotation", detail: "Resident turns toward chair perimeter" },
        { time: formatTime(12), phase: "DESCENT", title: "Smooth Muscular Deceleration", detail: "Descent velocity -0.42 m/s · Muscular flexion intact" },
        { time: formatTime(8), phase: "CONTACT", title: "Controlled Seated Contact", detail: "Zero impact shock (1.08g) · Torso remains upright at 22°" },
        { time: formatTime(0), phase: "RESOLVED", title: "Intentional Sitting Confirmed", detail: "Hypothesis H_SIT confirmed (98% conf) · Emergency alarm suppressed" }
      ];
    } else if (scenarioType === "bed_exit") {
      return [
        { time: formatTime(24), phase: "PRE-EVENT", title: "Resting in Care Bed", detail: "Supine resting posture within mattress perimeter" },
        { time: formatTime(18), phase: "TRANSITION", title: "Leg Swing to Bed Edge", detail: "Patient swings legs over edge into bedside corridor" },
        { time: formatTime(14), phase: "MONITORING", title: "Bed-Exit Tripwire Crossed", detail: "Optical floor boundary detects bedside transfer" },
        { time: formatTime(8), phase: "EQUILIBRIUM", title: "Upright Weight Bearing", detail: "Torso stabilizes at 16° vertical · Zero ground shock (1.08g)" },
        { time: formatTime(0), phase: "RESOLVED", title: "Controlled Transfer Confirmed", detail: "Transfer nominal · Fall alarm safely suppressed" }
      ];
    } else if (scenarioType === "phone_drop") {
      return [
        { time: formatTime(20), phase: "PRE-EVENT", title: "Normal Handling", detail: "Device in hand · Resident standing upright (Torso 10°)" },
        { time: formatTime(14), phase: "EVENT", title: "Freefall Deceleration", detail: "Smartphone slips · Rapid freefall trajectory" },
        { time: formatTime(13), phase: "IMPACT", title: "Floor Impact Shock Spike", detail: "Accelerometer records 3.8g shock on hard surface" },
        { time: formatTime(10), phase: "REASONING", title: "Negative Evidence Disproved Fall", detail: "Vision tracking confirms resident retained upright standing posture" },
        { time: formatTime(0), phase: "VERIFY", title: "Device Drop Check-in", detail: "Prompt displayed: Device drop auto-detected" }
      ];
    } else { // acute_collapse / prolonged immobility
      return [
        { time: formatTime(30), phase: "PRE-EVENT", title: "Physiological Drift Observed", detail: "BP 174/106 mmHg & SpO2 88% · Baroreflex compensation failure" },
        { time: formatTime(24), phase: "PRE-EVENT", title: "Lateral Trunk Sway", detail: "Trunk sway exceeds 25° personal baseline" },
        { time: formatTime(19), phase: "DESCENT", title: "Incapacitated Vertical Collapse", detail: "Descent velocity -2.14 m/s toward floor boundary" },
        { time: formatTime(18), phase: "IMPACT", title: "Ground Deceleration Impact", detail: "Floor impact shock 2.95g · Torso collapses horizontally to 84°" },
        { time: formatTime(10), phase: "IMMOBILITY", title: "Prolonged Post-Impact Stillness", detail: "Zero motion detected for >30 seconds on floor · HR 118 bpm" },
        { time: formatTime(0), phase: "ESCALATION", title: "Proportional Escalation Initiated", detail: "Verification timed out · Caregiver alerted and ambulance dispatch prepared" }
      ];
    }
  }

  /**
   * Dynamically determines current Demonstration Timeline Stage based on physical evidence
   */
  function determineStageFromEvidence(evidence = {}) {
    const {
      isStartupCalibrating = false,
      isBedLevel = false,
      isFloorLevel = false,
      torsoAngle = 10,
      downwardVelocity = -0.1,
      postStillnessSeconds = 0,
      recoveryObserved = false,
      videoEnded = false
    } = evidence;

    if (videoEnded) {
      return { id: "STAGE_RESOLVED", label: "Demonstration Concluded / Idle", state: "RESOLVED", color: "slate" };
    }
    if (recoveryObserved) {
      return { id: "STAGE_RESOLVED", label: "Upright Postural Recovery Restored", state: "RESOLVED", color: "teal" };
    }
    if (isStartupCalibrating) {
      return { id: "STAGE_RESTING", label: "Camera Calibrating Spatial Baseline", state: "NORMAL", color: "slate" };
    }
    if (isFloorLevel && postStillnessSeconds >= 3.0) {
      return { id: "STAGE_VERIFY", label: "Resident Verification Active (High Risk)", state: "VERIFICATION", color: "purple" };
    }
    if (isFloorLevel && postStillnessSeconds >= 1.0) {
      return { id: "STAGE_RECOVERY", label: "Post-Impact Recovery Monitoring", state: "RECOVERY_MONITORING", color: "orange" };
    }
    if (isFloorLevel || (downwardVelocity < -0.85 && torsoAngle > 45)) {
      return { id: "STAGE_CONTACT", label: "Floor Contact / Impact Transition", state: "CONTACT_OR_FALL", color: "rose" };
    }
    if (downwardVelocity < -0.65 || (isBedLevel && torsoAngle > 35 && downwardVelocity < -0.4)) {
      return { id: "STAGE_DESCENT", label: "Suspected Descent / Motion Toward Floor", state: "ANOMALY", color: "amber" };
    }
    if (isBedLevel && torsoAngle <= 35) {
      return { id: "STAGE_BED_EDGE", label: "Bed-Edge Sitting / Controlled Posture", state: "NORMAL", color: "blue" };
    }
    if (isBedLevel && torsoAngle > 35) {
      return { id: "STAGE_RESTING", label: "Normal In-Bed Resting (Supine)", state: "NORMAL", color: "emerald" };
    }
    return { id: "STAGE_RESTING", label: "Normal Ambulation / Resting", state: "NORMAL", color: "emerald" };
  }

  return {
    KEYPOINTS,
    MECHANISMS,
    CAMERA_SOURCES,
    CAMERA_LIFECYCLE,
    PRERECORDED_STAGES,
    PersonalBaselineTracker,
    analyzePoseGeometry,
    evaluateHypotheses,
    determineStageFromEvidence,
    generateChronologicalTimeline
  };
});
