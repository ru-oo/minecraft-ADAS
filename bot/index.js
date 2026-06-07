// bot/index.js
// ADAS V5.0 — YOLO/CNN 주사용 + Mineflayer API 2차 검증 센서 퓨전 봇
//
// V5.0 핵심 변경:
//   - YOLO/CNN이 1차 센서 (이 프로젝트의 주사용 목적)
//   - Mineflayer API (MobRadar, GridMap)는 2차 교차 검증용
//   - WebSocket 통신으로 Vision 서버 연동 (HTTP 폴링 제거)
//   - Pathfinder 우회 즉각 물리 회피 (physicsEvade) 도입
//   - 전체 센서 퓨전 루프 50ms 동기화 (20Hz)
//
// 채팅 명령어:
//   !goto <x> <y> <z>  — 해당 좌표로 자동 이동
//   !stop               — 이동 중단
//   !explore <반경>     — 자율 탐험 시작
//   !status             — 현재 상태 출력
//   !threats            — 주변 위협 목록
//   !grid               — 그리드 맵 상태
//   !scene              — CNN 지형 판단
//   !yolo               — YOLO 탐지 상태

const mineflayer = require('mineflayer');
const mineflayerViewer = require('prismarine-viewer').mineflayer;
const { Navigator } = require('./navigator');
const { MobRadar, SCAN_RADIUS } = require('./mobRadar');
const { CombatManager } = require('./combatManager');
const { VisionClient } = require('./visionClient');
const { DataCollector } = require('./dataCollector');
const { LocalGridMap, CELL } = require('./localGridMap');
const { createDashboard } = require('./dashboard');
const { logEvent, startRecording, stopRecording, isRecording, recordingPath } = require('./logger');
const { startScreenRecording, stopScreenRecording, isScreenRecording } = require('./screenRecorder');

// ── CLI 인자 파싱 ──────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const HOST = getArg('--host', 'localhost');
const PORT = parseInt(getArg('--port', '25565'), 10);
const USERNAME = getArg('--username', 'ADAS_Bot');
const VERSION = getArg('--version', false);
// [self-test] CLI 네비게이션: --goto "x,y,z" → 스폰 후 자동 이동(인게임 채팅 불필요)
const GOTO = getArg('--goto', null);
// [self-test] --spawntest <mob> → 스폰 후 전방에 몹 소환하고 통과 이동(봇 op 필요)
const SPAWNTEST = getArg('--spawntest', null);
// [self-test] --mobonpath <mob> → --goto/--gotorel과 함께: 봇→목적지 직선 10블록 지점에 위험몹 소환(경로상 조우 재현, 봇 op 필요)
const MOBONPATH = getArg('--mobonpath', null);
// [self-test] --gotorel "dx,dz" → 현재 위치 기준 상대 목적지(스폰 위치가 매번 달라도 일정 거리 주행)
const GOTOREL = getArg('--gotorel', null);
// [redesign] 웹 대시보드(:3000)는 기본 OFF. --dashboard 플래그로만 활성화. (:3007 뷰어는 항상 유지)
const USE_DASHBOARD = args.includes('--dashboard');

console.log('╔══════════════════════════════════════════╗');
console.log('║  ADAS V5.0 — YOLO/CNN 주센서 + WS 통신  ║');
console.log('║  YOLO+CNN(1차) → API 교차검증(2차) 퓨전  ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  서버: ${HOST}:${PORT}`);
console.log(`║  봇 이름: ${USERNAME}`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

// ── 봇 생성 ────────────────────────────────────────────
const botOptions = { host: HOST, port: PORT, username: USERNAME, hideErrors: false };
if (VERSION) botOptions.version = VERSION;

const bot = mineflayer.createBot(botOptions);

// ── 모듈 초기화 ────────────────────────────────────────
let navigator, mobRadar, combatManager, visionClient, dataCollector, gridMap;

// ── 단일 Arbiter용 커밋/방향 히스테리시스 ────────────────────────────────────
// 반응형 회피는 아래 단 하나의 Arbiter가 결정한다. 한 번 기동을 발동하면 commit(ms)으로
// 그 시간만큼 새 결정을 보류해 thrash(진동)를 막는다. 측면 방향은 직전 방향을 잠깐 유지.
let arbCommitUntil = 0;          // 이 시각까지는 새 반응 결정 보류
let lastEvadeDir = null;         // 마지막 좌/우 방향
let lastEvadeTime = 0;
function arbiterCommitted() { return Date.now() < arbCommitUntil; }
function commit(ms) { arbCommitUntil = Date.now() + ms; }
function markEvade(dir) { lastEvadeTime = Date.now(); if (dir === 'left' || dir === 'right') lastEvadeDir = dir; }
// 직전 좌/우 방향을 3초간 유지(좌우 떨림 방지), 그 외엔 새 방향 채택
function committedAvoidDir(fresh) { return (lastEvadeDir && Date.now() - lastEvadeTime < 3000) ? lastEvadeDir : fresh; }

bot.once('spawn', () => {
  console.log('[Bot] ✅ 서버 접속 및 스폰 완료!');
  const pos = bot.entity.position;
  console.log(`[Bot] 📍 스폰 위치: (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);

  navigator = new Navigator(bot);
  visionClient = new VisionClient();        // WebSocket으로 Vision 서버 연결
  visionClient.start();
  mobRadar = new MobRadar(bot, visionClient);
  mobRadar.start();
  combatManager = new CombatManager(bot, navigator);
  dataCollector = new DataCollector(navigator, mobRadar, visionClient);
  dataCollector.start();
  gridMap = new LocalGridMap(bot);
  gridMap.start();

  // ══════════════════════════════════════════════════════════
  // V6.0 제어 레이어 재설계 — 'pathfinder가 지형, 단일 Arbiter가 몹'
  //
  //  지형(물·용암·절벽·언덕): 전적으로 pathfinder(maxDropDown=2, blocksToAvoid)가 담당.
  //  반응형 행동: 아래 단 하나의 Arbiter(100ms)가 우선순위로 결정한다.
  //    (A) 체력<=11 & 주변 적  → 군집 중심 반대로 retreat (목표보다 생존 우선)
  //    (B) 치명적 몹(크리퍼 등)이 clearance 침해 → retreat (측면 접근 금지, 큰 반경 후퇴)
  //    (C) 다중 몹 군집(≥2)     → 군집 중심 반대로 retreat
  //    (D) 3블록 이내 정면 몹    → 즉각 측면 physicsEvade (유일한 즉각 반사)
  //    (E) 전방 단일 비치명 몹   → 한 번 부드럽게 측면 bypass 후 복귀
  //    (F) CNN+Grid '합의' 위험  → 지형 재경로(두 센서 동시 위험일 때만, CNN 단독 금지)
  //  commit(ms)으로 결정마다 커밋 시간을 두어 thrash를 방지한다.
  //
  // 그리드 데이터는 WebSocket으로 Vision 서버에 전송(인지/표시/교차검증 유지)
  // ══════════════════════════════════════════════════════════

  // 그리드 데이터를 Vision 서버로 전송 (50ms 주기, WS 이용)
  setInterval(() => {
    if (gridMap) {
      gridMap.setPath(navigator.currentPath || []);
      visionClient.sendGrid(gridMap.toJSON());
    }
  }, 50);

  // [self-test] YOLO/CNN 탐지 상태를 2초마다 로그로 남김(봇 시점 관전 시 YOLO가 실제로 잡히는지 확인용)
  setInterval(() => {
    if (!visionClient || !visionClient.isConnected) return;
    const dets = visionClient.getAllDetections();
    const danger = dets.filter(d => d.dangerous).length;
    const sc = visionClient.getSceneState();
    logEvent('vision_status', { yolo: dets.length, danger, scene: sc.label, conf: Math.round(sc.confidence * 100) / 100 });
  }, 2000);

  // ─────────────────────────────────────────────────────────
  // [단일] 반응형 Arbiter (100ms) — 모든 반응 행동의 유일한 결정점
  // ─────────────────────────────────────────────────────────
  // 화면(YOLO)에서 경로상 가까운 위험 몹 탐지를 반환(없으면 null)
  function yoloCloseThreat() {
    if (!visionClient.isConnected) return null;
    const c = visionClient.getDangerousDetections().find(d =>
      d.center_x > 0.15 && d.center_x < 0.85 && d.confidence >= 0.35
    );
    if (!c) return null;
    const [x1, y1, x2, y2] = c.bbox;
    const area = (x2 - x1) * (y2 - y1);
    return area > 8000 ? { det: c, area } : null; // 8000px+ = 경로상 충분히 가까운 몹
  }

  // 후퇴 지속을 위한 '라이브 위협' 재평가: 현재 반경 내 위협의 가중 중심 + 최소 거리.
  function liveThreatInfo(radius) {
    if (!bot.entity) return null;
    const n = mobRadar.getNearbyThreats(radius);
    if (!n.length) return null;
    const p = bot.entity.position;
    const minDist = Math.min(...n.map(t => Math.hypot(p.x - t.position.x, p.z - t.position.z)));
    return { centroid: mobRadar.getThreatCentroid(n), minDist };
  }

  setInterval(() => {
    if (!navigator || !mobRadar) return;
    if (!bot.entity || bot.health == null || bot.health <= 0) return; // 사망/리스폰 중에는 결정 안 함
    // 이미 기동 중(회피/우회/후퇴/도주)이면 새 결정 안 함. commit 시간 내에도 보류.
    if (navigator.isAvoiding || navigator.isBypassing || navigator.isRetreating || navigator.isFleeing) return;
    if (arbiterCommitted()) return;

    const hp = bot.health;
    const nearby = mobRadar.getNearbyThreats(SCAN_RADIUS); // 실제 좌표 있는 360° 위협

    // (A) 체력 위급: HP<=11 이고 '실제로 가까운(≤10m)' 적이 있을 때만 후퇴(목표보다 생존 우선).
    //     [버그수정] 예전엔 24m 이내 아무 몹(시야 밖 먼 몹 포함)에나 반응 → 먼 몹 때문에 제자리
    //     후퇴를 무한 반복(retreat_end minDist:-1)했다. 가까운 몹이 없으면 도주하지 않고 목적지 진행.
    const fleeThreats = nearby.filter(t => t.distance <= 10);
    if (hp <= 11 && fleeThreats.length > 0) {
      const c = mobRadar.getThreatCentroid(fleeThreats);
      logEvent('reactive_decision', { reason: 'health_flee', hp, n: fleeThreats.length, nearest: Math.round(fleeThreats[0].distance) });
      navigator.retreatFrom(c, 12, { live: () => liveThreatInfo(12) });
      commit(2000);
      return;
    }

    // (B) 치명적 몹(크리퍼 등) 대응.
    const lethalNear = nearby.filter(t => t.lethal && t.distance <= t.clearance);
    if (lethalNear.length > 0) {
      const nearest = lethalNear.slice().sort((a, b) => a.distance - b.distance)[0];
      const safe = Math.max(...lethalNear.map(t => t.clearance));
      // 1) 즉시 폭발 위험(≤5m) / 정지 중 / 저체력 → 생존 우선 '큰 반경 후퇴'(뒤로)
      if (nearest.distance <= 5 || !navigator.isNavigating || hp <= 11) {
        const grp = nearby.filter(t => t.distance <= 12);
        const c = mobRadar.getThreatCentroid(grp.length ? grp : lethalNear);
        logEvent('reactive_decision', { reason: 'lethal_retreat', mob: nearest.name, dist: nearest.distance, clearance: safe });
        navigator.retreatFrom(c, safe + 2, { live: () => liveThreatInfo(safe + 6) });
        commit(2500);
        return;
      }
      // 2) '전방 경로를 막은' 치명 몹만 넓게 돌아 통과(폭발 점화 3블록 밖인 6블록 측면 호).
      //    옆/뒤로 이미 지나친 크리퍼는 무시하고 목적지로 직진 → 제자리 위빙 없이 통과·도달.
      const ahead = mobRadar.getForwardThreats(safe, 150).find(t => t.lethal);
      if (ahead) {
        const dir = committedAvoidDir(gridMap ? gridMap.getBestAvoidDirection() : mobRadar.getAvoidDirection(ahead));
        logEvent('reactive_decision', { reason: 'lethal_bypass', mob: ahead.name, dist: ahead.distance, dir });
        navigator.bypassMob(dir, 6);
        markEvade(dir);
        commit(1500);
      }
      // ahead가 없으면(옆/뒤) 아무 반응도 안 하고 pathfinder가 목적지로 계속 진행
      return;
    }

    // (C) 다중 몹 군집(10블록 내 ≥2) → 군집 중심 반대로 후퇴(한 마리 피하다 다른 몹 충돌 방지)
    const cluster = nearby.filter(t => t.distance <= 10);
    if (cluster.length >= 2) {
      const c = mobRadar.getThreatCentroid(cluster);
      logEvent('reactive_decision', { reason: 'cluster_retreat', n: cluster.length });
      navigator.retreatFrom(c, 12, { live: () => liveThreatInfo(14) });
      commit(2000);
      return;
    }

    // (D) 3블록 이내 정면 몹 → 즉각 측면 physicsEvade (유일한 즉각 반사)
    const critical = mobRadar.getForwardThreats(3, 180);
    if (critical.length > 0) {
      const n = critical[0];
      const dir = committedAvoidDir(gridMap ? gridMap.getBestAvoidDirection() : mobRadar.getAvoidDirection(n));
      logEvent('reactive_decision', { reason: 'emergency_sidestep', mob: n.name, dist: n.distance, dir });
      navigator.physicsEvade(dir, 600);
      markEvade(dir);
      commit(900);
      return;
    }

    // 여기부터는 주행 중에만(목표가 있을 때) 의미 있음
    if (!navigator.isNavigating) return;

    // (E) 전방 단일 비치명 몹이 'clearance+3 이내'로 들어옴 → 한 번 부드럽게 측면 우회 후 복귀.
    //     (멀리 앞쪽 몹은 pathfinder가 알아서 우회하므로 굳이 반응하지 않는다 → 매끄러움 유지)
    const forward = mobRadar.getForwardThreats(8, 120);
    const yolo = yoloCloseThreat();
    const n = forward[0];
    const inRange = n && n.distance <= (n.clearance + 3);
    if (inRange || yolo) {
      const clearance = n ? n.clearance : 5;
      const dir = committedAvoidDir(gridMap ? gridMap.getBestAvoidDirection() : (n ? mobRadar.getAvoidDirection(n) : 'left'));
      const who = n ? `${n.name} ${n.distance.toFixed(1)}m` : `yolo:${yolo.det.class_name}`;
      logEvent('reactive_decision', { reason: 'mob_bypass', who, dir, clearance });
      navigator.bypassMob(dir, clearance);
      markEvade(dir);
      commit(2000);
      return;
    }

    // (F) CNN+Grid '합의' 지형 재경로 — 두 센서가 동시에 위험일 때만. CNN 단독은 절대 트리거 안 함.
    if (visionClient.isConnected && gridMap && visionClient.isSceneDangerous()) {
      const scene = visionClient.getSceneState();
      if (scene.confidence >= 0.85 && gridMap.isForwardDangerous()) {
        const dir = committedAvoidDir(gridMap.getBestAvoidDirection());
        logEvent('reactive_decision', { reason: 'cnn_grid_consensus', label: scene.label, conf: Math.round(scene.confidence * 100) / 100, dir });
        navigator.bypassMob(dir, 5);
        markEvade(dir);
        commit(2000);
        return;
      }
    }
    // else: cruise — pathfinder가 주행을 온전히 소유(반응 트리거 없음)
  }, 100);

  // 1인칭 시점 뷰어 (포트 3007) — Vision 서버(mss)가 화면 캡처하는 소스이므로 항상 유지.
  mineflayerViewer(bot, { port: 3007, firstPerson: true });
  console.log('[Bot] 👁️ 봇 1인칭 시점 뷰어: http://localhost:3007');

  // 웹 대시보드 (포트 3000) — 미사용. 기본 OFF, --dashboard 플래그일 때만 활성화.
  if (USE_DASHBOARD) {
    createDashboard(bot, navigator, mobRadar, combatManager, gridMap);
    console.log('[Bot] 🌐 대시보드 활성화(--dashboard): http://localhost:3000');
  }

  // [self-test] --spawntest <mob> : 스폰 직후 전방 5블록에 몹 소환 후 그 너머로 통과 이동(봇 op 필요)
  if (SPAWNTEST) {
    setTimeout(() => {
      const p = bot.entity.position;
      const yaw = bot.entity.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const sx = Math.round(p.x + fx * 5), sy = Math.round(p.y), sz = Math.round(p.z + fz * 5);
      const gx = Math.round(p.x + fx * 20), gz = Math.round(p.z + fz * 20);
      logEvent('spawntest', { mob: SPAWNTEST, sx, sy, sz, gx, gz });
      console.log(`[Bot] ▶ --spawntest ${SPAWNTEST}: goto (${gx},${sy},${gz}) 후 진행 중 전방 소환 (봇 op 필요)`);
      navigator.goto(gx, sy, gz);                                                    // 먼저 목적지로 출발
      setTimeout(() => bot.chat(`/summon ${SPAWNTEST} ${sx} ${sy} ${sz}`), 1200);    // 진행 중 전방에 몹 소환
    }, 1800);
  }

  // [self-test] --goto "x,y,z" 가 주어지면 스폰 직후 자동 이동(인게임 채팅 불필요)
  if (GOTO && !SPAWNTEST) {
    const parts = GOTO.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 3 && !parts.some(isNaN)) {
      const [gx, gy, gz] = parts;
      setTimeout(() => {
        // 경로상 몹 조우 재현: 봇→목적지 직선 10블록 지점에 위험몹 소환(봇 op 필요)
        if (MOBONPATH) {
          const p = bot.entity.position;
          let dx = gx - p.x, dz = gz - p.z;
          const L = Math.hypot(dx, dz) || 1;
          const mx = Math.round(p.x + (dx / L) * 10), my = Math.round(p.y), mz = Math.round(p.z + (dz / L) * 10);
          logEvent('mobonpath', { mob: MOBONPATH, mx, my, mz });
          console.log(`[Bot] ▶ --mobonpath ${MOBONPATH} @ (${mx},${my},${mz}) — 경로 위 소환`);
          bot.chat('/effect give @s minecraft:instant_health 1 100'); // 테스트 공정성: 시작 시 풀피
          bot.chat('/effect give @s minecraft:resistance 300 4');      // 데모와 동일: 폭발 피해 대폭 감소
          bot.chat(`/summon ${MOBONPATH} ${mx} ${my} ${mz}`);
        }
        console.log(`[Bot] ▶ --goto 자동 이동: (${gx}, ${gy}, ${gz})`);
        navigator.goto(gx, gy, gz);
      }, 1500);
    } else {
      console.log(`[Bot] ⚠ --goto 형식 오류: "${GOTO}" (예: --goto "100,64,-200")`);
    }
  }

  // [self-test] --gotorel "dx,dz": 현재 위치 기준 상대 목적지(+선택적 경로상 몹)
  if (GOTOREL && !SPAWNTEST) {
    const d = GOTOREL.split(',').map(s => parseFloat(s.trim()));
    if (d.length === 2 && !d.some(isNaN)) {
      setTimeout(() => {
        const p = bot.entity.position;
        const gx = Math.round(p.x + d[0]), gy = Math.round(p.y), gz = Math.round(p.z + d[1]);
        if (MOBONPATH) {
          let dx = gx - p.x, dz = gz - p.z;
          const L = Math.hypot(dx, dz) || 1;
          const mx = Math.round(p.x + (dx / L) * 10), my = Math.round(p.y), mz = Math.round(p.z + (dz / L) * 10);
          logEvent('mobonpath', { mob: MOBONPATH, mx, my, mz });
          console.log(`[Bot] ▶ --mobonpath ${MOBONPATH} @ (${mx},${my},${mz}) — 경로 위 소환`);
          bot.chat('/effect give @s minecraft:instant_health 1 100'); // 테스트 공정성: 시작 시 풀피
          bot.chat('/effect give @s minecraft:resistance 300 4');      // 데모와 동일: 폭발 피해 대폭 감소
          bot.chat(`/summon ${MOBONPATH} ${mx} ${my} ${mz}`);
        }
        logEvent('gotorel', { gx, gy, gz });
        console.log(`[Bot] ▶ --gotorel 목적지(XZ): (${gx}, ${gz})`);
        navigator.gotoXZ(gx, gz);
      }, 1500);
    } else {
      console.log(`[Bot] ⚠ --gotorel 형식 오류: "${GOTOREL}" (예: --gotorel "-25,-5")`);
    }
  }

  console.log('');
  console.log('[Bot] 채팅 명령어:');
  console.log('   !goto <x> <y> <z>   — 지정 좌표로 이동');
  console.log('   !explore <반경>     — 센서 퓨전 자율 탐험');
  console.log('   !stop               — 이동/도주/탐험 중지');
  console.log('   !status             — 상태 확인');
  console.log('   !threats            — 주변 위협');
  console.log('   !grid               — 로컬 그리드 맵 상태');
  console.log('   !scene              — CNN 지형 판단 상태');
  console.log('   !yolo               — YOLO 탐지 상태');
  console.log('   !spawntest <mob>    — (op필요) 전방에 몹 소환 후 통과 이동 테스트');
  console.log('   !demo <mob> [거리]  — (op필요) 원클릭 데모: 화면녹화+풀피+경로몹 소환+이동, 도착시 자동 저장');
  console.log('   !rec                — 화면(영상) 녹화 토글 → demos/*.mp4 (마인크래프트 창)');
  console.log('   !record             — 이벤트 로그(텍스트) 녹화 토글 → demos/*.log');
  console.log('[Bot] 데모 저장 폴더: C:\\KDT\\ADAS\\demos\\  | CLI: node index.js --goto "x,y,z"');
  console.log('');
});

// ── 채팅 명령어 처리 ───────────────────────────────────
bot.on('chat', (username, message) => {
  if (username === bot.username) return;

  const parts = message.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '!goto': {
      if (parts.length < 4) { bot.chat('사용법: !goto <x> <y> <z>'); return; }
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) { bot.chat('좌표는 숫자로 입력해주세요.'); return; }
      navigator.goto(x, y, z);
      break;
    }

    case '!stop': {
      navigator.stop();
      if (isScreenRecording()) { const f = stopScreenRecording(); bot.chat(`⏹️ 화면 녹화 종료·저장: ${f}`); }
      if (isRecording()) stopRecording();
      bot.chat('모든 이동 및 탐험을 멈춥니다.');
      break;
    }

    case '!탐험':
    case '!explore': {
      const radius = parts[1] ? parseInt(parts[1], 10) : 50;
      if (isNaN(radius) || radius <= 0) { bot.chat('유효한 반경(양의 숫자)을 입력해주세요.'); return; }
      navigator.explore(radius);
      bot.chat(`${radius} 블록 반경 내에서 자율 탐험을 시작합니다.`);
      break;
    }

    case '!status': {
      const pos = bot.entity.position;
      bot.chat(`📍 (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
      bot.chat(combatManager.getStatus());
      bot.chat(navigator.getStatus());
      bot.chat(mobRadar.getStatus());
      if (visionClient) bot.chat(visionClient.getStatus());
      break;
    }

    case '!threats': {
      const threats = mobRadar.getThreats();
      if (threats.length === 0) {
        bot.chat('주변에 감지된 위협 없음 ✅');
      } else {
        bot.chat(`⚠️ 감지된 위협 ${threats.length}개:`);
        threats.slice(0, 5).forEach(t => {
          bot.chat(`  ${t.displayName}: ${t.distance}m (위협: ${t.threatLevel})`);
        });
      }
      break;
    }

    case '!yolo': {
      if (visionClient) {
        bot.chat(visionClient.getStatus());
        const dets = visionClient.getAllDetections();
        if (dets.length > 0) {
          dets.slice(0, 5).forEach(d => {
            bot.chat(`  ${d.class_name} (${Math.round(d.confidence * 100)}%)`);
          });
        }
      } else {
        bot.chat('Vision 서버 미연결');
      }
      break;
    }

    case '!grid': {
      if (gridMap) {
        bot.chat(gridMap.getStatus());
        const safety = gridMap.directionSafety;
        const labels = { forward: '전방', left: '좌', right: '우', back: '후방' };
        const row = Object.entries(labels).map(([k, v]) =>
          `${v}:${safety[k] <= 0 ? 'SAFE' : 'DANGER'}`
        );
        bot.chat(row.join(' | '));
      } else {
        bot.chat('GridMap 미초기화');
      }
      break;
    }

    case '!scene': {
      if (visionClient && visionClient.isConnected) {
        const scene = visionClient.getSceneState();
        const emoji = visionClient.isSceneDangerous() ? '🔴' : '🟢';
        bot.chat(`${emoji} CNN 지형: ${scene.label} (${Math.round(scene.confidence * 100)}%)`);
      } else {
        bot.chat('Vision 서버 미연결');
      }
      break;
    }

    case '!spawntest': {
      // [self-test] 봇 op 필요. 현재 진행 방향 전방 5블록에 몹을 /summon 한 뒤,
      // 그 몹 너머로 자동 goto하여 '경로상 적대 조우'를 한 명령으로 재현한다.
      const mob = parts[1] || 'zombie';
      const p = bot.entity.position;
      const yaw = bot.entity.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const sx = Math.round(p.x + fx * 5), sy = Math.round(p.y), sz = Math.round(p.z + fz * 5);
      const gx = Math.round(p.x + fx * 20), gz = Math.round(p.z + fz * 20);
      logEvent('spawntest', { mob, sx, sy, sz, gx, gz });
      bot.chat(`/summon ${mob} ${sx} ${sy} ${sz}`);
      bot.chat(`!spawntest: ${mob} 전방 소환 → (${gx},${sy},${gz}) 통과 이동 (봇 op 필요)`);
      setTimeout(() => navigator.goto(gx, sy, gz), 600);
      break;
    }

    case '!rec': {
      // 화면(영상) 녹화 토글 → demos/demo_<시각>.mp4 (마인크래프트 창만 캡처)
      if (isScreenRecording()) {
        const f = stopScreenRecording();
        bot.chat(`⏹️ 화면 녹화 종료·저장: ${f}`);
      } else {
        const f = startScreenRecording();
        bot.chat(`🎥 화면 녹화 시작: ${f}  (다시 !rec 또는 !stop 으로 종료)`);
      }
      break;
    }

    case '!record': {
      // 이벤트 로그(텍스트) 녹화 토글 → demos/demo_<시각>.log (영상은 !rec)
      if (isRecording()) { const p = stopRecording(); bot.chat(`⏹️ 로그 녹화 종료: ${p}`); }
      else { const p = startRecording(); bot.chat(`⏺️ 로그 녹화 시작: ${p}`); }
      break;
    }

    case '!demo': {
      // !demo <몹> [거리] — 원클릭 데모: 화면 녹화 시작 + 풀피 + 경로 위 위험몹 소환 + 전방 이동.
      // 도착하면 자동으로 녹화 종료·저장(mp4 + log). (봇 op 필요)
      const mob = parts[1] || 'creeper';
      const dist = parts[2] ? Math.max(10, parseInt(parts[2], 10) || 18) : 18;
      const p = bot.entity.position;
      const yaw = bot.entity.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const gx = Math.round(p.x + fx * dist), gy = Math.round(p.y), gz = Math.round(p.z + fz * dist);
      const mx = Math.round(p.x + fx * 10), mz = Math.round(p.z + fz * 10);

      const vid = startScreenRecording();  // 화면(영상)
      startRecording();                     // 이벤트 로그도 함께
      logEvent('demo_start', { mob, dist, gx, gy, gz, mx, mz, vid });
      bot.chat(`🎬 데모 시작 — 화면 녹화: ${vid}`);
      bot.chat(`${mob} 경로 위 소환 → (${gx},${gz}) 안전 이동 (op 필요)`);
      bot.chat('/effect give @s minecraft:instant_health 1 100');  // 풀피 시작
      bot.chat('/effect give @s minecraft:resistance 300 4');       // 데모 중 폭발 피해 대폭 감소(만일의 사고 생존)
      bot.chat(`/summon ${mob} ${mx} ${gy} ${mz}`);
      setTimeout(() => navigator.gotoXZ(gx, gz), 900);  // 고도 무시(GoalNearXZ) → 올라간 구조물에서도 끼임 없이 도달
      // 안전장치: 90초 후에도 녹화 중이면 자동 종료
      setTimeout(() => {
        if (isScreenRecording() || isRecording()) {
          const f = stopScreenRecording(); stopRecording();
          bot.chat(`⏹️ (시간초과 90s) 녹화 종료·저장: ${f}`);
        }
      }, 90000);
      break;
    }
  }
});

// 데모 자동 종료: 최종 목적지 도착 시 녹화 중이면 영상·로그 저장하고 종료
bot.on('goal_reached', () => {
  if ((isScreenRecording() || isRecording()) && navigator && !navigator.isNavigating
      && navigator.destination === null && !navigator.isBypassing && !navigator.isRetreating && !navigator.isFleeing) {
    const f = stopScreenRecording();
    stopRecording();
    bot.chat(`✅ 도착 — 데모 녹화 저장 완료: ${f || '(log)'}`);
  }
});

// ── 에러/연결 처리 ─────────────────────────────────────
bot.on('error', (err) => console.error('[Bot] ❌ 에러:', err.message));

bot.on('end', (reason) => {
  console.log('[Bot] 연결 종료:', reason);
  process.exit(0);
});

bot.on('kicked', (reason) => {
  console.log('[Bot] 킥 당함:', reason);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[Bot] 종료 중...');
  // 녹화 중이면 먼저 안전 종료(ffmpeg가 mp4 finalize 할 시간 확보)
  let savedVid = null;
  try { if (isScreenRecording()) savedVid = stopScreenRecording(); if (isRecording()) stopRecording(); } catch (e) { /* 무시 */ }
  if (savedVid) console.log(`[Bot] 화면 녹화 저장: ${savedVid}`);
  if (gridMap) gridMap.stop();
  if (dataCollector) dataCollector.stop();
  if (visionClient) visionClient.stop();
  if (mobRadar) mobRadar.stop();
  if (navigator) navigator.stop();
  bot.quit();
  // ffmpeg가 'q' 받고 파일을 닫을 때까지 잠시 대기 후 종료
  setTimeout(() => process.exit(0), savedVid ? 2500 : 300);
});
