// bot/dataCollector.js
// 봇의 주행 상태(safe, blocked, danger)를 주기적으로 평가하여
// Python Vision Server(/collect)로 전송해 스냅샷 데이터를 자동으로 수집합니다.

const http = require('http');

const VISION_COLLECT_URL = 'http://localhost:5000/collect';
const COLLECT_INTERVAL = 1000; // 1초마다 평가 및 수집

class DataCollector {
  constructor(navigator, mobRadar, visionClient) {
    this.navigator = navigator;
    this.mobRadar = mobRadar;
    this.visionClient = visionClient;
    this._interval = null;
    this.hazardStuckCount = 0;
    this.lastHazardTime = 0;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this.collectStep(), COLLECT_INTERVAL);
    console.log('[DataCollector] 자동 데이터 수집 시작 (1초 간격)');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      console.log('[DataCollector] 자동 데이터 수집 중지');
    }
  }

  collectStep() {
    if (!this.visionClient || !this.visionClient.isConnected) return; // 비전 서버 없으면 수집 불가

    let state = '0_safe';

    // 1. 치명적 환경(용암, 절벽, 물)을 최우선으로 검사
    const hazard = this.checkEnvironmentalHazard();
    if (hazard) {
      state = hazard; // '2_danger_lava' / '2_danger_cliff' / '2_danger_water'
      
      // 사용자의 '순수 화면 학습 보존' 요청에 따라, 위험 환경을 마주쳤을 때 억지로 점프해서 도망치는 
      // 물리적 긴급회피 행동을 생략합니다. (PathFinder의 자율주행과 수동 라벨링에 온전히 의존함)
    } else {
      // 2. Danger 판별: 긴급 도주 중, 차선 변경 회피 중, 또는 5m 이내에 몹이 있을 때
      const hasImminentThreat = this.mobRadar.getThreats().some(t => t.distance < 5.0 && t.threatLevel > 0);
      if (this.navigator.isFleeing || this.navigator.isAvoiding || hasImminentThreat) {
        state = '2_danger';
      } 
      // 3. Blocked 판별: 끼임(stuck) 루틴이 발동 중이거나 목표 지점에 도달하지 못한 채 멈춰있을 때
      else if ((this.navigator._stuckMs || 0) >= 500) {
        state = '1_blocked';
      }
      // 4. 그렇지 않으면 0_safe
    }

    this.sendCollectRequest(state);
  }

  sendCollectRequest(state) {
    const postData = JSON.stringify({ state });

    const req = http.request(VISION_COLLECT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 1000
    }, (res) => {
      // 응답 무시 (스냅샷 저장 비동기 처리 완료)
      res.on('data', () => {});
    });

    req.on('error', (err) => {
      // 무시가능한 단발성 에러
    });

    req.write(postData);
    req.end();
  }

  checkEnvironmentalHazard() {
    if (!this.navigator.bot || !this.navigator.bot.entity) return null;
    
    // 봇이 점프 중이거나 허공에 떠있을 때는 Y고도의 착각(False Positive 절벽)을 방지하기 위해 스캔 생략
    if (!this.navigator.bot.entity.onGround) return null;

    const pos = this.navigator.bot.entity.position;
    const yaw = this.navigator.bot.entity.yaw;

    // 전방 1~3블록 벡터 (Mineflayer yaw 기준: -Math.sin(yaw), -Math.cos(yaw))
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);

    for (let i = 1; i <= 3; i++) {
        // 소수점 스무딩 렌더링 보정용 offset
        const checkPos = pos.offset(dx * i, 0, dz * i);
        
        // 용암 및 바다 감지 (발 및 눈 높이)
        const blockAtFeet = this.navigator.bot.blockAt(checkPos.offset(0, -0.5, 0)); 
        const blockEyeLevel = this.navigator.bot.blockAt(checkPos.offset(0, 1, 0));
        
        if (blockAtFeet && blockAtFeet.name === 'lava') return '2_danger_lava';
        if (blockEyeLevel && blockEyeLevel.name === 'lava') return '2_danger_lava';

        if (blockAtFeet && blockAtFeet.name === 'water') return '2_danger_water';
        if (blockEyeLevel && blockEyeLevel.name === 'water') return '2_danger_water';

        // 화염/함정 지형 감지
        const isFire = (b) => b && ['fire', 'soul_fire', 'campfire', 'magma_block'].includes(b.name);
        const isTrap = (b) => b && ['cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb'].includes(b.name);

        if (isFire(blockAtFeet) || isFire(blockEyeLevel)) return '2_danger_fire';
        if (isTrap(blockAtFeet) || isTrap(blockEyeLevel)) return '2_danger_trap';

        // 절벽(Cliff) 감지: 봇 앞 블록부터 바닥으로 3칸 연속 허공일 때 치명적 낙하로 간주
        const b0 = this.navigator.bot.blockAt(checkPos.offset(0, -1, 0));
        const b1 = this.navigator.bot.blockAt(checkPos.offset(0, -2, 0));
        const b2 = this.navigator.bot.blockAt(checkPos.offset(0, -3, 0));
        
        if (b0 && b1 && b2) {
            if (this.isAir(b0) && this.isAir(b1) && this.isAir(b2)) {
                return '2_danger_cliff';
            }
        }
    }
    return null;
  }

  isAir(block) {
      if (!block) return true;
      return block.boundingBox === 'empty' || block.name === 'air' || block.name === 'cave_air';
  }
}

module.exports = { DataCollector };
