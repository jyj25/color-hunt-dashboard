"use strict";
/* 가위바위보 대시보드.
 * 웹캠 + MediaPipe Hands(브라우저)로 내 손을 읽고, UNO(RPS 펌웨어)가 두 손을 받아 승패를 직접 판정한다.
 *   🟢 초록 = 이김 · 🔴 빨강 = 짐(시간 초과 포함) · 🟡 노랑 = 비김
 * 흐름: 상대 손이 빠르게 돌아간다 → "가위… 바위…" → "보!" → 3초 안에 내 손 확정 → 동시에 공개.
 * 서버 없이 정적 배포(GitHub Pages)로 동작한다. 보드는 Web Serial, 장치가 없으면 데모 모드.
 */
const $ = (id) => document.getElementById(id);
const PAGE = document.body.dataset.page || ""; // "game" | "setup" | "a11y"
/**
 * <summary>예상 못 한 오류를 안내 띠에 바로 보여 준다</summary>
 * <param name="e">오류 객체 또는 문구</param>
 * <reason>콘솔을 열지 않아도 어떤 오류인지 알 수 있게 하려고</reason>
 */
function showFatal(e)
{
    const b = document.getElementById("banner");
    if (b)
    {
        b.hidden = false;
        b.classList.add("err");
        b.textContent = "화면 오류: " + ((e && e.message) || e) + " — Ctrl+F5로 새로고침해 보세요. 계속되면 설정의 '기록 지우기'를 누르세요.";
    }
}
window.addEventListener("error", (ev) => showFatal(ev.error || ev.message));
window.addEventListener("unhandledrejection", (ev) => showFatal(ev.reason));
const setBtn = (id, text) => { const b = $(id); if (b) { b.textContent = text; } };
const HANDS = {
  rock:     { ko: "바위", icon: "✊" },
  scissors: { ko: "가위", icon: "✌️" },
  paper:    { ko: "보",   icon: "✋" },
};
const NAMES = Object.keys(HANDS);
const BEATS = { rock: "scissors", scissors: "paper", paper: "rock" }; // 키가 값을 이긴다
const OUTCOME = {
  win:     { ko: "이김",      sym: "✔", led: 3, pts: 3, lamp: "🟢 초록" },
  draw:    { ko: "비김",      sym: "＝", led: 2, pts: 1, lamp: "🟡 노랑" },
  lose:    { ko: "짐",        sym: "✘", led: 1, pts: 0, lamp: "🔴 빨강" },
  timeout: { ko: "시간 초과", sym: "⏱", led: 1, pts: 0, lamp: "🔴 빨강" },
};
const SIGNAL_TEXT = { 0: "⚫ 꺼짐", 1: "🔴 빨강 (짐)", 2: "🟡 노랑 (비김)", 3: "🟢 초록 (이김)" };
const ALLOWED = /^(STATUS|PING|STOP|SIGNAL [0-3]|JUDGE [0-3] [0-2])$/;
const IDX = { scissors: 0, rock: 1, paper: 2 };            // JUDGE 인수: 가위0 바위1 보2, 내 손 3 = 못 냄
const RESULT_KO = { win: "이김", draw: "비김", lose: "짐", timeout: "시간 초과" };
const HOLD_MS = 400, STEP_MS = 600, RESULT_MS = 2200, SPIN_MS = 110, BGM_MS = 2400;
const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 공용 상태 ---------- */
const hub = {
  demo: false,
  camera: { ok: false, error: "웹캠을 켜지 않았습니다" }, cameraAt: 0,
  model: "idle", modelError: null,            // idle | loading | ready | error
  gesture: null, handSeen: false,             // rock|scissors|paper|"unknown"|null
  board: null, boardAt: 0, boardError: null,
  acks: [], lastCmd: null, request: 9,
};
function say(msg) { const el = $("live"); el.textContent = ""; setTimeout(() => (el.textContent = msg), 50); }
function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }

/* ---------- 보드 통신 (Web Serial) ---------- */
let port = null, writer = null;
async function sendCommand(cmd) {
  if (!ALLOWED.test(cmd)) return { ok: false, error: "허용되지 않는 명령" };
  let res;
  hub.request = hub.request < 65535 ? hub.request + 1 : 10;
  if (hub.demo) {
    if (cmd.startsWith("JUDGE")) { // 데모: 보드 펌웨어와 같은 계산
      const [m, o] = cmd.split(" ").slice(1).map(Number), d = (m + 3 - o) % 3, r = m === 3 ? "timeout" : d === 1 ? "win" : d === 0 ? "draw" : "lose";
      hub.board = { ...(hub.board || {}), signal: r === "win" ? 3 : r === "draw" ? 2 : 1, result: r, last_key: (hub.board || {}).last_key ?? "-" }; hub.boardAt = performance.now();
    }
    if (cmd.startsWith("SIGNAL")) { hub.board = { ...(hub.board || {}), signal: +cmd.split(" ")[1], last_key: (hub.board || {}).last_key ?? "-" }; hub.boardAt = performance.now(); }
    hub.acks = [...hub.acks, { type: "ack", request: hub.request, applied: true }].slice(-8);
    res = { ok: true, request: hub.request };
  } else if (writer) {
    try { await writer.write(new TextEncoder().encode(`${hub.request} ${cmd}\n`)); res = { ok: true, request: hub.request }; }
    catch (e) { res = { ok: false, error: "전송 실패: " + e.message }; }
  } else res = { ok: false, error: "보드가 연결되어 있지 않습니다" };
  hub.lastCmd = { cmd, request: res.request ?? null, at: performance.now(), stage: res.ok ? "sent" : "fail", error: res.error };
  return res;
}
async function connectSerial(known) {
  if (!("serial" in navigator)) { hub.boardError = "이 브라우저는 Web Serial을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요."; return; }
  try { port = known || await navigator.serial.requestPort(); await port.open({ baudRate: 115200 }); }
  catch (e) { hub.boardError = e.name === "NotFoundError" ? "포트를 선택하지 않았습니다" : "포트를 열 수 없습니다: " + e.message + " (시리얼 모니터가 열려 있으면 닫으세요)"; port = null; return; }
  hub.boardError = null; writer = port.writable.getWriter(); setBtn("btn-serial", "UNO 연결 해제");
  say("UNO 포트를 열었습니다. 2초 뒤 상태를 확인합니다.");
  readLoop(port); setTimeout(() => sendCommand("STATUS"), 2000); // 연결 직후 UNO 재시작 대기
}
async function readLoop(p) {
  const dec = new TextDecoder(); let buf = "";
  try {
    const reader = p.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      if (buf.length > 2000) buf = "";
    }
  } catch (e) { hub.boardError = "보드 연결이 끊겼습니다: " + e.message; }
  port = null; writer = null; setBtn("btn-serial", "UNO 연결");
}
function handleLine(line) {
  let m; try { m = JSON.parse(line); } catch (e) { return; }
  if (m.type === "state") { hub.board = m; hub.boardAt = performance.now(); }
  else if (m.type === "ack" || m.type === "error") hub.acks = [...hub.acks, m].slice(-8);
}
async function disconnectSerial() {
  try { if (writer) { await sendCommand("SIGNAL 0"); writer.releaseLock(); } if (port) await port.close(); } catch (e) { /* 이미 닫힘 */ }
  writer = null; port = null; hub.board = null; setBtn("btn-serial", "UNO 연결");
}

/* ---------- 웹캠 + 손 인식 ---------- */
let vid, overlay, octx, landmarker = null, camTimer = null, lastVideoTime = -1;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function classify(lm) { // 손목에서 손끝이 중간마디보다 멀면 "펴짐". 손 방향이 달라도 동작한다. 엄지는 쓰지 않는다.
  const w = lm[0];
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => dist(lm[tip], w) > dist(lm[pip], w) * 1.15);
  const n = ext.filter(Boolean).length;
  if (n === 0) return "rock";
  if (n === 4) return "paper";
  if (ext[0] && ext[1] && !ext[2] && !ext[3]) return "scissors";
  return "unknown";
}
async function loadModel() {
  if (hub.model === "loading" || hub.model === "ready") return;
  hub.model = "loading"; hub.modelError = null; hub.modelStart = performance.now();
  try {
    const { HandLandmarker, FilesetResolver } = await import(`${VISION}/+esm`);
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    for (const delegate of ["GPU", "CPU"]) {
      try { landmarker = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numHands: 1 }); break; }
      catch (e) { if (delegate === "CPU") throw e; }
    }
    hub.model = "ready"; say("손 인식 준비가 끝났습니다.");
  } catch (e) { hub.model = "error"; hub.modelError = "손 인식 모델을 불러오지 못했습니다 (인터넷 연결 확인): " + e.message; }
}
function drawHand(lm) {
  octx.clearRect(0, 0, overlay.width, overlay.height); if (!lm) return;
  octx.fillStyle = "#fff"; octx.strokeStyle = "#000"; octx.lineWidth = 2;
  for (const p of lm) { octx.beginPath(); octx.arc(p.x * overlay.width, p.y * overlay.height, 5, 0, 7); octx.fill(); octx.stroke(); }
}
function detect() {
  if (!vid || vid.readyState < 2) { return; }
  hub.camera = { ok: true, error: null }; hub.cameraAt = performance.now(); // 영상이 나오면 웹캠은 정상(손 인식 모델 준비와 별개)
  if (!landmarker || vid.currentTime === lastVideoTime) { return; }
  lastVideoTime = vid.currentTime;
  if (overlay.width !== vid.videoWidth) { overlay.width = vid.videoWidth; overlay.height = vid.videoHeight; }
  const r = landmarker.detectForVideo(vid, performance.now()), lm = r.landmarks && r.landmarks[0];
  hub.handSeen = !!lm; hub.gesture = lm ? classify(lm) : null; drawHand(lm);
}
async function startCameraOnce() {
  vid = $("vid"); overlay = $("overlay"); octx = overlay.getContext("2d");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hub.camera = { ok: false, error: "이 브라우저/주소에서는 웹캠을 쓸 수 없습니다 (https 필요)" }; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    vid.srcObject = stream; await vid.play(); vid.hidden = false; overlay.hidden = false;
    hub.camera = { ok: true, error: null }; hub.cameraAt = performance.now();
    camTimer = setInterval(detect, 60); setBtn("btn-cam", "웹캠 끄기"); say("웹캠이 켜졌습니다. 손 인식 모델을 불러옵니다.");
    loadModel();
  } catch (e) {
    hub.camera = { ok: false, error: e.name === "NotAllowedError" ? "웹캠 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 허용하세요." : "웹캠을 열 수 없습니다: " + e.message };
  }
}
let camStarting = false;

/**
 * <summary>웹캠을 켠다. 이미 켜는 중이면 무시하고, 다른 페이지가 막 놓아준 카메라처럼 잠깐 못 여는 경우는 최대 3번 다시 시도한다</summary>
 * <reason>페이지를 옮긴 직후나 자동 연결과 버튼 클릭이 겹치면 첫 시도가 실패하거나 서로 영상을 끊을 수 있어서</reason>
 */
async function startCamera()
{
    if (camStarting || camTimer)
    {
        return;
    }
    camStarting = true;
    try
    {
        for (let attempt = 1; attempt <= 3 && !camTimer; attempt++)
        {
            await startCameraOnce();
            const retryable = hub.camera.error && hub.camera.error.includes("열 수 없습니다");
            if (camTimer || !retryable)
            {
                break;
            }
            await new Promise((r) => setTimeout(r, 1200));
        }
    }
    finally
    {
        camStarting = false;
    }
}

/**
 * <summary>웹캠 켜기/끄기 버튼: 켜는 중일 때는 누름을 무시한다</summary>
 */
function toggleCamera()
{
    if (camStarting)
    {
        return;
    }
    if (camTimer)
    {
        stopCamera();
    }
    else
    {
        startCamera();
    }
}

function stopCamera() {
  clearInterval(camTimer); camTimer = null;
  if (vid && vid.srcObject) vid.srcObject.getTracks().forEach((t) => t.stop());
  if (vid) { vid.srcObject = null; vid.hidden = true; } if (overlay) overlay.hidden = true;
  hub.camera = { ok: false, error: "웹캠이 꺼져 있습니다" }; hub.gesture = null; hub.handSeen = false; setBtn("btn-cam", "웹캠 켜기");
}

/* ---------- 내 파일(노래·캐릭터): 이 브라우저(IndexedDB)에만 저장, 서버로 올리지 않음 ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("rps-media", 1); r.onupgradeneeded = () => r.result.createObjectStore("f"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction("f", "readwrite"); t.objectStore("f").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); return true; } catch (e) { return false; } }
async function idbGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction("f").objectStore("f").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return null; } }
async function idbDel(k) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction("f", "readwrite"); t.objectStore("f").delete(k); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* 무시 */ } }

const song = new Audio(); song.preload = "auto";
let songReady = false, imgReady = false, songUrl = null, imgUrl = null;
const useMusic = () => songReady && $("music").checked;  // 내가 고른 노래 파일을 쓰는가
const bgmOn = () => $("music").checked;                   // 기본 BGM(직접 합성) 또는 내 노래를 쓰는가
const readyMs = () => (useMusic() ? Math.max(2, Math.min(10, +$("song-len").value || 4)) * 1000 : bgmOn() ? BGM_MS : 2 * STEP_MS);
function stopSong() { try { song.pause(); } catch (e) { /* 무시 */ } stopBgm(); }
function setSong(blob, name) {
  if (songUrl) URL.revokeObjectURL(songUrl);
  songUrl = URL.createObjectURL(blob); song.src = songUrl; songReady = true;
  $("song-status").textContent = `선택한 노래: ${name} (시작 ${$("song-start").value}초부터 ${$("song-len").value}초)`;
}
function clearSong() { stopSong(); songReady = false; song.removeAttribute("src"); if (songUrl) URL.revokeObjectURL(songUrl); songUrl = null; $("song-status").textContent = "선택한 파일 없음 — 기본 BGM을 씁니다."; }
function setImage(blob, name) {
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = URL.createObjectURL(blob); $("opp-img").src = imgUrl; imgReady = true;
  $("opp-img").hidden = false; $("avatar-empty").hidden = true; $("img-status").textContent = `선택한 이미지: ${name}`;
}
function clearImage() { imgReady = false; $("opp-img").hidden = true; $("opp-img").removeAttribute("src"); $("avatar-empty").hidden = false; if (imgUrl) URL.revokeObjectURL(imgUrl); imgUrl = null; $("img-status").textContent = "아직 고른 이미지가 없습니다."; }
/**
 * <summary>파일 입력 칸에서 고른 파일을 받아 처리한다</summary>
 * <param name="input">type=file 입력 칸</param>
 * <param name="kind">"song"(노래) 또는 "img"(상대 이미지)</param>
 */
async function pickFile(input, kind)
{
    const f = input.files && input.files[0];
    if (f)
    {
        await acceptFile(f, kind);
    }
}

/**
 * <summary>노래 또는 이미지 파일을 검사하고, 화면에 적용하고, 이 브라우저에 저장한다</summary>
 * <param name="f">File 객체</param>
 * <param name="kind">"song" 또는 "img"</param>
 * <reason>파일 선택, 끌어다 놓기, 붙여넣기가 같은 검사·저장 과정을 거치게 하려고 분리</reason>
 */
async function acceptFile(f, kind)
{
    const status = kind === "song" ? $("song-status") : $("img-status");
    const limit = kind === "song" ? 30 : 10;
    if (!f.type.startsWith(kind === "song" ? "audio/" : "image/"))
    {
        status.textContent = "올바른 파일 형식이 아닙니다.";
        return;
    }
    if (f.size > limit * 1024 * 1024)
    {
        status.textContent = `파일이 너무 큽니다 (${limit}MB 이하).`;
        return;
    }
    const saved = await idbSet(kind, { blob: f, name: f.name });
    if (kind === "song")
    {
        setSong(f, f.name);
    }
    else
    {
        setImage(f, f.name);
    }
    if (!saved)
    {
        status.textContent += " (이번 방문에만 유지됩니다)";
    }
    say(kind === "song" ? "노래 파일을 불러왔습니다." : "상대 이미지를 불러왔습니다.");
}
async function loadSaved() {
  const sv = await idbGet("song"); if (sv && sv.blob) setSong(sv.blob, sv.name);
  const im = await idbGet("img"); if (im && im.blob) setImage(im.blob, im.name);
}

/* ---------- 게임 ---------- */
// phase: between → ready("가위…" "바위…", 상대 손 회전) → play("보!" 3초, 상대 손 계속 회전) → result(동시 공개 + LED)
// 상대 손은 라운드 시작 때 정해 두고 숨긴다. 내 손이 확정(또는 시간 초과)되는 순간 회전이 멈추며 공개된다.
const game = { running: false, phase: "idle", round: 0, total: 5, score: 0, opp: null, mine: null, outcome: null, until: 0, readyStart: 0, step: -1, holdG: null, holdSince: 0, results: [], msg: "" };
const cfg = () => ({ limit: Math.max(2, Math.min(10, +$("limit").value || 3)), rounds: Math.max(1, Math.min(10, +$("rounds").value || 5)) });

/* ---------- 소리: 효과음과 직접 합성한 가위바위보 BGM (Web Audio, 음원 파일·저작권 문제 없음) ---------- */
let audio = null;
let bgmGain = null;

/**
 * <summary>브라우저 소리 장치를 하나만 만들어 재사용한다</summary>
 * <output>AudioContext, 만들 수 없으면 null</output>
 * <reason>AudioContext는 브라우저당 개수 제한이 있어 매번 만들면 몇 라운드 뒤 소리가 끊긴다</reason>
 */
function ensureAudio()
{
    try
    {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === "suspended")
        {
            audio.resume();
        }
        return audio;
    }
    catch (e)
    {
        return null;
    }
}

/**
 * <summary>짧은 효과음 한 번</summary>
 * <param name="freq">주파수(Hz)</param>
 * <param name="ms">길이(밀리초)</param>
 */
function beep(freq, ms)
{
    if (!$("sound").checked || !ensureAudio())
    {
        return;
    }
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000);
}

/**
 * <summary>음 하나를 예약한다 (BGM 전용 볼륨 마디에 연결)</summary>
 * <param name="freq">주파수(Hz)</param>
 * <param name="start">시작 시각(AudioContext 시간)</param>
 * <param name="dur">길이(초)</param>
 * <param name="type">파형 (triangle, square, sawtooth)</param>
 * <param name="vol">세기 0~1</param>
 */
function bgmTone(freq, start, dur, type, vol)
{
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(g);
    g.connect(bgmGain);
    o.start(start);
    o.stop(start + dur + 0.02);
}

/**
 * <summary>"가위! 바위! 보!" BGM을 합성해 재생한다: 통통 튀는 멜로디, 베이스, 박자 위에 가위·바위·보 순간마다 강조음</summary>
 * <param name="seconds">재생 길이(초). 마지막 강조음이 "보!" 순간과 맞는다</param>
 * <reason>저작권 있는 음원을 쓰지 않으려고 Web Audio로 직접 만든 오리지널 곡</reason>
 */
function playChantBgm(seconds)
{
    if (!ensureAudio())
    {
        return;
    }
    stopBgm();
    bgmGain = audio.createGain();
    bgmGain.gain.value = 0.18;
    bgmGain.connect(audio.destination);
    const t0 = audio.currentTime + 0.05;
    const beats = 12;
    const beat = seconds / beats;
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 783.99, 659.25, 587.33]; // 도 레 미 솔 라, 올라갔다 내려옴
    for (let i = 0; i < beats; i++)
    {
        bgmTone(scale[i % scale.length], t0 + i * beat, beat * 0.6, "triangle", 0.5);
        bgmTone(i % 2 === 0 ? 130.81 : 196.0, t0 + i * beat, beat * 0.8, "square", 0.22);
        bgmTone(2093, t0 + i * beat, 0.03, "square", 0.08);
    }
    const accents = [[0.0, 659.25], [0.5, 783.99], [1.0, 1046.5]]; // 가위, 바위, 보!
    for (const [at, freq] of accents)
    {
        bgmTone(freq, t0 + seconds * at, 0.22, "sawtooth", 0.5);
    }
}

/**
 * <summary>재생 중인 BGM을 부드럽게 멈춘다</summary>
 */
function stopBgm()
{
    if (!bgmGain || !audio)
    {
        return;
    }
    const g = bgmGain;
    bgmGain = null;
    g.gain.cancelScheduledValues(audio.currentTime);
    g.gain.setTargetAtTime(0, audio.currentTime, 0.02);
    setTimeout(() => { try { g.disconnect(); } catch (e) { /* 이미 끊김 */ } }, 200);
}
const isReady = () => hub.demo || (hub.model === "ready" && hub.camera.ok && performance.now() - hub.cameraAt < 1500);
function startGame() {
  if (game.running) return;
  if (!isReady()) {
    game.msg = hub.model === "loading" ? "손 인식 모델을 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요." : "웹캠을 켜고 손 인식 준비가 끝난 뒤 시작하세요. (장치가 없으면 데모 모드)";
    game.msg = hub.model === "loading" ? "손 인식 모델을 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요." : "웹캠과 손 인식 준비가 안 됐어요. 위의 '장치 연결하기'에서 웹캠을 켜거나 데모 모드를 쓰세요.";
    say(game.msg); if (hub.model === "idle" && hub.camera.ok) loadModel(); return;
  }
  const c = cfg(); Object.assign(game, { running: true, total: c.rounds, round: 0, score: 0, results: [], phase: "between", until: performance.now() + 300, msg: "" });
  $("btn-start").disabled = true; $("btn-stop").disabled = false; say("게임을 시작합니다.");
}
function endGame(reason) {
  stopSong(); const was = game.running; game.running = false; game.phase = "idle"; game.opp = game.mine = game.outcome = null;
  $("btn-start").disabled = false; $("btn-stop").disabled = true; sendCommand("SIGNAL 0");
  if (!was) return;
  if (reason === "done") {
    const board = store("board") || [], max = game.total * 3, wins = game.results.filter((r) => r.outcome === "win").length;
    const best = board.reduce((m, r) => Math.max(m, r.score), -1), newBest = game.score > best && game.score > 0;
    board.push({ score: game.score, max, wins, rounds: game.total, at: new Date().toLocaleString("ko-KR") });
    board.sort((a, b) => b.score - a.score); store("board", board.slice(0, 10)); renderBoard();
    say(`게임 끝. ${game.total}라운드 중 ${wins}번 이겼고 총점 ${game.score}점, 만점 ${max}점.${newBest ? " 최고 기록입니다." : ""}`); beep(880, 300);
  } else say("게임을 정지했습니다.");
}
function nextRound() {
  if (game.round >= game.total) return endGame("done");
  const now = performance.now();
  game.round++; game.opp = NAMES[Math.floor(Math.random() * 3)]; game.mine = game.outcome = null; game.holdG = null; game.holdSince = 0;
  game.phase = "ready"; game.readyStart = now; game.step = -1; game.until = now + readyMs(); sendCommand("SIGNAL 0");
  if (useMusic()) { try { song.currentTime = Math.max(0, +$("song-start").value || 0); song.play().catch(() => {}); } catch (e) { /* 재생 실패 시 효과음 없이 진행 */ } }
  else if (bgmOn()) { playChantBgm(readyMs() / 1000); }
  say(`${game.round}라운드. 가위, 바위, 보 하면 바로 내세요.`);
}
function resolveRound(mine) { // mine: 손 이름 또는 null(시간 초과)
  const opp = game.opp;
  const outcome = !mine ? "timeout" : mine === opp ? "draw" : BEATS[mine] === opp ? "win" : "lose", o = OUTCOME[outcome];
  game.mine = mine; game.outcome = outcome; game.score += o.pts; game.phase = "result"; game.resultAt = performance.now(); game.until = game.resultAt + RESULT_MS;
  game.results.push({ n: game.round, mine, opp, outcome, pts: o.pts });
  sendCommand(`JUDGE ${mine ? IDX[mine] : 3} ${IDX[opp]}`); beep(outcome === "win" ? 740 : outcome === "draw" ? 520 : 220, 250); // 보드가 판정·LED를 켜는 명령과 점수는 같은 순간
  const log = store("log") || []; log.unshift({ ...game.results.at(-1), at: new Date().toLocaleString("ko-KR") }); store("log", log.slice(0, 30)); renderLog();
  say(`${mine ? "내 손 " + HANDS[mine].ko : "손을 내지 못함"}, 상대 ${HANDS[opp].ko}. ${o.ko}. ${o.lamp} LED, ${o.pts}점 추가. 현재 ${game.score}점.`);
}
function tick() {
  const now = performance.now();
  if (game.running) {
    if (game.phase === "between" && now >= game.until) nextRound();
    else if (game.phase === "ready") {
      const step = (now - game.readyStart) / (game.until - game.readyStart) >= 0.5 ? 1 : 0; // 0 = 가위, 1 = 바위
      if (step !== game.step) { game.step = step; if (!bgmOn()) beep(440 + step * 80, 90); }
      if (now >= game.until) { stopSong(); game.phase = "play"; game.until = now + cfg().limit * 1000; beep(880, 160); say("보! 지금 내세요!"); }
    } else if (game.phase === "play") {
      const g = hub.gesture, fresh = hub.demo || (hub.camera.ok && now - hub.cameraAt < 1500);
      if (fresh && NAMES.includes(g)) { if (g !== game.holdG) { game.holdG = g; game.holdSince = now; } else if (now - game.holdSince >= HOLD_MS) return resolveRound(g); }
      else { game.holdG = null; game.holdSince = 0; }
      if (now >= game.until) resolveRound(null);
    } else if (game.phase === "result" && now >= game.until) { game.phase = "between"; game.until = now; }
  }
  keypadWatch();
}
let prevKey;
function keypadWatch() { // 키패드가 연결된 경우에만: A 시작, B 정지. 같은 키 연속 입력은 보드가 변화를 알리지 못하므로 A/B를 번갈아 쓴다.
  const k = hub.board && hub.board.last_key; if (k === undefined) return;
  if (prevKey === undefined) { prevKey = k; return; }
  if (k !== prevKey) { prevKey = k; if (k === "A") startGame(); else if (k === "B") endGame("stop"); }
}

/* ---------- 화면 ---------- */
// 만화 장갑 손(직접 그린 SVG). 그림은 장식이고 뜻은 옆의 글자(가위·바위·보)가 전달한다.
const GLOVE = {
  rock: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="#fff" stroke="#3a2230" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><rect x="19" y="52" width="26" height="9" rx="3"/><path d="M13 30c0-8 5-12 12-12h14c8 0 13 4 13 12v12c0 8-5 11-12 11H25c-7 0-12-3-12-11z"/><path d="M24 20v12M34 18v14M44 20v12" fill="none"/><path d="M13 34c-6-1-8 5-5 9s7 3 9 2"/></g></svg>`,
  paper: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="#fff" stroke="#3a2230" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><rect x="19" y="53" width="26" height="8" rx="3"/><path d="M14 38l-5-10c-2-4 3-7 6-4l5 7V14c0-4 6-4 6 0v16V9c0-4 6-4 6 0v21V12c0-4 6-4 6 0v20V17c0-4 6-4 6 0v26c0 9-6 11-13 11h-6c-8 0-12-6-12-16z"/></g></svg>`,
  scissors: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="#fff" stroke="#3a2230" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><rect x="19" y="52" width="26" height="9" rx="3"/><path d="M15 38c0-7 4-10 10-10h14c6 0 9 4 9 10v5c0 8-5 11-12 11H27c-7 0-12-3-12-11z"/><path d="M25 31L19 9c-1-4 5-6 7-2l7 24z"/><path d="M39 31l6-22c1-4-5-6-7-2l-7 24z"/><path d="M26 44h14M26 49h14" fill="none"/></g></svg>`,
};
const glove = (h) => `<span class="glove">${GLOVE[h]}</span>`;
const handText = (h) => (h ? `${glove(h)}<span>${HANDS[h].ko}</span>` : "—");
/**
 * <summary>이 브라우저에 저장된 점수판·기록 중 지금 형식에 맞지 않는 것(예전 버전이 남긴 것)을 걸러 낸다</summary>
 * <reason>예전 색깔 찾기 버전의 기록을 그대로 읽다가 오류가 나면 게임 페이지의 버튼 연결이 전부 빠지기 때문</reason>
 */
function cleanStored()
{
    try
    {
        const log = store("log");
        store("log", Array.isArray(log) ? log.filter((r) => r && OUTCOME[r.outcome] && NAMES.includes(r.opp)) : []);
        const board = store("board");
        store("board", Array.isArray(board) ? board.filter((r) => r && typeof r.score === "number" && typeof r.max === "number") : []);
    }
    catch (e)
    {
        /* 저장소를 못 읽어도 게임은 계속한다 */
    }
}

function renderBoard() {
  const b = (store("board") || []).filter((r) => r && typeof r.score === "number");
  $("best").textContent = b.length ? `최고 점수: ${b[0].score}점 / ${b[0].max}점 (${b[0].at})` : "최고 점수: 기록 없음";
  $("board-body").innerHTML = b.length ? b.slice(0, 5).map((r, i) => `<tr><th scope="row">${i + 1}위</th><td>${r.score}점 / ${r.max}점</td><td>${r.wins} / ${r.rounds}</td><td>${r.at}</td></tr>`).join("") : '<tr><td colspan="4" class="muted">아직 끝난 게임이 없습니다.</td></tr>';
}
function renderLog() {
  const log = (store("log") || []).filter((r) => r && OUTCOME[r.outcome] && NAMES.includes(r.opp));
  $("log-body").innerHTML = log.length ? log.map((r) => { const o = OUTCOME[r.outcome]; return `<tr><td>${r.n}라운드 (${r.at})</td><td>${handText(r.mine)}</td><td>${handText(r.opp)}</td><td>${o.sym} ${o.ko} · ${o.lamp} LED</td><td>+${r.pts}</td></tr>`; }).join("") : '<tr><td colspan="5" class="muted">아직 기록이 없습니다.</td></tr>';
}
let lastBanner = "";

/**
 * <summary>연결 상태 칩(웹캠·손 인식·보드)을 갱신한다. 해당 칸이 없는 페이지에서는 건너뛴다</summary>
 * <param name="camFresh">웹캠 영상이 최근에 들어왔는가</param>
 * <param name="stale">보드 응답이 3초 넘게 없는가</param>
 */
function renderChips(camFresh, stale)
{
    const chip = (cls, t) => `<span class="chip ${cls}">${t}</span>`;
    const set = (id, html) =>
    {
        const e = $(id);
        if (e)
        {
            e.innerHTML = html;
        }
    };
    set("c-cam", hub.demo ? chip("warn", "데모") : camFresh ? chip("ok", "✔ 영상 수신") : chip("bad", "✘ 없음"));
    set("c-model", hub.demo ? chip("warn", "데모") : hub.model === "ready" ? chip("ok", "✔ 준비됨") : hub.model === "loading" ? chip("warn", "불러오는 중") : hub.model === "error" ? chip("bad", "✘ 오류") : chip("warn", "대기"));
    set("c-board", hub.board ? (stale ? chip("bad", "✘ 응답 없음") : chip("ok", hub.demo ? "데모" : "✔ 연결됨")) : chip("warn", "연결 안 됨"));
}

/**
 * <summary>손 인식 상태를 글자로 만든다 (색에만 의존하지 않음)</summary>
 * <param name="camFresh">웹캠 영상이 최근에 들어왔는가</param>
 * <output>화면에 보여 줄 한 줄 문장</output>
 */
function recogText(camFresh)
{
    if (hub.demo)
    {
        return "데모: 손을 직접 지정합니다";
    }
    if (hub.model === "loading")
    {
        return "웹캠은 켜졌고, 손 인식 모델을 불러오는 중…";
    }
    if (hub.model === "error")
    {
        return "웹캠은 켜졌지만 손 인식 모델을 불러오지 못했습니다";
    }
    if (!camFresh)
    {
        return "웹캠 없음";
    }
    if (!hub.handSeen)
    {
        return "손이 보이지 않음";
    }
    return hub.gesture === "unknown" ? "손은 보이지만 가위·바위·보로 읽지 못함" : "인식됨: " + HANDS[hub.gesture].ko;
}

/**
 * <summary>웹캠 영상 위 안내 문구를 갱신한다</summary>
 * <param name="camFresh">웹캠 영상이 최근에 들어왔는가</param>
 */
function renderCamMsg(camFresh)
{
    const cm = $("cam-msg");
    cm.hidden = (camFresh || !!camTimer) && !hub.demo; // 웹캠이 켜져 있으면(모델 로딩으로 잠깐 느려져도) 가림막을 띄우지 않는다
    $("cam-msg-text").textContent = hub.demo ? '데모 모드: 웹캠 대신 "데모 조작"으로 손을 지정합니다' : (hub.camera.error || "웹캠 영상이 잠시 끊겼습니다");
}

/**
 * <summary>게임 페이지 화면을 갱신한다: 대결(웹캠 VS 상대 이미지), 구호, 점수</summary>
 * <param name="now">현재 시각(performance.now)</param>
 * <param name="camFresh">웹캠 영상이 최근에 들어왔는가</param>
 */
function renderGame(now, camFresh)
{
    const c = cfg();
    const spinning = game.phase === "ready" || game.phase === "play";
    const spinKey = NAMES[Math.floor(now / SPIN_MS) % 3];
    const av = $("avatar");
    av.classList.toggle("spin", spinning && !reduceMotion);
    av.dataset.mood = game.phase !== "result" ? "idle" : game.outcome === "win" ? "sad" : game.outcome === "draw" ? "idle" : "happy";

    // 상대 이미지 위에서 장갑 손이 빠르게 돌아가다가, 결과에서 멈춘다 (움직임 줄이기 설정이면 회전 없음)
    const sh = $("spin-hand");
    const showSpin = spinning || game.phase === "result";
    sh.hidden = !showSpin;
    if (showSpin)
    {
        sh.innerHTML = game.phase === "result" ? glove(game.opp) : (reduceMotion ? "❔" : glove(spinKey));
    }
    $("opp-hand").innerHTML = game.phase === "result" ? handText(game.opp) : spinning ? (reduceMotion ? "❔ 고르는 중" : `${glove(spinKey)}<span>…</span>`) : "—";
    $("my-hand").innerHTML = game.phase === "result" ? (game.mine ? handText(game.mine) : "— (내지 못함)") : handText(NAMES.includes(hub.gesture) ? hub.gesture : null);

    // 큰 구호: 가위! → 가위! 바위! → 가위! 바위! 보!
    let shout = game.msg || "시작 버튼을 누르세요.";
    if (game.phase === "ready")
    {
        shout = game.step < 1 ? "가위!" : "가위! 바위!";
    }
    else if (game.phase === "play")
    {
        shout = "가위! 바위! 보!";
    }
    else if (game.phase === "result")
    {
        shout = `${OUTCOME[game.outcome].sym} ${OUTCOME[game.outcome].ko} — ${OUTCOME[game.outcome].lamp} LED`;
    }
    const oc = $("outcome");
    if (oc.textContent !== shout)
    {
        oc.textContent = shout;
        if (!reduceMotion)
        {
            oc.classList.remove("pop");
            void oc.offsetWidth;
            oc.classList.add("pop");
        }
    }
    oc.dataset.outcome = game.phase === "result" ? game.outcome : game.phase;

    $("round").textContent = `${game.round} / ${game.running ? game.total : c.rounds}`;
    $("timer").textContent = game.phase === "play" ? Math.max(0, (game.until - now) / 1000).toFixed(1) + "초" : "—";
    $("score").textContent = `${game.score} / ${(game.running ? game.total : c.rounds) * 3}`;
    const hold = game.phase === "play" && game.holdSince ? Math.min(100, ((now - game.holdSince) / HOLD_MS) * 100) : 0;
    $("hold").value = hold;
    $("hold").textContent = Math.round(hold) + "%";
    $("recog").textContent = recogText(camFresh);
    renderCamMsg(camFresh);
    $("demo-box").hidden = !hub.demo;
    $("btn-demo-off").hidden = !hub.demo; // 데모 모드일 때만 끄기 버튼을 보여 준다
}

/**
 * <summary>장치 연결 페이지 화면을 갱신한다: 보드 신호, 최근 명령, 판정</summary>
 * <param name="now">현재 시각(performance.now)</param>
 * <param name="camFresh">웹캠 영상이 최근에 들어왔는가</param>
 * <param name="age">보드 마지막 응답 이후 경과(ms), 없으면 null</param>
 * <param name="bres">보드가 계산한 판정, 없으면 null</param>
 */
function renderSetup(now, camFresh, age, bres)
{
    $("recog").textContent = recogText(camFresh);
    renderCamMsg(camFresh);
    $("verdict").textContent = bres ? RESULT_KO[bres] : "—";
    $("signal").textContent = hub.board && hub.board.signal != null ? SIGNAL_TEXT[hub.board.signal] : "신호 미확인";
    $("lastkey").textContent = hub.board && hub.board.last_key && hub.board.last_key !== "-" ? hub.board.last_key : "— (없음)";
    $("age").textContent = age === null ? "—" : (age / 1000).toFixed(1) + "초 전";
    if (hub.lastCmd)
    {
        const l = hub.lastCmd;
        const a = l.request != null && hub.acks.find((x) => x.request === l.request);
        const st = l.stage === "fail" ? `전송 실패 (${l.error})` : a ? (a.type === "ack" ? "보드가 적용함 (ack)" : `보드 오류: ${a.code}`) : now - l.at > 2500 ? "응답 없음" : "전송됨, 응답 대기";
        $("cmdstate").textContent = `${l.cmd} → ${st}`;
    }
    $("btn-demo").setAttribute("aria-pressed", String(hub.demo));
}

/**
 * <summary>안내 띠(경고)를 갱신한다. 문장이 바뀔 때만 다시 써서 스크린리더가 반복해 읽지 않게 한다</summary>
 */
function renderBanner(now, camFresh, stale, bres)
{
    const msgs = [];
    if (stale)
    {
        msgs.push("보드 응답이 3초 이상 없습니다. 마지막 LED 상태를 현재 상태로 믿지 마세요. USB 연결을 확인하세요.");
    }
    if (hub.boardError && !hub.board)
    {
        msgs.push(hub.boardError);
    }
    if (hub.modelError)
    {
        msgs.push(hub.modelError);
    }
    if (hub.model === "loading" && now - hub.modelStart > 15000)
    {
        msgs.push("손 인식 모델을 불러오는 데 오래 걸립니다. 인터넷 연결을 확인하거나, 데모 모드를 쓰세요.");
    }
    if (PAGE === "game" && game.phase === "result" && now - game.resultAt > 1300 && bres && !stale && bres !== game.outcome)
    {
        msgs.push(`보드 판정(${RESULT_KO[bres]})이 화면 판정(${RESULT_KO[game.outcome]})과 다릅니다. 보드 펌웨어와 연결을 확인하세요.`);
    }
    if (PAGE === "game" && game.running && !camFresh)
    {
        msgs.push("웹캠 영상이 없어 손을 읽을 수 없습니다.");
    }
    const text = msgs.join(" ");
    const b = $("banner");
    if (text !== lastBanner)
    {
        lastBanner = text;
        b.textContent = text;
        b.hidden = !text;
        b.classList.toggle("err", stale);
    }
}

/**
 * <summary>페이지에 맞는 화면 갱신을 호출한다 (0.1초마다)</summary>
 */
function render()
{
    const now = performance.now();
    const camFresh = hub.demo || (hub.camera.ok && now - hub.cameraAt < 1500);
    const age = hub.board ? now - hub.boardAt : null;
    const stale = age !== null && age > 3000;
    const bres = hub.board && hub.board.result; // 보드가 직접 계산한 판정(없으면 null)
    renderChips(camFresh, stale);
    if (PAGE === "game")
    {
        renderGame(now, camFresh);
    }
    if (PAGE === "setup")
    {
        renderSetup(now, camFresh, age, bres);
    }
    renderBanner(now, camFresh, stale, bres);
}

/* ---------- 데모 ---------- */
function buildDemoButtons() {
  $("demo-actions").innerHTML = NAMES.map((n) => `<button type="button" class="secondary" data-g="${n}" aria-pressed="false">${handText(n)} 내기</button>`).join("") + '<button type="button" class="secondary" data-g="">손 없음</button>';
  $("demo-actions").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    hub.gesture = b.dataset.g || null; hub.handSeen = !!hub.gesture;
    $("demo-actions").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b && !!b.dataset.g)));
  });
}
let demoKeep = null;

/**
 * <summary>데모 모드를 켜거나 끈다. 다른 페이지로 가도 유지되게 이 탭에 기억한다</summary>
 * <param name="on">켜려면 true</param>
 * <param name="announce">켜고 끌 때 안내 문장을 읽어 줄지</param>
 */
function applyDemo(on, announce)
{
    hub.demo = on;
    try
    {
        sessionStorage.setItem("rps-demo", on ? "1" : "0");
    }
    catch (e)
    {
        /* 저장할 수 없으면 이 페이지에서만 유지 */
    }
    if (on)
    {
        stopCamera();
        hub.board = { type: "state", profile: "RPS", last_key: "-", signal: 0 };
        hub.boardAt = performance.now();
        hub.gesture = null;
        clearInterval(demoKeep);
        demoKeep = setInterval(() => { hub.boardAt = performance.now(); }, 1000);
    }
    else
    {
        clearInterval(demoKeep);
        hub.board = null;
        hub.gesture = null;
        hub.handSeen = false;
    }
    if (announce)
    {
        say(on ? "데모 모드를 켰습니다." : "데모 모드를 껐습니다.");
    }
}

/**
 * <summary>이 브라우저가 이미 허용한 장치에 자동으로 연결한다 (웹캠 권한이 허용돼 있으면 켜고, 허용된 아두이노 포트가 있으면 연다)</summary>
 * <reason>페이지를 옮기면 웹캠·포트 연결이 끊기므로, 한 번 허용해 두면 다른 페이지에서 다시 묻지 않고 이어 쓰게 한다</reason>
 */
async function autoConnect()
{
    if (hub.demo)
    {
        return;
    }
    try
    {
        const p = await navigator.permissions.query({ name: "camera" });
        if (p.state === "granted" && !camTimer)
        {
            startCamera();
        }
    }
    catch (e)
    {
        /* 권한 조회를 지원하지 않는 브라우저: 장치 연결 페이지에서 직접 켠다 */
    }
    if ("serial" in navigator)
    {
        try
        {
            const ports = await navigator.serial.getPorts();
            if (ports.length > 0 && !port)
            {
                connectSerial(ports[0]);
            }
        }
        catch (e)
        {
            /* 자동 연결 실패는 조용히 넘기고 수동 연결을 안내한다 */
        }
    }
}

/* ---------- 시작 ---------- */
function initGame()
{
    cleanStored();
    buildDemoButtons();
    try
    {
        renderLog();
        renderBoard();
    }
    catch (e)
    {
        showFatal(e);
    }
    $("btn-cam").addEventListener("click", toggleCamera);
    $("btn-demo-off").addEventListener("click", () => { applyDemo(false, true); autoConnect(); });
    $("btn-start").addEventListener("click", startGame);
    $("btn-stop").addEventListener("click", () => endGame("stop"));
    $("btn-clear").addEventListener("click", () => { store("log", []); store("board", []); renderLog(); renderBoard(); say("기록을 지웠습니다."); });
    $("song-file").addEventListener("change", (e) => pickFile(e.target, "song"));
    $("img-file").addEventListener("change", (e) => pickFile(e.target, "img"));
    $("song-clear").addEventListener("click", async () => { clearSong(); await idbDel("song"); $("song-file").value = ""; say("노래 파일을 지웠습니다."); });
    $("img-clear").addEventListener("click", async () => { clearImage(); await idbDel("img"); $("img-file").value = ""; say("상대 이미지를 지웠습니다."); });
    $("music").addEventListener("change", () => { if (!$("music").checked) { stopSong(); } });
    for (const id of ["song-start", "song-len"])
    {
        $(id).addEventListener("change", () => store("songcfg", { start: $("song-start").value, len: $("song-len").value }));
    }
    const cfgSaved = store("songcfg");
    if (cfgSaved)
    {
        $("song-start").value = cfgSaved.start;
        $("song-len").value = cfgSaved.len;
    }

    // 이미지·노래 넣기: 끌어다 놓기, 붙여넣기(Ctrl+V). 파일 선택 버튼은 위의 label.
    const stage = document.querySelector(".stage");
    stage.addEventListener("dragover", (e) => { e.preventDefault(); });
    stage.addEventListener("drop", (e) =>
    {
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f)
        {
            acceptFile(f, f.type.startsWith("audio/") ? "song" : "img");
        }
    });
    document.addEventListener("paste", (e) =>
    {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (const it of items)
        {
            if (it.type.startsWith("image/"))
            {
                const f = it.getAsFile();
                if (f)
                {
                    e.preventDefault();
                    acceptFile(f, "img");
                    return;
                }
            }
        }
    });

    // 마우스 위치에 따라 상대 카드가 살짝 기울어진다 (움직임 줄이기 설정이면 끔)
    if (!reduceMotion)
    {
        stage.addEventListener("pointermove", (e) =>
        {
            const r = $("avatar").getBoundingClientRect();
            const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
            const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
            $("avatar").style.setProperty("--ry", Math.max(-14, Math.min(14, dx * 22)) + "deg");
            $("avatar").style.setProperty("--rx", Math.max(-10, Math.min(10, -dy * 16)) + "deg");
        });
        stage.addEventListener("pointerleave", () => { $("avatar").style.setProperty("--ry", "0deg"); $("avatar").style.setProperty("--rx", "0deg"); });
    }
    loadSaved();
    setInterval(tick, 80);
}

function initSetup()
{
    $("btn-cam").addEventListener("click", toggleCamera);
    $("btn-serial").addEventListener("click", () => (port ? disconnectSerial() : connectSerial()));
    $("btn-demo").addEventListener("click", () => applyDemo(!hub.demo, true));
    $("t-win").addEventListener("click", () => sendCommand("SIGNAL 3"));
    $("t-draw").addEventListener("click", () => sendCommand("SIGNAL 2"));
    $("t-lose").addEventListener("click", () => sendCommand("SIGNAL 1"));
    $("t-off").addEventListener("click", () => sendCommand("SIGNAL 0"));
    if (!("serial" in navigator))
    {
        $("btn-serial").disabled = true;
        $("btn-serial").textContent = "UNO 연결 (이 브라우저는 미지원)";
    }
}

function init()
{
    if (PAGE !== "game" && PAGE !== "setup")
    {
        return;
    }
    let demoSaved = false;
    try
    {
        demoSaved = sessionStorage.getItem("rps-demo") === "1";
    }
    catch (e)
    {
        demoSaved = false;
    }
    if (PAGE === "game")
    {
        initGame();
    }
    else
    {
        initSetup();
    }
    if (demoSaved)
    {
        applyDemo(true, false);
    }
    window.addEventListener("beforeunload", () => { if (writer) { sendCommand("SIGNAL 0"); } });
    setInterval(render, 100);
    render();
    autoConnect();
}
document.addEventListener("DOMContentLoaded", init);
