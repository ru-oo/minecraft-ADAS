// bot/navigator.js
// mineflayer-pathfinder 기반 좌표 자동 이동 모듈
// 위험 몹 감지 시 경로를 우회하거나 도주합니다.

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalNearXZ, GoalInvert, GoalFollow } = goals;
const { HOSTILE_MOBS } = require('./mobRadar');
const { logEvent } = require('./logger');

class Navigator {
  constructor(bot) {
    this.bot = bot;
    this.isNavigating = false;
    this.destination = null;
    this.isFleeing = false;
    this.isAvoiding = false;
    this.isRetreating = false;   // 위협 군집 중심 반대로 후퇴 중
    this._retreatInterval = null;
    this.isExploring = false;
    this._xzMode = false;        // true면 목적지를 x·z만으로 도달(고도 무시, GoalNearXZ). 데모/험지용.
    this.exploreRadius = 50;
    this.exploreOrigin = null;
    this._statusInterval = null;
    this._stuckInterval = null;
    this._lastPos = null;
    this._stuckMs = 0;
    this.currentPath = [];
    this._init();
  }

  _init() {
    // pathfinder 플러그인 로드
    this.bot.loadPlugin(pathfinder);

    this.bot.once('spawn', () => {
      const mcData = require('minecraft-data')(this.bot.version);
      this.movements = new Movements(this.bot, mcData);

      // 적대 몹 회피 설정
      const hostileNames = Object.keys(HOSTILE_MOBS);
      for (const name of hostileNames) {
        const entityType = mcData.entitiesByName[name];
        if (entityType) {
          this.movements.entitiesToAvoid.add(entityType.id);
        }
      }

      // 이동 설정 (야생 탐험에 최적화)
      this.movements.canDig = false;         // 블록 파괴 금지
      this.movements.allowFreeMotion = false; // 물리 뚫림(맵 투사/Clipping) 방지를 위해 엄격 틱 적용
      this.movements.allowSprinting = true;   // [목표] 회피 후 몹을 따돌리고 목적지까지 도달하려면 달리기 필요
      this.movements.allowParkour = false;    // 비현실적인 파쿠르/틈새 점프 금지
      this.movements.allow1by1towers = false; // 수직 기둥 탑 쌓으며 올라가기 철저히 금지
      this.movements.canOpenDoors = true;     // 문 열기 허용
      this.movements.scaffoldingBlocks = [];  // 발판 설치 금지
      this.movements.maxDropDown = 2;         // [V3.9] 3블록 이상의 절벽에 스스로 뛰어내리는 행위(낙하) 금지

      // ADAS 차량 특성 반영: 물과 용암을 절대 통과하지 않도록 회피 블록으로 추가
      if (mcData.blocksByName.water) this.movements.blocksToAvoid.add(mcData.blocksByName.water.id);
      if (mcData.blocksByName.lava) this.movements.blocksToAvoid.add(mcData.blocksByName.lava.id);

      // 차량 특징 명확화: 나무 기둥, 나뭇잎, 울타리 등 식물/구조물 위를 밟고 올라타는 산악 등반 행위 방지 및 추가 위험 요소
      const avoidKeywords = [
        'log', 'leaves', 'wood', 'stem', 'hyphae', 'fence', 'wall',
        'fire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'magma_block', 'cobweb'
      ];
      for (const block of mcData.blocksArray) {
        if (avoidKeywords.some(w => block.name.includes(w))) {
          this.movements.blocksToAvoid.add(block.id);
        }
      }

      this.bot.pathfinder.setMovements(this.movements);
      console.log('[Navigator] pathfinder 초기화 완료 (점프/달리기/파쿠르 활성화)');
    });

    // 이동 완료 이벤트
    this.bot.on('goal_reached', () => {
      if (this.isFleeing || this.isAvoiding) {
        return;
      }

      // 1. 우회 기동 목적지에 도착했을 경우
      if (this.isBypassing) {
        console.log('[Navigator] 🔄 장애물 우회 완료. 최종 목적지로 경로를 다시 계산합니다.');
        this.isBypassing = false;
        if (this.destination && !this.isExploring) {
          this._resumeDestination(); // 기존 목적지로 재출발(모드 유지)
        } else if (this.isExploring) {
          this._nextExplorePoint();
        }
        return; // 여기서 이벤트 종료
      }

      // 2. 청크 단절로 인한 부분 경로 도착일 경우
      if (this.destination && !this.isExploring) {
        const pos = this.bot.entity.position;
        const dist = this._xzMode
          ? Math.round(Math.hypot(pos.x - this.destination.x, pos.z - this.destination.z))
          : this._distanceTo(this.destination.x, this.destination.y, this.destination.z);
        if (dist > 5) {
          console.log('[Navigator] 청크 경계 도달. 남은 거리: ' + dist + '블록. 경로를 이어서 탐색합니다.');
          this._resumeDestination();
          return;
        }
      }

      // 3. 진짜 최종 목적지 도착일 경우
      logEvent('goal_reached', { x: this.destination && this.destination.x, z: this.destination && this.destination.z });
      console.log('[Navigator] ✅ 최종 목적지 도착 완료.');
      this.isNavigating = false;
      this.destination = null;
      this._stopAllIntervals();

      if (this.isExploring) {
        setTimeout(() => this._nextExplorePoint(), 2000);
      } else {
        this.bot.chat('목적지에 도착했습니다.');
      }
    });

    // 경로 찾기 실패
    this.bot.on('path_update', (r) => {
      this.currentPath = r.path || [];

      if (r.status === 'noPath') {
        logEvent('no_path', { count: (this._noPathCount || 0) + 1 });
        this._noPathCount = (this._noPathCount || 0) + 1;
        if (this._noPathCount >= 5) {
          console.log('[Navigator] 🚨 경로 탐색 불가(noPath) 무한 루프 감지! 강제 자살(/kill)');
          this.bot.chat('/kill');
          this.bot.chat('길이 없는 구역(용암/미로)에 갇혀 리스폰합니다!');
          this._noPathCount = 0;
          return;
        }

        if (this.isExploring) {
          console.log(`[Navigator] ❌ 험지/접근 불가(noPath ${this._noPathCount}/5). 점프 후 새 탐험 좌표를 탐색합니다.`);
          this.bot.setControlState('jump', true);
          setTimeout(() => {
            this.bot.setControlState('jump', false);
            this._nextExplorePoint();
          }, 1000);
        } else {
          console.log(`[Navigator] ❌ 경로를 찾을 수 없습니다(noPath ${this._noPathCount}/5). 점프 후 재시도합니다...`);
          // 즉시 포기하지 않고 점프 후 재시도
          this.bot.setControlState('jump', true);
          setTimeout(() => {
            this.bot.setControlState('jump', false);
            // 2초 후 경로 재계산
            if (this.destination) {
              setTimeout(() => {
                if (this.destination && !this.isExploring) {
                  this._setDestGoal(2);
                }
              }, 2000);
            }
          }, 500);
        }
      } else if (r.status === 'success') {
        if (this._noPathCount) logEvent('path_found', { nodes: this.currentPath.length });
        this._noPathCount = 0; // 성공적으로 경로를 하나라도 찾으면 초기화
      }
    });

    // 사망 시 자동 탐험 재개 처리
    this.bot.on('death', () => {
      logEvent('death', { exploring: this.isExploring });
      console.log('[Navigator] 💀 봇이 사망했습니다. 진행 중인 경로 초기화.');

      const wasExploring = this.isExploring;
      this.bot.pathfinder.setGoal(null);
      this.isNavigating = false;
      this.isFleeing = false;
      this.isAvoiding = false;
      this.isRetreating = false;
      if (this._retreatInterval) { clearInterval(this._retreatInterval); this._retreatInterval = null; }
      this.destination = null;
      this._stopAllIntervals();

      if (wasExploring) {
        console.log('[Navigator] 탐험 모드 중 사망! 리스폰 완료 시 탐험을 자동 재개합니다.');
        this.bot.once('spawn', () => {
          setTimeout(() => {
            console.log('[Navigator] 리스폰 완료. 탐험 재개!');
            this.isExploring = true;
            this.exploreOrigin = this.bot.entity.position.clone();
            this._nextExplorePoint();
          }, 3000); // 리스폰 후 3초 대기
        });
      } else {
        this.isExploring = false;
      }
    });
  }

  /**
   * 지정된 좌표로 이동을 시작합니다.
   */
  goto(x, y, z, range = 2) {
    if (this.isFleeing) {
      console.log('[Navigator] 현재 도주 중이므로 이동 명령을 무시합니다.');
      return;
    }

    this._xzMode = false;
    this.destination = { x, y, z };
    this.isNavigating = true;
    this._stuckMs = 0;

    const goal = new GoalNear(x, y, z, range);
    this.bot.pathfinder.setGoal(goal, false);

    const dist = this._distanceTo(x, y, z);
    logEvent('nav_start', { x, y, z, dist });
    console.log('[Navigator] 이동 시작: (' + x + ', ' + y + ', ' + z + ') -- 거리: ' + dist + '블록');
    this.bot.chat('이동 시작: (' + x + ', ' + y + ', ' + z + ') -- 거리: ' + dist + '블록');

    this._startStatusUpdates();
    this._startStuckDetection();
  }

  /**
   * [데모/험지] x·z 위치로만 이동(고도 무시 — GoalNearXZ). 목적지가 올라간 구조물 위라도
   * 봇이 그 x,z 컬럼에 도달하면 완료로 간주 → '도달 불가 고도'에서 끼이는 문제 방지.
   */
  gotoXZ(x, z, range = 2) {
    if (this.isFleeing) return;
    this._xzMode = true;
    this.destination = { x, y: Math.round(this.bot.entity.position.y), z };
    this.isNavigating = true;
    this._stuckMs = 0;

    this.bot.pathfinder.setGoal(new GoalNearXZ(x, z, range), false);

    const dist = Math.round(Math.hypot(this.bot.entity.position.x - x, this.bot.entity.position.z - z));
    logEvent('nav_start', { x, z, mode: 'xz', dist });
    console.log(`[Navigator] 이동 시작(XZ): (${x}, ${z}) -- 거리: ${dist}블록`);
    this.bot.chat(`이동 시작: (${x}, ${z}) -- 거리: ${dist}블록`);

    this._startStatusUpdates();
    this._startStuckDetection();
  }

  // 현재 모드(_xzMode)에 맞춰 목적지로 복귀 이동.
  _resumeDestination() {
    if (!this.destination) return;
    if (this._xzMode) this.gotoXZ(this.destination.x, this.destination.z);
    else this.goto(this.destination.x, this.destination.y, this.destination.z);
  }

  // 현재 모드에 맞춰 pathfinder 목표만 목적지로 재설정(이동 상태 유지·재계획용).
  _setDestGoal(range = 2) {
    if (!this.destination) return;
    const d = this.destination;
    const goal = this._xzMode ? new GoalNearXZ(d.x, d.z, range) : new GoalNear(d.x, d.y, d.z, range);
    this.bot.pathfinder.setGoal(goal, false);
  }

  /**
   * 현재 이동을 중단합니다.
   */
  stop() {
    this.bot.pathfinder.setGoal(null);
    this.isNavigating = false;
    this.isFleeing = false;
    this.isAvoiding = false;
    this.isRetreating = false;
    this.isBypassing = false;
    if (this._retreatInterval) { clearInterval(this._retreatInterval); this._retreatInterval = null; }
    this.isExploring = false;
    this.destination = null;
    this._stopAllIntervals();
    logEvent('nav_stop', {});
    console.log('[Navigator] 이동/탐험 중단');
  }

  /**
   * (호환용) 단일 위협으로부터 도주 — 내부적으로 retreatFrom으로 위임.
   */
  fleeFrom(threat) {
    if (!threat || !threat.position) return;
    this.retreatFrom({ x: threat.position.x, z: threat.position.z }, 10);
  }

  /**
   * [재설계+튜닝] 위협(군집) 중심 반대로 '실제로 안전해질 때까지' 지속 후퇴한다.
   * 핵심 튜닝: 고정 중심이 아니라 opts.live()로 매 틱 라이브 위협을 재평가해 목표를 갱신한다.
   * → 추격 몹(크리퍼)이 따라붙어도 후퇴가 조기 종료되어 재발동되는 'stutter' 없이,
   *   현재 위협 위치 반대로 계속 물러나며 한 번의 연속 기동으로 거리를 벌린다.
   * @param {{x:number,z:number}} centroid — 초기 위협 군집 중심
   * @param {number} safeRadius — 확보해야 할 안전 거리(블록)
   * @param {{live?: () => ({centroid:{x:number,z:number}, minDist:number}|null)}} [opts]
   */
  retreatFrom(centroid, safeRadius = 10, opts = {}) {
    if (!centroid || !this.bot.entity) return;
    const alreadyRetreating = this.isRetreating;

    this.isFleeing = true;
    this.isRetreating = true;
    this.isAvoiding = false;
    this.isBypassing = false;
    this._retreatLive = (typeof opts.live === 'function') ? opts.live : null;

    const target = this._setRetreatGoal(centroid, safeRadius);
    if (!alreadyRetreating) {
      logEvent('retreat_start', {
        safeRadius, cx: Math.round(centroid.x), cz: Math.round(centroid.z), tx: target.x, tz: target.z,
      });
      console.log(`[Navigator] 🛡️ 위협 중심 반대로 지속 후퇴 (안전반경 ${safeRadius}m).`);
      this._monitorRetreat(safeRadius);
    }
  }

  // centroid 반대 방향 safeRadius+여유 지점으로 pathfinder 목표 설정. (지형은 A*가 우회)
  _setRetreatGoal(centroid, safeRadius) {
    const pos = this.bot.entity.position;
    let dx = pos.x - centroid.x, dz = pos.z - centroid.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.001) { dx = -Math.sin(this.bot.entity.yaw); dz = -Math.cos(this.bot.entity.yaw); len = 1; }
    const reach = safeRadius + 3;
    const vec3 = require('vec3');
    const target = new vec3(
      Math.floor(pos.x + (dx / len) * reach),
      Math.floor(pos.y),
      Math.floor(pos.z + (dz / len) * reach)
    );
    const goal = new GoalNear(target.x, target.y, target.z, 1);
    this.bot.pathfinder.setGoal(goal, false);
    return target;
  }

  // 라이브 위협을 재평가하며 지속 후퇴. 위협이 safeRadius 밖이거나 사라지면(또는 8s) 종료→복귀.
  _monitorRetreat(safeRadius) {
    if (this._retreatInterval) clearInterval(this._retreatInterval);
    const startedAt = Date.now();
    this._retreatInterval = setInterval(() => {
      if (!this.isRetreating) { clearInterval(this._retreatInterval); this._retreatInterval = null; return; }
      const elapsed = Date.now() - startedAt;
      const live = this._retreatLive ? this._retreatLive() : null;
      // 라이브 정보가 없으면(combat 호출 등) 시간 기반으로만 종료
      const minDist = live ? live.minDist : Infinity;
      const clear = !live || minDist >= safeRadius;

      if (clear || elapsed > 8000) {
        clearInterval(this._retreatInterval);
        this._retreatInterval = null;
        this.isRetreating = false;
        this.isFleeing = false;
        logEvent('retreat_end', { durMs: elapsed, minDist: isFinite(minDist) ? Math.round(minDist) : -1, reason: clear ? 'safe' : 'timeout' });
        if (this.isExploring) this._nextExplorePoint();
        else if (this.destination) this._resumeDestination();
      } else {
        // 아직 위협이 가까움 → 라이브 중심 반대로 목표 재설정(연속 후퇴)
        this._setRetreatGoal(live.centroid, safeRadius);
      }
    }, 250);
  }

  /**
   * [V5.1/item2] 몹 회피 전용 '부드러운 단일 측면 우회'.
   * physicsEvade의 물리 푸시 없이 pathfinder로 측면 안전 지점을 한 번 경유한 뒤 원래
   * 목적지로 복귀한다. 복귀는 goal_reached의 isBypassing 분기가 처리하므로 우회→복귀가
   * 끊김 없이 한 번에 이어진다. (지형은 pathfinder가 알아서 피함)
   * @param {'left'|'right'} direction — 회피할 측면 (gridMap.getBestAvoidDirection 결과)
   */
  bypassMob(direction = 'left', clearance = 5) {
    if (this.isFleeing || this.isAvoiding || this.isRetreating) return;

    const pos = this.bot.entity.position;
    const yaw = this.bot.entity.yaw;
    const d = Math.max(4, clearance); // 회피 폭은 몹 clearance에 비례(비치명 몹만 여기로 옴)

    // 부드러운 호: 측면 d + 전방 약간(2)으로 목표 진행을 유지한 채 비켜간다.
    // 측면 벡터는 기존 avoidObstacle과 동일 규약(+sin/+cos), 전방은 (-sin/-cos).
    const vec3 = require('vec3');
    const lat = direction === 'left' ? yaw + (Math.PI / 2) : yaw - (Math.PI / 2);
    const bx = pos.x + Math.sin(lat) * d + (-Math.sin(yaw)) * 2;
    const bz = pos.z + Math.cos(lat) * d + (-Math.cos(yaw)) * 2;
    const bypass = new vec3(Math.floor(bx), Math.floor(pos.y), Math.floor(bz));

    this.isNavigating = true;
    this.isBypassing = true; // 도착 시 goal_reached(isBypassing)가 원래 목적지로 자동 복귀
    logEvent('bypass_start', { dir: direction, clearance: d, tx: bypass.x, tz: bypass.z });
    console.log(`[Navigator] 🐾 몹 회피: ${direction} 측면 ${d}블록 우회 → 복귀`);

    const bypassGoal = new GoalNear(bypass.x, bypass.y, bypass.z, 2);
    this.bot.pathfinder.setGoal(bypassGoal, false);

    // 안전 타이머: 우회 지점에 닿지 못해도 일정 시간 뒤 강제 복귀(끼임 방지)
    setTimeout(() => {
      if (!this.isBypassing) return;
      this.isBypassing = false;
      logEvent('bypass_end', { reason: 'timeout' });
      if (this.isExploring) {
        this._nextExplorePoint();
      } else if (this.destination) {
        this._resumeDestination();
      }
    }, 3000);
  }

  /**
   * [V5.0] Pathfinder를 우회하는 즉각 물리 회피. 3블록 이내 긴급 반사 전용.
   * 위협이 코앞에 있을 때 A* 연산 없이 bot.setControlState()로 즉시 몸을 피합니다.
   *
   * [item3] 기본 회피 방향을 'back'(후진) 대신 측면('left')으로 둔다. 'back'은 3블록 이내
   * 긴급(정면 막힘/고착)에서만 호출부가 명시적으로 넘긴다.
   * @param {'left'|'right'|'back'} direction — 회피 방향 (기본: 측면 left)
   * @param {number} durationMs — 회피 지속 시간 (기본: 600ms, 상한 600)
   */
  physicsEvade(direction = 'left', durationMs = 600) {
    if (this.isAvoiding) return;

    const now = Date.now();
    if (now - this.lastEvadeTime < 3000) {
      this.evadeCount++;
    } else {
      this.evadeCount = 1;
    }
    this.lastEvadeTime = now;

    let actualDir = direction;

    if (this.evadeCount >= 4) {
      console.log('[Navigator] 고착 상태 감지: 180도 후퇴 기동 실행');
      actualDir = 'back';
      durationMs = 1500;
      this.evadeCount = 0;
    }

    logEvent('evade_start', { dir: actualDir, durMs: Math.min(durationMs, 600) });
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();

    const wasNavigating = this.isNavigating;
    const wasExploring = this.isExploring;
    const savedDest = this.destination;

    this.isAvoiding = true;
    this.isBypassing = false;

    const currentYaw = this.bot.entity.yaw;
    let targetYaw = currentYaw;

    if (actualDir === 'back') targetYaw = currentYaw + Math.PI;
    else if (actualDir === 'left') targetYaw = currentYaw + (Math.PI / 2);
    else if (actualDir === 'right') targetYaw = currentYaw - (Math.PI / 2);

    this.bot.look(targetYaw, 0, true);

    this.bot.setControlState('forward', true);
    // 물리적 충돌로 틈새에 끼이는 현상을 막기 위해 맹목적인 점프와 스프린트는 해제합니다.
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    // [P2] 호출부(600~800ms, 고착탈출 1500ms)가 요청한 회피 시간이 실제로 반영되도록
    // 상한을 300 → 600ms로 상향. (300ms로 깎으면 짧게 피하고 바로 플래너에 제어권을
    // 돌려줘서 진동 주파수만 높아짐) 벽 박힘 방지를 위해 600ms 상한은 유지.
    const actualDuration = Math.min(durationMs, 600);

    setTimeout(() => {
      this.bot.clearControlStates();
      this.isAvoiding = false;
      logEvent('evade_end', { dir: actualDir });

      if (wasExploring) {
        this.isExploring = true;
        this._nextExplorePoint();
      } else if (wasNavigating && savedDest) {
        // [재설계] 짧은 반사 회피 직후 곧바로 pathfinder에 제어권을 돌려준다.
        // A*가 몹/지형을 알아서 우회하는 새 경로를 즉시 계산 → 4초 idle/끼임 제거.
        this.destination = savedDest;
        this.isNavigating = true;
        this._setDestGoal(2); // 현재 모드(_xzMode)에 맞춰 목적지로 재계획
      }
    }, actualDuration);
  }

  /**
   * 자유 탐험 모드 (지정 반경 내 무작위 좌표 연속 이동)
   */
  explore(radius = 50) {
    if (this.isFleeing) {
      console.log('[Navigator] 긴급 도주 중이므로 탐색 불가능.');
      return;
    }
    this.isExploring = true;
    this.exploreRadius = radius;
    // 탐험 원점이 없으면 현재 위치를 기준으로 설정
    if (!this.exploreOrigin) {
      this.exploreOrigin = this.bot.entity.position.clone();
    }

    console.log(`[Navigator] 자율 탐험 모드 시작 (반경 ${radius}블록)`);
    this.bot.chat(`자율 탐험을 시작합니다. (반경 ${radius}블록)`);
    this._nextExplorePoint();
  }

  _nextExplorePoint() {
    if (!this.isExploring) return;

    // 매 탐험마다 현재 봇의 위치를 원점으로 갱신
    this.exploreOrigin = this.bot.entity.position.clone();

    // [V4.1] 자동차 주행 시뮬레이션 개선:
    // 이전보다 좁은 편향(±25도)으로 직진성을 높여 두리번거림 감소
    const currentYaw = this.bot.entity.yaw;
    // ±25도 이내의 부드러운 방향 전환 (기존 ±45도 → ±25도)
    const deviation = (Math.random() - 0.5) * (Math.PI / 3.6);
    const targetAngle = currentYaw + deviation;

    // 전방으로 30~60블록 전진 (기존 20~50 → 30~60, 더 긴 직선 주행)
    const r = 30 + Math.random() * 30;

    // Mineflayer Yaw 기준: -sin이 X, -cos이 Z
    const x = Math.round(this.exploreOrigin.x - Math.sin(targetAngle) * r);
    const z = Math.round(this.exploreOrigin.z - Math.cos(targetAngle) * r);

    console.log(`[Navigator] 자동차 모드 전진 목표: (${x}, ${z}) [편향: ${Math.round(deviation * 180 / Math.PI)}°]`);

    // y좌표는 현재 봇의 y와 비슷하게 넘겨주면 pathfinder가 알아서 길을 찾음
    this.goto(x, Math.round(this.bot.entity.position.y), z, 2);
  }

  _findSafeBypassPoint(targetYaw) {
    const vec3 = require('vec3');
    const pos = this.bot.entity.position;

    // 탐색 방향: 좌/우 90도, 좌/우 60도, 좌/우 120도, 후방 180도 순서
    const angles = [
      Math.PI / 2, -Math.PI / 2,
      Math.PI / 3, -Math.PI / 3,
      Math.PI / 1.5, -Math.PI / 1.5,
      Math.PI
    ];

    const distances = [8, 12, 16]; // 거대 지형을 크게 빗겨가기 위해 탐색 반경 확장; // 가까운 곳부터 먼 곳 순으로 탐색

    for (const dist of distances) {
      for (const offsetAngle of angles) {
        const checkAngle = targetYaw + offsetAngle;
        const bx = Math.floor(pos.x + Math.sin(checkAngle) * dist);
        const bz = Math.floor(pos.z + Math.cos(checkAngle) * dist);

        // 현재 높이 주변(위 2칸, 아래 3칸)을 스캔하여 안전한 지표면 찾기
        for (let dy = 2; dy >= -3; dy--) {
          const by = Math.floor(pos.y + dy);
          const targetPos = new vec3(bx, by, bz);

          const blockBelow = this.bot.blockAt(targetPos.offset(0, -1, 0));
          const blockLegs = this.bot.blockAt(targetPos);
          const blockHead = this.bot.blockAt(targetPos.offset(0, 1, 0));

          // 바닥이 단단한 블록이고, 다리와 머리 공간이 비어있으며, 치명적 위험 블록이 아닐 때
          if (blockBelow && blockBelow.boundingBox === 'block' &&
            !['lava', 'water', 'magma_block', 'fire', 'cactus', 'sweet_berry_bush'].includes(blockBelow.name) &&
            blockLegs && blockLegs.boundingBox === 'empty' &&
            blockHead && blockHead.boundingBox === 'empty') {
            return targetPos;
          }
        }
      }
    }
    return null; // 모든 탐색 실패 시 null 반환
  }
  /**
   * [재설계] 끼임/정지 감지 — 500ms 샘플로 빠르게 반응.
   * 일반 지형 멈춤(freeze)은 freeze_start/freeze_end(durMs)로 로깅 → 로그만으로 다중초 정지 검출.
   * 복구는 '점프 + 즉시 재계획'(~1.2s)으로 빠르게 하고 절대 후진(back)하지 않는다
   * (후진은 몹 앞에서 치명적). void/액체 보호는 유지(시간 기준으로 환산).
   */
  _startStuckDetection() {
    this._stopStuckDetection();
    this._lastPos = null;
    this._stuckMs = 0;
    this._submergedMs = 0;
    this._freezeLogged = false;
    this._freezeStart = 0;
    this._recoverAt = 0;
    this._progressAnchor = null;  // 마지막으로 '실질 진행'한 위치
    this._anchorTime = 0;         // 그 시각
    this._recoverCount = 0;

    const TICK = 500;
    this._stuckInterval = setInterval(() => {
      if (!this.isNavigating || !this.destination) { this._stuckMs = 0; return; }

      const pos = this.bot.entity.position;

      // 1. Void(맵 밖/투사) 추락 방지 (Y < -60)
      if (pos.y < -60) {
        logEvent('void_kill', {});
        console.log('[Navigator] 🚨 Void 추락 감지! 강제 리스폰!');
        this.bot.chat('/kill');
        return;
      }

      // 2. 액체(용암/물) 침수 방지 — 3초 이상 잠기면 강제 리스폰
      const blockAtBody = this.bot.blockAt(pos);
      if (blockAtBody && (blockAtBody.name === 'lava' || blockAtBody.name === 'water')) {
        this._submergedMs += TICK;
        if (this._submergedMs >= 3000) {
          logEvent('liquid_kill', { block: blockAtBody.name });
          console.log(`[Navigator] 🚨 액체(${blockAtBody.name}) 침수! 강제 리스폰!`);
          this.bot.chat('/kill');
          this._submergedMs = 0;
          return;
        }
      } else {
        this._submergedMs = 0;
      }

      // 반응형 기동(회피/우회/후퇴) 중의 멈춤은 정상 → 정지로 치지 않고 앵커만 현재로 리셋.
      const reacting = this.isAvoiding || this.isBypassing || this.isFleeing || this.isRetreating;
      const now = Date.now();

      if (reacting) {
        this._progressAnchor = pos.clone();
        this._anchorTime = now;
        if (this._freezeLogged) { logEvent('freeze_end', { durMs: now - this._freezeStart }); this._freezeLogged = false; }
      } else {
        if (!this._progressAnchor) { this._progressAnchor = pos.clone(); this._anchorTime = now; }

        // [핵심 수정] '실질 진행'(앵커 대비 2블록 이상 순이동)만 정지 카운터를 리셋한다.
        // 점프로 인한 미세 흔들림(<2블록)은 진행으로 치지 않으므로, 끼인 봇이 카운터를
        // 리셋해 영영 안 빠지던 문제를 해결. (앵커 미달 시 stuck 시간이 계속 누적)
        const net = Math.hypot(pos.x - this._progressAnchor.x, pos.z - this._progressAnchor.z);
        if (net > 2) {
          if (this._freezeLogged) { logEvent('freeze_end', { durMs: now - this._freezeStart }); this._freezeLogged = false; }
          this._progressAnchor = pos.clone();
          this._anchorTime = now;
          this._recoverCount = 0;
          this._noPathCount = 0;
        } else {
          const stuckFor = now - this._anchorTime;

          // 0.5s 이상 무진행 → freeze_start (다중초 정지를 로그에서 검출)
          if (stuckFor >= 500 && !this._freezeLogged) {
            this._freezeLogged = true;
            this._freezeStart = now;
            logEvent('freeze_start', { x: Math.round(pos.x), z: Math.round(pos.z) });
          }

          // 1.2s 이상 무진행 → 빠른 복구: 점프 + 측면 너지(좌/우 번갈아, 후진 금지) + 즉시 재계획
          if (stuckFor >= 1200 && now > this._recoverAt) {
            this._recoverAt = now + 1500;
            this._recoverCount++;
            const strafe = (this._recoverCount % 2 === 0) ? 'left' : 'right';
            logEvent('stuck_recover', { stuckMs: stuckFor, n: this._recoverCount, strafe });
            this.bot.setControlState('jump', true);
            this.bot.setControlState(strafe, true);
            setTimeout(() => { this.bot.setControlState('jump', false); this.bot.setControlState(strafe, false); }, 350);
            if (!this.isExploring) {
              this._setDestGoal(2);
            } else {
              this._nextExplorePoint();
            }
          }

          // 9s 이상 '순진행 없음' → 최후수단 리스폰(이제 미세흔들림이 막지 못함)
          if (stuckFor >= 9000) {
            logEvent('stuck_kill', { stuckMs: stuckFor });
            this.bot.chat('/kill');
            this._progressAnchor = pos.clone();
            this._anchorTime = now;
            this._recoverCount = 0;
          }
        }
      }
      this._lastPos = pos.clone();
    }, TICK);
  }

  _stopStuckDetection() {
    if (this._stuckInterval) {
      clearInterval(this._stuckInterval);
      this._stuckInterval = null;
    }
  }

  _distanceTo(x, y, z) {
    const pos = this.bot.entity.position;
    const dx = pos.x - x;
    const dy = pos.y - y;
    const dz = pos.z - z;
    return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  _startStatusUpdates() {
    this._stopStatusUpdates();
    this._statusInterval = setInterval(() => {
      if (!this.destination || !this.isNavigating) return;
      const dist = this._distanceTo(
        this.destination.x, this.destination.y, this.destination.z
      );
      const pos = this.bot.entity.position;
      console.log(
        '[Navigator] 현재: (' + Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z) + ') -> 목적지까지 ' + dist + '블록'
      );
    }, 5000);
  }

  _stopStatusUpdates() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }

  _stopAllIntervals() {
    this._stopStatusUpdates();
    this._stopStuckDetection();
  }

  getStatus() {
    if (this.isFleeing) return '도주 중';
    if (this.isAvoiding) return '우회 중';
    if (!this.isNavigating) return '대기 중';

    const dist = this._distanceTo(
      this.destination.x, this.destination.y, this.destination.z
    );
    const modeStr = this.isExploring ? '[탐험]' : '이동 중';
    return `${modeStr} -> (${this.destination.x}, ${this.destination.y}, ${this.destination.z}) [${dist}블록]`;
  }
}

module.exports = { Navigator };
