// bot/mobRadar.js
// 주변 적대적 몹을 실시간 스캔하여 위협 레벨을 계산하고 이벤트를 발행합니다.

const EventEmitter = require('events');

// 적대적 몹 목록 및 기본 위험 가중치
const HOSTILE_MOBS = {
  zombie:            { weight: 1.0, name: '좀비' },
  skeleton:          { weight: 1.2, name: '스켈레톤' },
  creeper:           { weight: 2.0, name: '크리퍼' },
  spider:            { weight: 0.8, name: '거미' },
  enderman:          { weight: 1.5, name: '엔더맨' },
  witch:             { weight: 1.3, name: '마녀' },
  pillager:          { weight: 1.4, name: '약탈자' },
  vindicator:        { weight: 1.6, name: '변명자' },
  ravager:           { weight: 2.5, name: '파괴수' },
  drowned:           { weight: 1.0, name: '드라운드' },
  husk:              { weight: 1.0, name: '허스크' },
  stray:             { weight: 1.2, name: '스트레이' },
  blaze:             { weight: 1.5, name: '블레이즈' },
  warden:            { weight: 3.0, name: '워든' },
  phantom:           { weight: 1.3, name: '팬텀' },
  zombie_villager:   { weight: 1.0, name: '좀비 주민' },
  cave_spider:       { weight: 0.9, name: '동굴거미' },
  slime:             { weight: 0.5, name: '슬라임' },
  magma_cube:        { weight: 0.7, name: '마그마 큐브' },
  ghast:             { weight: 1.8, name: '가스트' },
  hoglin:            { weight: 1.4, name: '호글린' },
  piglin_brute:      { weight: 1.6, name: '피글린 야수' },
  wither_skeleton:   { weight: 1.8, name: '위더 스켈레톤' },
};

// 즉사형(폭발/광역) 몹 — 절대 측면으로 접근하지 말고 큰 반경으로 후퇴해야 한다.
const LETHAL_MOBS = new Set(['creeper', 'ghast', 'wither', 'ravager']);

// 몹별 '안전 유지 반경'(블록). 이 거리 안으로 들어오면 회피/후퇴 필요. 치사율(weight)에 비례.
function mobClearance(name) {
  if (name === 'creeper') return 9;   // 폭발 반경 + 여유. 측면 한 발짝으로는 절대 부족.
  if (LETHAL_MOBS.has(name)) return 8;
  const info = HOSTILE_MOBS[name];
  const w = info ? info.weight : 1.0;
  return Math.max(3, Math.round(2 + w * 2)); // zombie≈4, skeleton≈4, ravager≈7
}

// 스캔 반경 (블록)
const SCAN_RADIUS = 24;
// 즉시 도주해야 하는 위험 임계값
const DANGER_THRESHOLD = 3.0;
// 스캔 주기 (ms) — 250ms로 단축하여 반응성 2배 향상
const SCAN_INTERVAL = 50; // [V5.0] 250ms → 50ms (20Hz, 게임 틱 동기화)

class MobRadar extends EventEmitter {
  constructor(bot, visionClient) {
    super();
    this.bot = bot;
    this.visionClient = visionClient || null;
    this.threats = [];
    this._interval = null;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this.scan(), SCAN_INTERVAL);
    console.log('[MobRadar] Hostile mob scan started (radius: ' + SCAN_RADIUS + ' blocks, interval: ' + SCAN_INTERVAL + 'ms)');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  scan() {
    const botPos = this.bot.entity.position;
    const entities = Object.values(this.bot.entities);

    this.threats = [];

    for (const entity of entities) {
      if (!entity || entity === this.bot.entity) continue;
      
      const mobName = entity.name;
      if (!mobName || !HOSTILE_MOBS[mobName]) continue;

      const dist = botPos.distanceTo(entity.position);
      if (dist > SCAN_RADIUS) continue;

      const mobInfo = HOSTILE_MOBS[mobName];
      // 위협 레벨 = 가중치 * (1 / 거리) * 10
      // 가까울수록 위협이 높음
      const threatLevel = mobInfo.weight * (1 / Math.max(dist, 1)) * 10;

      this.threats.push({
        entity,
        name: mobName,
        displayName: mobInfo.name,
        distance: Math.round(dist * 10) / 10,
        threatLevel: Math.round(threatLevel * 100) / 100,
        position: entity.position.clone(),
        weight: mobInfo.weight,
        lethal: LETHAL_MOBS.has(mobName),     // 크리퍼 등 즉사형
        clearance: mobClearance(mobName),     // 유지해야 할 안전 반경
      });
    }

    // 위협 높은 순 정렬
    this.threats.sort((a, b) => b.threatLevel - a.threatLevel);

    // YOLO+CNN 결과 병합 (센서 퓨전)
    if (this.visionClient && this.visionClient.isConnected) {
      const yoloThreats = this.visionClient.getDangerousDetections();
      for (const yd of yoloThreats) {
        // Mineflayer에서 이미 같은 몹을 발견했는지 확인 (중복 방지)
        const alreadyTracked = this.threats.some(t => t.name === yd.class_name && t.distance < 10);
        if (!alreadyTracked) {
          // YOLO만 발견한 몹 — Mineflayer entity 데이터가 없어 실제 좌표를 알 수 없다.
          // 봇 자기 위치(botPos)를 가짜로 넣으면 방향 계산이 망가지므로 position을 null로 둔다.
          // (getForwardThreats/getAvoidDirection은 source:'yolo' 또는 position 없는 위협을 방향 계산에서 제외)
          this.threats.push({
            entity: null,
            name: yd.class_name,
            displayName: '[YOLO] ' + yd.class_name,
            distance: 10,  // 추정거리
            threatLevel: yd.danger_score * 5,
            position: null,
            source: 'yolo',
            lethal: LETHAL_MOBS.has(yd.class_name),
            clearance: mobClearance(yd.class_name),
          });
        }
      }
      this.threats.sort((a, b) => b.threatLevel - a.threatLevel);
    }

    if (this.threats.length > 0) {
      const maxThreat = this.threats[0];
      this.emit('threatsDetected', this.threats);

      if (maxThreat.threatLevel >= DANGER_THRESHOLD) {
        this.emit('dangerClose', maxThreat);
      }
    }
  }

  getThreats() {
    return this.threats;
  }

  /**
   * 봇의 진행 방향(yaw) 기준 전방 시야각 내에 있는 위협만 반환.
   * Mineflayer 좌표 기반이므로 텍스쳐/밝기에 영향받지 않음.
   * @param {number} maxDist - 최대 감지 거리 (기본 12블록)
   * @param {number} fovDeg - 전방 시야각 (기본 120도, 좌우 60도)
   * @returns {Array} 전방 위협 목록 (가까운 순 정렬)
   */
  getForwardThreats(maxDist = 12, fovDeg = 120) {
    if (!this.bot.entity) return [];
    const botPos = this.bot.entity.position;
    const yaw = this.bot.entity.yaw;
    // Mineflayer yaw: 봇이 바라보는 방향 벡터 (-sin(yaw), -cos(yaw))
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const halfFov = (fovDeg / 2) * (Math.PI / 180);

    return this.threats
      .filter(t => {
        // YOLO 단독 위협은 실제 좌표가 없어(position:null) 방향/각도 계산을 오염시키므로 제외.
        // (화면 기반 YOLO 위협은 index.js의 YOLO 전용 루프가 별도로 처리)
        if (t.source === 'yolo' || !t.position) return false;
        if (t.distance > maxDist) return false;
        // 봇→몹 방향 벡터 계산
        const dx = t.position.x - botPos.x;
        const dz = t.position.z - botPos.z;
        const dist2d = Math.sqrt(dx * dx + dz * dz);
        if (dist2d < 0.5) return true; // 매우 가까우면 방향 무관하게 위협
        // 전방 벡터와 몹 방향의 각도 계산
        const dot = (forwardX * dx + forwardZ * dz) / dist2d;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        return angle <= halfFov;
      })
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * 가장 가까운 위협의 회피 방향을 계산.
   * @param {object} threat - 위협 객체
   * @returns {'left'|'right'} 회피 방향
   */
  getAvoidDirection(threat) {
    if (!this.bot.entity || !threat.position) return 'left';
    const botPos = this.bot.entity.position;
    const yaw = this.bot.entity.yaw;
    // 봇의 오른쪽 벡터: yaw를 90도 회전
    const rightX = -Math.sin(yaw - Math.PI / 2);
    const rightZ = -Math.cos(yaw - Math.PI / 2);
    // 몹이 봇 기준 오른쪽에 있으면 왼쪽으로 회피, 반대도 마찬가지
    const dx = threat.position.x - botPos.x;
    const dz = threat.position.z - botPos.z;
    const dot = rightX * dx + rightZ * dz;
    return dot > 0 ? 'left' : 'right';
  }

  /**
   * 방향 무관(360°) 반경 내 위협 — 실제 좌표가 있는 것만. 후퇴/군집 판단용.
   * @param {number} radius
   * @returns {Array} 가까운 순
   */
  getNearbyThreats(radius = SCAN_RADIUS) {
    return this.threats
      .filter(t => t.position && t.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * 주어진 위협들의 (위협도 가중) 중심점. 다중 몹에서 '군집 중심 반대'로 후퇴하기 위함.
   * @returns {{x:number,z:number}|null}
   */
  getThreatCentroid(threats) {
    const pts = (threats || this.threats).filter(t => t.position);
    if (pts.length === 0) return null;
    let x = 0, z = 0, wsum = 0;
    for (const t of pts) {
      const w = Math.max(0.1, t.threatLevel || 1);
      x += t.position.x * w;
      z += t.position.z * w;
      wsum += w;
    }
    return { x: x / wsum, z: z / wsum };
  }

  getStatus() {
    if (this.threats.length === 0) return '안전 ✅';
    const top = this.threats[0];
    return `⚠️ ${top.displayName} ${top.distance}m (위협: ${top.threatLevel})`;
  }
}

module.exports = { MobRadar, HOSTILE_MOBS, SCAN_RADIUS, DANGER_THRESHOLD };
