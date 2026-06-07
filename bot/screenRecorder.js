// bot/screenRecorder.js
// 화면(영상) 녹화 — ffmpeg(gdigrab)로 마인크래프트 창을 mp4로 저장한다.
// 인게임 !rec(토글) / !demo 에서 사용. ffmpeg 바이너리는 ffmpeg-static 번들 사용(설치 불필요).
// 저장: demos/demo_<시각>.mp4  (창 제목 자동 탐지 → 못 찾으면 전체 화면)

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

let _proc = null;
let _outPath = null;

function _stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 제목에 substr를 포함하는 보이는 창의 '정확한 제목'을 반환(없으면 null). gdigrab title= 캡처용.
// 기본 대상: OpenCV 비전 HUD 창('ADAS V5.0 - Sensor Fusion HUD') — YOLO/CNN 시각화가 그려진 창.
function _findWindowTitle(substr) {
  try {
    const cmd =
      'powershell -NoProfile -Command "' +
      "Get-Process | Where-Object { $_.MainWindowTitle -like '*" + substr + "*' } | " +
      'Select-Object -First 1 -ExpandProperty MainWindowTitle"';
    const out = execSync(cmd, { timeout: 5000 }).toString().trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

// 녹화 시작 → mp4 경로 반환(이미 녹화 중이면 기존 경로). 창 제목 캡처 우선, 실패 시 전체 화면.
function startScreenRecording(dir) {
  if (_proc) return _outPath;
  const demosDir = dir || path.join(__dirname, '..', 'demos');
  try { fs.mkdirSync(demosDir, { recursive: true }); } catch (e) { /* 무시 */ }
  _outPath = path.join(demosDir, `demo_${_stamp(new Date())}.mp4`);

  // 기본 대상: OpenCV 비전 HUD 창(YOLO/CNN 박스 표시). 없으면 마인크래프트 창, 그것도 없으면 전체 화면.
  const title = _findWindowTitle('Sensor Fusion HUD') || _findWindowTitle('Minecraft');
  const args = ['-y', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-i'];
  if (title) {
    args.push(`title=${title}`);  // 해당 창만 캡처(창을 따라감)
    console.log(`[ScreenRec] 캡처 대상 창: "${title}"`);
  } else {
    args.push('desktop');         // 폴백: 전체 화면
    console.log('[ScreenRec] 대상 창 못 찾음 → 전체 화면 캡처');
  }
  // 창 크기가 홀수면 libx264가 거부 → 짝수로 crop 보정
  args.push('-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', _outPath);

  // stdin 파이프 유지 → 종료 시 'q'로 안전하게 finalize(mp4 moov 기록)
  _proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'ignore'] });
  _proc.on('exit', () => { _proc = null; });
  return _outPath;
}

// 녹화 종료(안전 finalize) → mp4 경로 반환(녹화 중 아니면 null)
function stopScreenRecording() {
  if (!_proc) return null;
  const out = _outPath;
  const proc = _proc;
  try { proc.stdin.write('q'); } catch (e) { /* 무시 */ }
  // 1.5s 내 안 끝나면 SIGINT(여전히 ffmpeg가 finalize). SIGKILL은 파일 손상되므로 쓰지 않음.
  setTimeout(() => { try { if (proc.exitCode === null && !proc.killed) proc.kill('SIGINT'); } catch (e) { /* 무시 */ } }, 1500);
  _proc = null;
  _outPath = null;
  return out;
}

function isScreenRecording() { return !!_proc; }

module.exports = { startScreenRecording, stopScreenRecording, isScreenRecording };
