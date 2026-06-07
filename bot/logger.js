// bot/logger.js
// 구조화(머신 판독) 로깅 — 로그만 보고 동작을 검증할 수 있게 한다.
// 각 이벤트는 'EVT <ts> <event> <json>' 한 줄로 출력된다. (사람이 읽는 기존 console.log는 그대로 둠)
//
// 데모 녹화: startRecording()으로 demos/demo_<timestamp>.log 에 모든 EVT를 함께 기록.
//   인게임 !record(토글) / !demo <몹> 명령에서 사용. 영상은 OBS 등으로 따로 녹화.
//
// 주요 이벤트(검증용):
//   nav_start / goal_reached / path_found / no_path
//   reactive_decision(reason,...)  — 단일 Arbiter의 모든 반응 결정
//   stuck_recover / freeze_start / freeze_end(durMs)  — 정지/끼임 추적
//   retreat_start / retreat_end(durMs) / bypass_start / bypass_end
//   health(hp) / flee_start(hp) / death / vision_status / demo_start

const fs = require('fs');
const path = require('path');

let _recPath = null; // 녹화 중이면 저장 파일 경로, 아니면 null

function _stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 녹화 시작 → 저장 파일 경로 반환(이미 녹화 중이면 기존 경로 반환).
// 각 EVT를 동기 append로 즉시 디스크에 기록 → Ctrl+C로 끊겨도 데모가 보존됨.
function startRecording(dir) {
  if (_recPath) return _recPath;
  const demosDir = dir || path.join(__dirname, '..', 'demos');
  try { fs.mkdirSync(demosDir, { recursive: true }); } catch (e) { /* 무시 */ }
  const now = new Date();
  const p = path.join(demosDir, `demo_${_stamp(now)}.log`);
  try { fs.appendFileSync(p, `# ADAS demo recording started ${now.toISOString()}\n`); } catch (e) { return null; }
  _recPath = p;
  return _recPath;
}

// 녹화 종료 → 저장 파일 경로 반환(녹화 중 아니면 null)
function stopRecording() {
  if (!_recPath) return null;
  const p = _recPath;
  try { fs.appendFileSync(p, `# ADAS demo recording stopped ${new Date().toISOString()}\n`); } catch (e) { /* 무시 */ }
  _recPath = null;
  return p;
}

function isRecording() { return !!_recPath; }
function recordingPath() { return _recPath; }

function logEvent(event, fields = {}) {
  let body = '';
  try {
    body = JSON.stringify(fields);
  } catch (e) {
    body = '{"_err":"unserializable"}';
  }
  const line = `EVT ${Date.now()} ${event} ${body}`;
  console.log(line);
  if (_recPath) {
    try { fs.appendFileSync(_recPath, line + '\n'); } catch (e) { /* 무시 */ }
  }
}

module.exports = { logEvent, startRecording, stopRecording, isRecording, recordingPath };
