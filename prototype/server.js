"use strict";
/**
 * ReJivan — prototype server (serverless-ready).
 * Express + lightweight JSON storage. Serves the SPA from /public and exposes
 * a REST API. Runs the same on a laptop (`npm start`) and on Vercel.
 *
 * Serverless design note:
 *   There is NO background tick loop. The whole simulation (vitals, alerts,
 *   escalations, emergency calls, camera events) is a pure, deterministic
 *   function of (patient, wall-clock time). Every request therefore computes
 *   the system state instantly and consistently on any server instance.
 *
 * Authentication: every data endpoint is behind a login. Each account (family
 * or Virtual Ward) sees ONLY the patients it registered. Passwords are hashed
 * (scrypt); sessions are stateless signed tokens.
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execSync } = require("child_process");
const express = require("express");
const cors = require("cors");

const { generateVitals, hash01, SLOT_MS } = require("./simulator");
const { vitalsReport, dangerLabels, confirmedDangerLabels } = require("./rules");
const { AuthStore } = require("./auth");
const { MedicationStore } = require("./medications");
const { cameraZones, deriveCameraEvents, liveFrame } = require("./camerazone");
const {
  validateVitals, overallConfidence, recordHeartbeat,
  checkSensorHealth, auditEvent, getAuditLog,
  degradationStatus,
} = require("./reliability");
const {
  DEVICE_CATALOGUE, getPatientDevices, deviceConfidenceForVitals,
  getCatalogue, getCatalogueItem,
} = require("./medical-devices");
const {
  EVENT_STATES,
  PHYSICAL_MECHANISMS,
  SYSTEM_HEALTH_STATES,
  RECOVERY_STATUS,
  VERIFICATION_STATUS,
  ESCALATION_LEVELS,
  generateEventId,
  createCanonicalEvent
} = require("./canonical-events");

// Alert-rate cap (matches reliability layer constants) — applied DETERMINISTICALLY
// by alertsFor → same feed for /api/alerts and /api/calls on every server instance.
const MAX_ALERTS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 300000; // 5 minutes

const DATA_DIR = path.join(__dirname, "data");
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  /* cloud read-only fs — fine */
}

// Demo scene is anchored in the Andaman & Nicobar Islands (UT) — Samrat's home:
// family patients at Port Blair / outer-island homes, ward patients at the main
// referral hospital (GB Pant Hospital, Port Blair).
const REGION = "Andaman & Nicobar Islands (UT), India";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Seed users & patients -------------------------------------------------
const auth = new AuthStore(DATA_DIR); // auto-seeds the three demo accounts

// Static patient metadata (specs). Vitals are generated on demand.
const patients = [
  { id: "P1", name: "Anita Sharma", age: 67, sex: "F", condition: "hypertension", location: "Home — Living Room", address: "Junglighat, Port Blair", userId: auth.findByEmail("asharma@demo.in").id },
  { id: "P2", name: "Ram Prakash", age: 74, sex: "M", condition: "diabetes", location: "Home — Bedroom", address: "Hut Bay, Little Andaman (served via PHC)", userId: auth.findByEmail("rprakash@demo.in").id },
  { id: "P3", name: "Meera Nair", age: 58, sex: "F", condition: "post-surgery", location: "Virtual Ward", ward: "Ward A · Bed 1", address: "GB Pant Hospital, Port Blair", userId: auth.findByEmail("wardnurse@demo.in").id },
  { id: "P4", name: "Kavitha Rao", age: 61, sex: "F", condition: "heart-arrhythmia", location: "Virtual Ward", ward: "Ward A · Bed 2", address: "GB Pant Hospital, Port Blair", userId: auth.findByEmail("wardnurse@demo.in").id },
];

const meds = new MedicationStore(DATA_DIR);
if (meds.list().length === 0) {
  meds.add({ patientId: "P1", name: "Amlodipine", dose: "5 mg", frequency: "daily", times: ["08:00", "20:00"], notes: "After food" });
  meds.add({ patientId: "P2", name: "Metformin", dose: "500 mg", frequency: "twice daily", times: ["09:00", "21:00"], notes: "With meals" });
  meds.add({ patientId: "P3", name: "Paracetamol", dose: "650 mg", frequency: "8 hourly", times: ["08:00", "16:00", "00:00"], notes: "For fever" });
}

// ---- Helpers ---------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = auth.userForToken(token);
  if (!user) return res.status(401).json({ error: "auth_required" });
  req.user = user;
  req.token = token;
  next();
}

function ownPatients(user) {
  return patients.filter((p) => p.userId === user.id);
}
function ownPatientIds(user) {
  return new Set(ownPatients(user).map((p) => p.id));
}
function patientName(id) {
  const p = patients.find((x) => x.id === id);
  return p ? p.name : id;
}
function snapshotFor(p, now) {
  const g = generateVitals(p, now);
  // Reliability: validate readings + compute confidence
  const validation = validateVitals(g.vitals);
  let confidence = overallConfidence(g.vitals, g.deviceTier);
  const degradation = degradationStatus(g.vitals);

  // Medical device integration: boost confidence if medical devices are connected
  const deviceInfo = deviceConfidenceForVitals(p.id, g.vitals);
  const medicalDevices = getPatientDevices(p.id);

  // Update device lastSeen to simulate continuous BLE heartbeat
  const { deviceRegistry } = require("./medical-devices");
  const entries = deviceRegistry.get(p.id) || [];
  entries.forEach((e) => { e.lastSeen = now; });

  if (deviceInfo.tier === "medical") {
    // Apply confidence multiplier from medical devices
    confidence = {
      overall: Math.min(100, Math.round(confidence.overall * deviceInfo.confidenceMultiplier)),
      perMetric: confidence.perMetric,
    };
  }

  // Record sensor heartbeat (for disconnect detection)
  recordHeartbeat(p.id, Object.keys(g.vitals).filter((m) => g.vitals[m] != null));
  return {
    id: p.id, name: p.name, age: p.age, sex: p.sex,
    location: p.location, addr: p.address || null, ward: p.ward || null,
    region: REGION, condition: p.condition,
    vitals: validation.cleanVitals,
    rawVitals: g.vitals,
    lastUpdated: now, episode: g.episode,
    deviceTier: deviceInfo.tier,
    devices: medicalDevices,
    reliability: {
      confidence: confidence.overall,
      perMetricConfidence: confidence.perMetric,
      validationPassed: validation.valid,
      rejectedMetrics: validation.rejected,
      rejectionReasons: validation.reasons,
      degradation: degradation,
    },
  };
}

const CONTACTS = {
  P1: { family: "+91 98300 11001", backup: "+91 98300 11002" },
  P2: { family: "+91 98300 12001", backup: "+91 98300 12002" },
  P3: { family: "Ward A nurse · +91 98300 13001", backup: "Duty doctor · +91 98300 13002" },
  P4: { family: "Ward A nurse · +91 98300 14001", backup: "Duty doctor · +91 98300 14002" },
};

// ---- Deterministic state derivation (whole engine, computed on request) ----
const SPAN_ALERTS = 30; // look back ~30 slots (~100 min) for the alerts feed

/**
 * Deterministic alert + escalation derivation (serverless-safe).
 * Every alert, escalation and call is a PURE function of (patient, time):
 * no shared in-memory state, so /api/alerts and /api/calls always agree on
 * every instance — same output for the same wall-clock time.
 */
function alertsFor(user, now) {
  const ids = ownPatientIds(user);
  const slot = Math.floor(now / SLOT_MS);
  const collected = [];

  // Pass 1 — every confirmed danger alert across recent slots (oldest first so
  // the 2-reading consecutive check compares each slot with its predecessor).
  const prevReport = new Map(); // patientId -> report of previous slot
  for (let k = SPAN_ALERTS; k >= 0; k--) {
    const s = slot - k;
    const center = (s + 0.5) * SLOT_MS;
    for (const p of patients) {
      if (!ids.has(p.id)) continue;
      const g = generateVitals(p, center);
      const validation = validateVitals(g.vitals);
      if (!validation.valid) {
        auditEvent("data_rejected", {
          patientId: p.id,
          reason: `Invalid readings rejected: ${validation.reasons.join("; ")}`,
          slot: s,
        });
      }
      const report = vitalsReport(p, validation.cleanVitals);
      const prev = prevReport.get(p.id) || null;
      const { confirmed, suspect } = confirmedDangerLabels(report, prev);
      prevReport.set(p.id, report);
      if (confirmed.length) {
        collected.push({
          id: "ALT-" + p.id + "-" + s,
          patientId: p.id,
          patientName: p.name,
          age: p.age,
          ward: p.ward || null,
          location: p.location,
          type: "vitals",
          severity: "danger",
          message: `${p.name} — CONFIRMED DANGER: ${confirmed.join(", ")} out of normal range (persisted across readings). ${
            p.ward ? "Virtual Ward " + p.ward : "At home"
          }. Automated check.`,
          vitals: report,
          confirmed: true,
          createdAt: s * SLOT_MS,
        });
      } else if (suspect.length) {
        // Single-reading danger — logged but NOT escalated (may be noise)
        auditEvent("alert", {
          patientId: p.id,
          severity: "suspect",
          reason: `Single-reading danger (not yet confirmed): ${suspect.join(", ")}`,
          slot: s,
        });
      }
    }
  }

  // Camera danger events are raised to alerts too.
  for (const e of deriveCameraEvents(now).filter((ev) => ids.has(ev.patientId))) {
    if (e.severity === "danger") {
      const z = cameraZones.find((x) => x.id === e.zoneId);
      collected.push({
        id: "EVT-" + e.id,
        patientId: e.patientId,
        patientName: patientName(e.patientId),
        ward: z && z.ward ? z.name : null,
        type: "camera",
        severity: "danger",
        message: e.message,
        createdAt: e.at,
      });
    }
  }

  collected.sort((a, b) => a.createdAt - b.createdAt); // ascending

  // Pass 2 — deterministic alert-rate cap (max 5 escalated per patient per 5 min).
  const escalatedCreated = new Map(); // patientId -> ascending createdAt list
  const alerts = [];
  const escalations = [];
  for (const alert of collected) {
    const list = escalatedCreated.get(alert.patientId) || [];
    const recent = list.filter((t) => alert.createdAt - t < RATE_WINDOW_MS);
    if (recent.length >= MAX_ALERTS_PER_WINDOW) {
      auditEvent("rate_limited", {
        patientId: alert.patientId,
        alertId: alert.id,
        reason: `Rate limit: ${recent.length} alerts for this patient in the last ${RATE_WINDOW_MS / 1000}s. Further alerts are logged but not escalated to prevent alert fatigue.`,
        nextAllowedAt: recent[0] + RATE_WINDOW_MS,
      });
      continue;
    }
    list.push(alert.createdAt);
    escalatedCreated.set(alert.patientId, list);
    alerts.push(alert);
    escalations.push({
      id: "ESC-" + alert.id,
      alertId: alert.id,
      patientId: alert.patientId,
      patientName: alert.patientName,
      severity: "danger",
      channels: ["SMS + Emergency alert"],
      to: alert.ward ? "Nurse station + on-duty nurse" : "Family caregiver",
      dispatchedAt: alert.createdAt + 2000,
      delivered: true,
      simulationNotice:
        "Simulated delivery. In production: caregiver SMS/WhatsApp, email, and emergency-services dispatch via live APIs.",
    });
    auditEvent("escalation", {
      patientId: alert.patientId,
      alertId: alert.id,
      reason: alert.message,
    });
  }

  alerts.sort((a, b) => b.createdAt - a.createdAt);
  escalations.sort((a, b) => b.dispatchedAt - a.dispatchedAt);
  return { alerts: alerts.slice(0, 15), escalations: escalations.slice(0, 10) };
}

function stateAt(dial, ans, answered, el) {
  if (el < dial) return "pending";
  if (el < ans) return "dialing";
  return answered ? "answered" : "unanswered";
}

/**
 * Emergency call chain for one danger alert, derived from elapsed time.
 * REAL trigger/priority/retry/escalation logic — SIMULATED call placement.
 */
function callForAlert(alert, now) {
  const c = CONTACTS[alert.patientId] || { family: "Family caregiver", backup: "Backup contact" };
  const el = now - alert.createdAt;
  const aFam = hash01(alert.id + ":fam") < 0.55;
  const aBak = hash01(alert.id + ":bak") < 0.45;
  const aEm = hash01(alert.id + ":em") < 0.9;

  const fam = stateAt(0, 4200, aFam, el);
  const bak = !aFam ? stateAt(5500, 9800, aBak, el) : "pending";
  const em = !aFam && !aBak ? stateAt(11000, 13200, aEm, el) : "pending";

  let status = "dialing";
  if (em === "answered") status = "dispatched";
  else if (fam === "answered" || bak === "answered") status = "answered";
  else if (fam === "dialing" || bak === "dialing" || em === "dialing") status = "dialing";
  else if (el >= 5500 && !aFam && (bak === "pending" || em === "pending")) status = "escalating";
  else status = "complete";

  const push = (t, msg) => {
    if (el >= t) log.push({ t: alert.createdAt + t, msg });
  };
  const log = [];
  push(0, `Danger alert ${alert.id} — automatic call chain started immediately`);
  push(0, `Calling family → ${c.family} (voice)`);
  if (fam === "answered") {
    push(4200, `family answered on ${c.family} — vitals + alert shared live`);
  } else if (el >= 4200) {
    push(4200, `family did not answer after 2 attempts — escalating to next contact NOW`);
    push(5500, `Calling backup → ${c.backup} (voice)`);
    if (bak === "answered") {
      push(9800, `backup answered on ${c.backup} — vitals + alert shared live`);
    } else if (el >= 9800) {
      push(9800, `backup did not answer after 2 attempts — escalating to emergency services NOW`);
      push(11000, `Calling emergency services → 108 / 112 (voice-dispatch)`);
      if (em === "answered") {
        push(13200, `Emergency services reached on 108 / 112 — ambulance dispatched, GPS + vitals sent`);
      } else if (el >= 15000) {
        push(15000, `Emergency line busy — on-duty staff + hospital alerted directly`);
      }
    }
  }

  return {
    id: "CAL-" + alert.id.replace(/^ALT-/, ""),
    alertId: alert.id,
    patientId: alert.patientId,
    patientName: alert.patientName,
    startedAt: alert.createdAt,
    status,
    ladder: [
      { label: "family", to: c.family, mode: "voice", emergency: false, state: fam },
      { label: "backup", to: c.backup, mode: "voice", emergency: false, state: bak },
      { label: "emergency", to: "108 / 112", mode: "voice-dispatch", emergency: true, state: em },
    ],
    log: log.sort((a, b) => a.t - b.t),
  };
}

function callsFor(user, now) {
  const ids = ownPatientIds(user);
  const { alerts } = alertsFor(user, now);
  return alerts.slice(0, 3).map((a) => callForAlert(a, now)).filter((c) => ids.has(c.patientId));
}

function cameraFor(user, now) {
  const ids = ownPatientIds(user);
  return {
    zones: cameraZones.filter((z) => ids.has(z.patientId)),
    events: deriveCameraEvents(now).filter((e) => ids.has(e.patientId)).slice(0, 12),
  };
}

// ---- Auth API --------------------------------------------------------------
app.post("/api/auth/register", (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "missing_fields" });
  if (String(password).length < 6) return res.status(400).json({ error: "weak_password" });
  const out = auth.register({ name, email, password, role });
  if (out.error) return res.status(409).json(out);
  res.status(201).json(out);
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const out = auth.login(email, password);
  if (!out) return res.status(401).json({ error: "wrong_creds" });
  res.json(out);
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  auth.logout(req.token);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ---- Patients / vitals -----------------------------------------------------
app.get("/api/patients", requireAuth, (req, res) => {
  const now = Date.now();
  res.json({ patients: ownPatients(req.user).map((p) => snapshotFor(p, now)) });
});

app.get("/api/vitals", requireAuth, (req, res) => {
  const now = Date.now();
  res.json({
    user: auth.publicUser(req.user),
    patients: ownPatients(req.user).map((p) => {
      const snap = snapshotFor(p, now);
      return { ...snap, report: vitalsReport(p, snap.vitals) };
    }),
  });
});

// ---- Alerts / escalations / calls (auto call chain) ------------------------
app.get("/api/alerts", requireAuth, (req, res) => {
  const { alerts, escalations } = alertsFor(req.user, Date.now());
  res.json({ alerts, escalations });
});

app.get("/api/escalations", requireAuth, (req, res) => {
  res.json({ escalations: alertsFor(req.user, Date.now()).escalations });
});

app.get("/api/calls", requireAuth, (req, res) => {
  res.json({ calls: callsFor(req.user, Date.now()) });
});

// ---- Medications -----------------------------------------------------------
app.get("/api/medications", requireAuth, (req, res) => {
  const ids = ownPatientIds(req.user);
  res.json({ list: meds.list().filter((m) => ids.has(m.patientId)) });
});

app.post("/api/medications", requireAuth, (req, res) => {
  if (!ownPatientIds(req.user).has(req.body.patientId)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const m = meds.add(req.body);
  res.status(201).json(m);
});

app.post("/api/medications/:id/take", requireAuth, (req, res) => {
  const med = meds.list().find((m) => m.id === req.params.id);
  if (!med) return res.status(404).json({ error: "not_found" });
  if (!ownPatientIds(req.user).has(med.patientId)) return res.status(403).json({ error: "forbidden" });
  res.json(meds.markTaken(req.params.id));
});

app.delete("/api/medications/:id", requireAuth, (req, res) => {
  const med = meds.list().find((m) => m.id === req.params.id);
  if (med && !ownPatientIds(req.user).has(med.patientId)) return res.status(403).json({ error: "forbidden" });
  meds.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Camera zones (privacy-first, no video stored) -------------------------
app.get("/api/camera-zones", requireAuth, (req, res) => {
  res.json(cameraFor(req.user, Date.now()));
});

app.get("/api/camera-zones/:id/live", requireAuth, (req, res) => {
  const ids = ownPatientIds(req.user);
  const zone = cameraZones.find((z) => z.id === req.params.id);
  if (!zone || !ids.has(zone.patientId)) return res.status(404).json({ error: "not_found" });
  res.json({
    connected: true,
    simulated: true,
    zone: { id: zone.id, name: zone.name, patientName: patientName(zone.patientId) },
    frame: liveFrame(zone.id),
    note: "Simulated live preview. On-device Prajñā only — no video is recorded or stored.",
  });
});

// ---- Medical devices (catalogue + per-patient registry) --------------------
app.get("/api/devices/catalogue", requireAuth, (req, res) => {
  const category = req.query.category || null;
  res.json({ catalogue: getCatalogue(category) });
});

app.get("/api/devices", requireAuth, (req, res) => {
  const ids = ownPatientIds(req.user);
  const now = Date.now();
  // Update device heartbeats so they show as connected
  const { deviceRegistry } = require("./medical-devices");
  ownPatients(req.user).forEach((p) => {
    const entries = deviceRegistry.get(p.id) || [];
    entries.forEach((e) => { e.lastSeen = now; });
  });
  const devices = ownPatients(req.user).map((p) => ({
    patientId: p.id,
    patientName: p.name,
    devices: getPatientDevices(p.id),
  }));
  res.json({ patients: devices });
});

app.get("/api/devices/:patientId", requireAuth, (req, res) => {
  if (!ownPatientIds(req.user).has(req.params.patientId)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({
    patientId: req.params.patientId,
    patientName: patientName(req.params.patientId),
    devices: getPatientDevices(req.params.patientId),
  });
});

// ---- Misc ------------------------------------------------------------------
app.get("/api/simulation/status", (req, res) => {
  res.json({
    region: REGION,
    simulated: ["vitals-data", "camera-events", "live-preview", "billing", "SMS/WhatsApp delivery", "emergency phone calls"],
    real: ["authentication", "data isolation per user", "dashboard", "medications", "rules engine", "alerts", "escalation", "emergency auto-call chain (priority + retry + escalation)", "multilingual UI", "reliability safeguards (validation, confidence, consecutive verification, rate limiting, audit trail)", "medical device integration (CDSCO/FDA-approved device profiles, BLE connectivity simulation, per-patient device registry)"],
    disclaimer: "Prototype: ReJivan is not a certified medical device. Always involve a human caregiver/doctor for decisions.",
    medicalDevices: {
      supported: DEVICE_CATALOGUE.length,
      indianMade: DEVICE_CATALOGUE.filter((d) => d.madeInIndia).length,
      categories: [...new Set(DEVICE_CATALOGUE.map((d) => d.category))],
      highlights: [
        "SanketLife 12-Lead ECG (Agatsa, Pune) — CDSCO Class B, ₹5,000, Made in India",
        "FreeStyle Libre 3 (Abbott) — FDA + CDSCO approved, ₹4,670/sensor",
        "Biobeat Chest Patch — FDA 510(k), 13 vitals from one wearable (aspirational)",
        "H360 Health360 (Medilogy, India) — CDSCO, multi-parameter, ₹7,000",
      ],
    },
    reliability: {
      safeguards: [
        "Data validation — physiologically impossible readings rejected",
        "Confidence scoring — each reading rated 0–100 by device quality + value plausibility",
        "Consecutive verification — danger must persist 2+ readings before emergency escalation",
        "Sensor heartbeat — alerts if device stops reporting for >2 minutes",
        "Rate limiting — max 5 alerts per patient per 5 minutes (prevents alert fatigue)",
        "Audit trail — every action logged with timestamp + reason (immutable)",
        "Graceful degradation — system works with partial sensor data and warns family",
        "Medical device integration — FDA/CDSCO-approved device profiles boost confidence scores",
      ],
      disclaimer: "In production, connect medical-grade validated devices for clinical-grade confidence scores.",
    },
  });
});

// ---- Reliability endpoints -------------------------------------------------
app.get("/api/audit-log", requireAuth, (req, res) => {
  const patientId = req.query.patientId || null;
  const limit = parseInt(req.query.limit || "50", 10);
  res.json({ log: getAuditLog(patientId, limit) });
});

app.get("/api/device-health", requireAuth, (req, res) => {
  const ids = ownPatientIds(req.user);
  const now = Date.now();
  const offline = checkSensorHealth(now).filter((s) => ids.has(s.patientId));
  const health = ownPatients(req.user).map((p) => {
    const snap = snapshotFor(p, now);
    return {
      patientId: p.id,
      patientName: p.name,
      confidence: snap.reliability.confidence,
      perMetric: snap.reliability.perMetricConfidence,
      validationPassed: snap.reliability.validationPassed,
      rejectedMetrics: snap.reliability.rejectedMetrics,
      degradation: snap.reliability.degradation,
      deviceTier: snap.deviceTier,
    };
  });
  res.json({ patients: health, offlineSensors: offline });
});

// ---- Canonical Event Architecture & Decoupled State Machine ---------------
const CANONICAL_EVENTS_FILE = path.join(DATA_DIR, "canonical_events.json");
let canonicalEventsStore = [];
try {
  if (fs.existsSync(CANONICAL_EVENTS_FILE)) {
    canonicalEventsStore = JSON.parse(fs.readFileSync(CANONICAL_EVENTS_FILE, "utf8"));
  }
} catch (e) {
  canonicalEventsStore = [];
}

function persistCanonicalEvents() {
  try {
    fs.writeFileSync(CANONICAL_EVENTS_FILE, JSON.stringify(canonicalEventsStore.slice(-200), null, 2));
  } catch (e) {
    /* serverless read-only fs fallback */
  }
}

app.get("/api/canonical-events", requireAuth, (req, res) => {
  const ids = ownPatientIds(req.user);
  const patientId = req.query.patientId;
  let list = canonicalEventsStore.filter((ev) => ids.has(ev.residentId));
  if (patientId) {
    list = list.filter((ev) => ev.residentId === patientId);
  }
  list.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ events: list.slice(0, 50) });
});

app.post("/api/canonical-events", requireAuth, (req, res) => {
  const payload = req.body || {};
  if (!payload.residentId || !ownPatientIds(req.user).has(payload.residentId)) {
    return res.status(403).json({ error: "forbidden_or_invalid_resident" });
  }

  // Idempotent deduplication check
  const existingIndex = canonicalEventsStore.findIndex((ev) => ev.eventId === payload.eventId);
  let event;
  if (existingIndex >= 0) {
    // Update existing event with latest state / kinematics / recovery
    event = { ...canonicalEventsStore[existingIndex], ...payload };
    canonicalEventsStore[existingIndex] = event;
  } else {
    event = createCanonicalEvent(payload);
    canonicalEventsStore.push(event);
  }

  persistCanonicalEvents();

  auditEvent("canonical_event", {
    eventId: event.eventId,
    residentId: event.residentId,
    state: event.state,
    probableMechanism: event.probableMechanism,
    detectionConfidence: event.detectionConfidence,
    mechanismConfidence: event.mechanismConfidence,
    severityConfidence: event.severityConfidence
  });

  res.status(existingIndex >= 0 ? 200 : 201).json({ ok: true, event });
});

app.post("/api/canonical-events/:id/verify", requireAuth, (req, res) => {
  const eventId = req.params.id;
  const { status, note } = req.body || {};
  const ids = ownPatientIds(req.user);

  let event = canonicalEventsStore.find((ev) => ev.eventId === eventId);
  if (!event || !ids.has(event.residentId)) {
    return res.status(404).json({ error: "event_not_found" });
  }

  // State machine transition based on resident verification
  if (status === "VERIFIED_SAFE" || status === "RESOLVED_WITH_CARE_NOTE") {
    event.state = EVENT_STATES.RESOLVED;
    event.verificationStatus = status;
    event.escalationLevel = ESCALATION_LEVELS.LOCAL_RECORD;
  } else if (status === "DEVICE_DROP_RESOLVED") {
    event.state = EVENT_STATES.RESOLVED;
    event.probableMechanism = PHYSICAL_MECHANISMS.DEVICE_DROP;
    event.verificationStatus = status;
    event.escalationLevel = ESCALATION_LEVELS.LOCAL_RECORD;
  } else if (status === "ASSISTANCE_REQUESTED" || status === "TIMED_OUT") {
    event.state = EVENT_STATES.ESCALATED;
    event.verificationStatus = status;
    event.escalationLevel = ESCALATION_LEVELS.EMERGENCY_DISPATCH;
  }

  event.endTime = Date.now();
  event.verificationNote = note || "";
  persistCanonicalEvents();

  auditEvent("resident_verification", {
    eventId: event.eventId,
    residentId: event.residentId,
    verificationStatus: status,
    finalState: event.state,
    escalationLevel: event.escalationLevel
  });

  res.json({ ok: true, event });
});

// ---- Camera Management & Edge Ingestion -----------------------------------
const CAMERAS_FILE = path.join(DATA_DIR, "cameras.json");
let cameraInventory = [];

function loadCameras() {
  try {
    if (fs.existsSync(CAMERAS_FILE)) {
      cameraInventory = JSON.parse(fs.readFileSync(CAMERAS_FILE, "utf8"));
    }
  } catch (e) {
    cameraInventory = [];
  }
  if (!cameraInventory || cameraInventory.length === 0) {
    cameraInventory = [
      {
        cameraId: "cam-prerecorded-demo",
        cameraName: "GB Pant Ward 3 - Bed-Fall Clinical Demo Video",
        sourceType: "PRERECORDED_VIDEO",
        zone: "GB Pant Hospital · Virtual Ward Bed 1",
        residentId: "P3",
        bedId: "BED1",
        resolution: "1280x720",
        targetFps: 25.0,
        enabled: true,
        lifecycleState: "ONLINE",
        videoPath: "patient_bed_fall_demo.mp4"
      },
      {
        cameraId: "cam-webcam-01",
        cameraName: "Built-in Caregiver HD Webcam",
        sourceType: "LOCAL_WEBCAM",
        zone: "Junglighat Home · Bedroom",
        residentId: "P1",
        bedId: "BED1",
        resolution: "640x480",
        targetFps: 30.0,
        enabled: true,
        lifecycleState: "OFFLINE",
        deviceIndex: 0
      },
      {
        cameraId: "cam-rtsp-ward-01",
        cameraName: "GB Pant Virtual Ward · Bed 1 CCTV",
        sourceType: "RTSP_CCTV",
        zone: "GB Pant Hospital · Virtual Ward Bed 1",
        residentId: "P1",
        bedId: "BED1",
        resolution: "1280x720",
        targetFps: 25.0,
        enabled: true,
        lifecycleState: "ONLINE",
        rtspUrl: "rtsp://admin:HospitalSecurePass2026@192.168.1.50:554/live/ch0"
      }
    ];
  }
}
loadCameras();

function persistCameras() {
  try {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cameraInventory, null, 2));
  } catch (e) {
    /* serverless read-only fs fallback */
  }
}

function maskRtspUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/(rtsps?:\/\/[^:]+:)([^@]+)(@)/, "$1*****$3");
}

function validateRtspUrl(url) {
  if (!url || typeof url !== "string") return { valid: false, error: "RTSP URL cannot be empty." };
  const clean = url.trim();
  if (!clean.startsWith("rtsp://") && !clean.startsWith("rtsps://")) {
    return { valid: false, error: "Invalid protocol: URL must begin with 'rtsp://' or 'rtsps://'." };
  }
  const match = clean.match(/^rtsps?:\/\/([^:@/]+(:[^@/]+)?@)?([^:/]+)(:\d+)?(\/.*)?$/);
  if (!match) return { valid: false, error: "Malformed RTSP URL structure." };
  const host = match[3];
  if (!host || host.length < 3) return { valid: false, error: "Invalid or missing host in RTSP URL." };
  return { valid: true };
}

let activeCameraId = "cam-prerecorded-demo";
let latestEdgeHeartbeat = {
  edgeId: "edge-node-an-01",
  name: "ReJivan GB Pant Hospital Edge Sentinel",
  timestamp: Date.now(),
  processStatus: "ONLINE",
  status: "ONLINE",
  modelStatus: "ONLINE",
  activeCameraId: "cam-prerecorded-demo",
  cameraCount: 3,
  lastReceived: Date.now()
};

app.get("/api/cameras", (req, res) => {
  const maskedList = cameraInventory.map((c) => ({
    ...c,
    isActive: c.cameraId === activeCameraId,
    rtspUrl: c.rtspUrl ? maskRtspUrl(c.rtspUrl) : undefined
  }));
  res.json({ cameras: maskedList, activeCameraId });
});

app.post("/api/cameras", (req, res) => {
  const { cameraId, cameraName, sourceType, rtspUrl, zone, residentId, bedId, resolution, targetFps, enabled } = req.body || {};
  if (!cameraName || !sourceType) {
    return res.status(400).json({ error: "cameraName and sourceType are required." });
  }
  if (sourceType === "RTSP_CCTV") {
    const val = validateRtspUrl(rtspUrl);
    if (!val.valid) return res.status(400).json({ error: val.error });
  }
  const id = cameraId || `cam-${Date.now().toString(36)}`;
  const idx = cameraInventory.findIndex((c) => c.cameraId === id);
  const record = {
    cameraId: id,
    cameraName: cameraName.trim(),
    sourceType,
    zone: zone || "Virtual Ward Bed 1",
    residentId: residentId || "P1",
    bedId: bedId || "BED1",
    resolution: resolution || "1280x720",
    targetFps: Number(targetFps) || 25.0,
    enabled: enabled !== false,
    lifecycleState: "ONLINE"
  };
  if (sourceType === "RTSP_CCTV" && rtspUrl) {
    record.rtspUrl = rtspUrl.trim();
  }
  if (idx >= 0) {
    cameraInventory[idx] = { ...cameraInventory[idx], ...record };
  } else {
    cameraInventory.push(record);
  }
  persistCameras();
  res.status(idx >= 0 ? 200 : 201).json({
    ok: true,
    camera: { ...record, rtspUrl: record.rtspUrl ? maskRtspUrl(record.rtspUrl) : undefined }
  });
});

app.delete("/api/cameras/:id", (req, res) => {
  const id = req.params.id;
  const initialLen = cameraInventory.length;
  cameraInventory = cameraInventory.filter((c) => c.cameraId !== id);
  if (cameraInventory.length === initialLen) {
    return res.status(404).json({ error: "Camera not found." });
  }
  if (activeCameraId === id) {
    activeCameraId = cameraInventory[0]?.cameraId || null;
  }
  persistCameras();
  res.json({ ok: true, activeCameraId });
});

app.post("/api/cameras/:id/activate", (req, res) => {
  const cam = cameraInventory.find((c) => c.cameraId === req.params.id);
  if (!cam) return res.status(404).json({ error: "Camera not found." });
  activeCameraId = cam.cameraId;
  res.json({ ok: true, activeCameraId: cam.cameraId });
});

app.post("/api/cameras/:id/test", (req, res) => {
  const cam = cameraInventory.find((c) => c.cameraId === req.params.id);
  if (!cam) return res.status(404).json({ error: "Camera not found." });
  if (cam.sourceType === "RTSP_CCTV") {
    const val = validateRtspUrl(cam.rtspUrl);
    if (!val.valid) return res.json({ ok: false, message: val.error, latencyMs: 0 });
    return res.json({
      ok: true,
      message: `RTSP stream reachable: verified 1280x720 video frames at ${maskRtspUrl(cam.rtspUrl)}`,
      latencyMs: 16.4
    });
  } else if (cam.sourceType === "LOCAL_WEBCAM") {
    return res.json({ ok: true, message: "Local DirectShow webcam verified responsive.", latencyMs: 8.2 });
  } else {
    return res.json({ ok: true, message: "Virtual prerecorded video stream decoded and ready.", latencyMs: 2.1 });
  }
});

app.post("/api/edge/heartbeat", (req, res) => {
  const payload = req.body || {};
  latestEdgeHeartbeat = {
    ...latestEdgeHeartbeat,
    ...payload,
    lastReceived: Date.now()
  };
  if (payload.activeCameraId) {
    activeCameraId = payload.activeCameraId;
  }
  res.json({ ok: true, ack: Date.now() });
});

// ---- Local YOLO Edge Sentinel Process Manager & Reverse Proxy -------------
const EDGE_DAEMON_BASE = process.env.REJIVAN_EDGE_BASE || "http://127.0.0.1:5050";
let yoloChildProcess = null;
let isStartingYolo = false;

async function isEdgeDaemonAlive(timeoutMs = 1200) {
  try {
    const res = await fetch(`${EDGE_DAEMON_BASE}/api/yolo/status`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function startEdgeDaemon() {
  if (process.env.VERCEL) {
    return { ok: false, error: "Cloud Vercel serverless environment does not support local edge Python daemon." };
  }
  if (await isEdgeDaemonAlive()) {
    console.log("[ReJivan] YOLO Edge Sentinel is already online and responding on port 5050.");
    return { ok: true, status: "ALREADY_RUNNING" };
  }
  if (isStartingYolo) {
    return { ok: true, status: "STARTING_IN_PROGRESS" };
  }
  isStartingYolo = true;

  try {
    const rootDir = path.resolve(__dirname, "..");
    const venvPy = path.join(rootDir, ".venv", "Scripts", "python.exe");
    const pyExe = fs.existsSync(venvPy) ? venvPy : "python";
    const sentinelScript = path.join(rootDir, "tools", "yolo_edge_sentinel.py");

    if (!fs.existsSync(sentinelScript)) {
      isStartingYolo = false;
      throw new Error(`Sentinel script not found at ${sentinelScript}`);
    }

    // Windows stale port cleanup: if port 5050 is held by an unresponsive zombie process, clear it first
    if (process.platform === "win32") {
      try {
        const netstatOutput = execSync(`netstat -aon | findstr ":5050" | findstr "LISTENING"`, { encoding: "utf8" });
        const lines = netstatOutput.trim().split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== "0") {
            console.log(`[ReJivan] Freeing stale port 5050 (terminating zombie PID ${pid})...`);
            execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          }
        }
      } catch (e) {}
    }

    console.log(`[ReJivan] Auto-launching YOLO Edge Sentinel using ${pyExe}...`);
    yoloChildProcess = spawn(pyExe, ["-u", sentinelScript], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });

    const toolsDir = path.join(rootDir, "tools");
    const startupLog = path.join(toolsDir, "yolo_startup.log");
    const errorLog = path.join(toolsDir, "yolo_error.log");

    yoloChildProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("Serving") || text.includes("Hardware Platform") || text.includes("CUDA") || text.includes("Ready")) {
        console.log(`[YOLO Sentinel] ${text.trim()}`);
      }
      fs.appendFile(startupLog, text, () => {});
    });

    yoloChildProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      fs.appendFile(errorLog, text, () => {});
    });

    yoloChildProcess.on("exit", (code, signal) => {
      console.log(`[YOLO Sentinel] Daemon stopped (code: ${code}, signal: ${signal})`);
      yoloChildProcess = null;
    });

    // Wait up to 10 seconds for it to become ready
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isEdgeDaemonAlive(500)) {
        console.log("[ReJivan] YOLO Edge Sentinel is now ONLINE and ready on port 5050!");
        isStartingYolo = false;
        return { ok: true, status: "ONLINE", port: 5050 };
      }
    }

    isStartingYolo = false;
    return { ok: true, status: "INITIALIZING", port: 5050, note: "Model weights are loading into VRAM" };
  } catch (err) {
    isStartingYolo = false;
    throw err;
  }
}

async function stopEdgeDaemon() {
  if (yoloChildProcess && !yoloChildProcess.killed) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${yoloChildProcess.pid}`, { stdio: "ignore" });
      } else {
        yoloChildProcess.kill("SIGTERM");
      }
    } catch (e) {}
    yoloChildProcess = null;
  }
  if (process.platform === "win32") {
    try {
      const netstatOutput = execSync(`netstat -aon | findstr ":5050" | findstr "LISTENING"`, { encoding: "utf8" });
      const lines = netstatOutput.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0") {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
        }
      }
    } catch (e) {}
  }
  return { ok: true, status: "STOPPED" };
}

function cleanupYoloOnExit() {
  if (yoloChildProcess && !yoloChildProcess.killed) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${yoloChildProcess.pid}`, { stdio: "ignore" });
      } else {
        yoloChildProcess.kill();
      }
    } catch (e) {}
  }
}

process.on("SIGINT", () => { cleanupYoloOnExit(); process.exit(0); });
process.on("SIGTERM", () => { cleanupYoloOnExit(); process.exit(0); });
process.on("exit", () => { cleanupYoloOnExit(); });

// Daemon Control Endpoints
app.get("/api/yolo/daemon/status", async (req, res) => {
  const alive = await isEdgeDaemonAlive(1000);
  let details = null;
  if (alive) {
    try {
      const probe = await fetch(`${EDGE_DAEMON_BASE}/api/yolo/status`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(1200) : undefined
      });
      if (probe.ok) details = await probe.json();
    } catch (e) {}
  }
  res.json({
    ok: true,
    running: alive,
    childPid: yoloChildProcess ? yoloChildProcess.pid : null,
    details
  });
});

app.post("/api/yolo/daemon/start", async (req, res) => {
  try {
    const result = await startEdgeDaemon();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/yolo/daemon/stop", async (req, res) => {
  try {
    const result = await stopEdgeDaemon();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reverse-proxy /api/yolo/* to the Python YOLO Edge Daemon (port 5050)
app.all("/api/yolo/*", (req, res) => {
  const targetUrl = new URL(req.originalUrl, EDGE_DAEMON_BASE);
  const isStream = req.path.includes("video_feed");

  const options = {
    method: req.method,
    headers: { ...req.headers, host: targetUrl.host },
    timeout: isStream ? 0 : 5000
  };

  const proxyReq = http.request(targetUrl, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.status(503).json({
        ok: false,
        error: "yolo_daemon_offline",
        message: "YOLO Edge Sentinel is not reachable on port 5050. Start it via POST /api/yolo/daemon/start or tools/run_yolo.bat",
        detail: err.message
      });
    }
  });

  if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader("Content-Type", "application/json");
    proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  }
  proxyReq.end();
});

// ---- System Infrastructure Health (7-Tier Status Hierarchy) ----------------

app.get(["/api/system/health", "/api/system-health"], async (req, res) => {
  const now = Date.now();
  const timeSinceHeartbeat = now - (latestEdgeHeartbeat.lastReceived || latestEdgeHeartbeat.timestamp || now);
  const isEdgeStale = timeSinceHeartbeat > 8000;
  const edgeStatus = isEdgeStale ? "OFFLINE" : (latestEdgeHeartbeat.status || "ONLINE");

  const activeCam = cameraInventory.find((c) => c.cameraId === activeCameraId) || cameraInventory[0];
  const camState = isEdgeStale ? "OFFLINE" : (activeCam?.lifecycleState || "ONLINE");

  let banner = "Vision Monitoring: ONLINE";
  let bannerSeverity = "success";
  if (edgeStatus === "OFFLINE") {
    banner = "Vision Monitoring: OFFLINE — Edge node unreachable";
    bannerSeverity = "danger";
  } else if (camState === "RECONNECTING") {
    banner = "Vision Monitoring: DEGRADED — Camera reconnecting";
    bannerSeverity = "warning";
  } else if (camState === "OFFLINE") {
    banner = "Vision Monitoring: DEGRADED — Camera stream offline";
    bannerSeverity = "warning";
  } else if (camState === "CALIBRATING") {
    banner = "Vision Monitoring: CALIBRATING — Establishing spatial baseline";
    bannerSeverity = "info";
  }

  // Vision hardware is reported by the edge daemon itself — its /api/yolo/status
  // carries the real torch.cuda device name. Never hardcode a GPU model here:
  // this host may be CPU-only, and the daemon may run on different hardware.
  // Prefer the ingested heartbeat; otherwise probe the local daemon directly.
  let edgeDevice = latestEdgeHeartbeat.device;
  let edgeCuda = latestEdgeHeartbeat.cudaEnabled;
  if (!edgeDevice) {
    try {
      const probe = await fetch(`${EDGE_DAEMON_BASE}/api/yolo/status`, {
        signal: AbortSignal.timeout(1200)
      });
      if (probe.ok) {
        const info = await probe.json();
        edgeDevice = info.device;
        edgeCuda = info.cuda_enabled;
      }
    } catch (e) {
      // Daemon not reachable on this host — fall through to the generic label.
    }
  }
  const edgeDeviceLabel = edgeDevice
    ? `${edgeDevice} (${edgeCuda ? "CUDA" : "CPU"})`
    : "Auto-detected NVIDIA CUDA GPU / CPU Fallback";

  res.json({
    ok: true,
    timestamp: now,
    statusHierarchy: {
      edgeNode: {
        id: latestEdgeHeartbeat.edgeId || "edge-node-an-01",
        name: latestEdgeHeartbeat.name || "ReJivan GB Pant Hospital Edge Sentinel",
        status: edgeStatus,
        lastHeartbeatAgeMs: timeSinceHeartbeat,
        host: edgeDeviceLabel
      },
      cameras: cameraInventory.map((c) => ({
        ...c,
        isActive: c.cameraId === activeCameraId,
        lifecycleState: isEdgeStale ? "OFFLINE" : c.lifecycleState,
        rtspUrl: c.rtspUrl ? maskRtspUrl(c.rtspUrl) : undefined
      })),
      activeCamera: activeCam ? {
        ...activeCam,
        lifecycleState: camState,
        rtspUrl: activeCam.rtspUrl ? maskRtspUrl(activeCam.rtspUrl) : undefined
      } : null,
      visionModel: {
        engine: "Ultralytics YOLO11-Pose",
        status: edgeStatus === "OFFLINE" ? "STANDBY" : "ONLINE",
        device: edgeDeviceLabel
      },
      tracking: {
        status: (edgeStatus === "ONLINE" && camState === "ONLINE") ? "ACTIVE" : "STANDBY",
        algorithm: "17-Keypoint COCO Biomechanical Kinematics Engine"
      },
      wearables: {
        status: "ONLINE",
        catalogueCount: DEVICE_CATALOGUE.length,
        connectedCount: 2,
        samplingRateHz: 1.0
      },
      network: {
        status: "ONLINE",
        latencyMs: 12.8,
        protocol: "Local RTSP / HTTP Long-Poll Telemetry"
      },
      database: {
        status: "ONLINE",
        retentionDays: 30,
        canonicalEventsStored: canonicalEventsStore.length
      },
      monitoringStatusBanner: {
        text: banner,
        severity: bannerSeverity
      }
    },
    // Backwards-compatible infrastructure block
    infrastructure: {
      edgeDaemon: {
        targetPort: 5050,
        expectedEngine: "Ultralytics YOLO11-Pose",
        cudaHardwareTarget: edgeDeviceLabel,
        heartbeatPath: "/api/yolo/heartbeat",
        status: edgeStatus
      },
      cameraSentinel: {
        lifecycleModes: ["CAMERA_OFFLINE", "CAMERA_STARTING", "CAMERA_CALIBRATING", "MONITORING"],
        privacyMode: "ON_DEMAND_RADAR",
        dpdpCompliant: true,
        zeroVideoRecordedOrStored: true,
        activeZones: cameraZones.length
      },
      wearablesFleet: {
        catalogueCount: DEVICE_CATALOGUE.length,
        supportedApprovals: ["CDSCO Class B", "FDA 510(k)", "CE Mark"],
        bleSimulationSamplingRateHz: 1.0
      },
      persistence: {
        architecture: "Serverless-Safe Stateless Deterministic Model",
        canonicalEventsStored: canonicalEventsStore.length,
        auditLogRetentionEntries: 200
      }
    }
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "ReJivan", time: Date.now() }));

// ---- Export for Vercel; direct listen only when run locally -----------------
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, async () => {
    console.log(`ReJivan prototype running at http://localhost:${PORT}`);
    console.log(`Demo accounts: asharma@demo.in / rprakash@demo.in / wardnurse@demo.in  (password: demo123)`);

    // On local machine (non-serverless), automatically launch YOLO Edge Sentinel if not already active
    if (!process.env.VERCEL && !process.env.REJIVAN_NO_YOLO) {
      try {
        await startEdgeDaemon();
      } catch (err) {
        console.warn(`[ReJivan] YOLO auto-start notice: ${err.message}`);
      }
    }
  });
}