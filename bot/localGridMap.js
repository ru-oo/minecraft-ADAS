// bot/localGridMap.js
// ─────────────────────────────────────────────────────────────
// ADAS V4.2 — 2D Local Grid Map (실시간 로컬 그리드 맵)
//
// Mineflayer API 데이터로 봇 주변 5블록 반경(11x11)의 2D 그리드를
// 실시간으로 구축합니다. OpenCV 화면 캡처와 달리 게임 틱과 동기화되어
// 지연 없이 정확한 주변 환경 정보를 제공합니다.
//
// 셀 상태:
//   0 = SAFE      (걸을 수 있는 안전한 바닥)
//   1 = BLOCKED   (벽/장애물, 통과 불가)
//   2 = DANGER_TERRAIN (용암, 물, 불, 절벽 등 위험 지형)
//   3 = DANGER_MOB     (적대적 몹이 위치)
//   4 = UNKNOWN        (로드되지 않은 청크)
// ─────────────────────────────────────────────────────────────

const { HOSTILE_MOBS } = require('./mobRadar');

// 그리드 설정
const GRID_RADIUS = 5;              // 봇 중심으로 5블록 반경
const GRID_SIZE = GRID_RADIUS * 2 + 1; // 11x11
const UPDATE_INTERVAL = 50;         // [V5.0] 200ms → 50ms (20Hz, 센서 퓨전 동기화)

// 셀 상태 상수
const CELL = {
  SAFE: 0,
  BLOCKED: 1,
  DANGER_TERRAIN: 2,
  DANGER_MOB: 3,
  UNKNOWN: 4,
};

// 위험 블록 목록
const DANGER_BLOCKS = new Set([
  'lava', 'flowing_lava',
  'water', 'flowing_water',
  'fire', 'soul_fire',
  'campfire', 'soul_campfire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'powder_snow',
  'cobweb',
  'wither_rose',
]);

// 통과 불가 장애물 (벽, 울타리 등)
const BLOCKED_KEYWORDS = [
  'fence', 'wall', 'gate',
  'leaves', 'log', 'wood', 'stem', 'hyphae',
  'iron_bars', 'chain',
];

class LocalGridMap {
  constructor(bot) {
    this.bot = bot;
    this._interval = null;
    this.grid = this._createEmptyGrid();
    this.botWorldX = 0;
    this.botWorldZ = 0;
    this.botYaw = 0;
    this.mobCells = [];
    this.pathCells = [];
    this.currentPath = [];

    this.directionSafety = {
      forward: CELL.SAFE,
      left: CELL.SAFE,
      right: CELL.SAFE,
      back: CELL.SAFE,
    };
    // [P1] 정면 '바로 다음 한 칸'(dist=1, 중앙)만의 위험도. 반응형 지형 회피는 이 값만 본다.
    // (그리드 전체 위험 칸 수나 부채꼴 다수 위험으로는 절대 발동하지 않게 하기 위함)
    this.exactForwardSafety = CELL.SAFE;
  }

  setPath(pathArray) {
    this.currentPath = pathArray;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this.update(), UPDATE_INTERVAL);
    console.log(`[LocalGridMap] 실시간 그리드 맵 시작 (${GRID_SIZE}x${GRID_SIZE}, ${UPDATE_INTERVAL}ms 간격)`);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  _createEmptyGrid() {
    return Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, () => CELL.UNKNOWN)
    );
  }

  /**
   * 그리드를 Mineflayer API 데이터로 업데이트합니다.
   * 화면 캡처 없이 직접 블록/엔티티 데이터를 읽으므로 지연 0ms.
   */
  update() {
    if (!this.bot.entity) return;

    const botPos = this.bot.entity.position;
    this.botWorldX = Math.floor(botPos.x);
    this.botWorldZ = Math.floor(botPos.z);
    this.botYaw = this.bot.entity.yaw;
    const botY = Math.floor(botPos.y);

    const newGrid = this._createEmptyGrid();
    this.mobCells = [];

    // ── 1단계: 블록 스캔 (지형 분류) ──
    for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        const worldX = this.botWorldX + dx;
        const worldZ = this.botWorldZ + dz;
        const row = dz + GRID_RADIUS; // 그리드 행 (0~10)
        const col = dx + GRID_RADIUS; // 그리드 열 (0~10)

        newGrid[row][col] = this._classifyBlock(worldX, botY, worldZ);
      }
    }

    // ── 2단계: 적대적 몹 오버레이 ──
    const entities = Object.values(this.bot.entities);
    for (const entity of entities) {
      if (!entity || entity === this.bot.entity) continue;
      if (!entity.name || !HOSTILE_MOBS[entity.name]) continue;

      const dist = botPos.distanceTo(entity.position);
      if (dist > GRID_RADIUS + 1) continue; // 그리드 범위 밖

      const mobDx = Math.floor(entity.position.x) - this.botWorldX;
      const mobDz = Math.floor(entity.position.z) - this.botWorldZ;

      if (Math.abs(mobDx) <= GRID_RADIUS && Math.abs(mobDz) <= GRID_RADIUS) {
        const row = mobDz + GRID_RADIUS;
        const col = mobDx + GRID_RADIUS;
        newGrid[row][col] = CELL.DANGER_MOB;
        this.mobCells.push({
          row, col,
          name: entity.name,
          displayName: HOSTILE_MOBS[entity.name].name,
          distance: Math.round(dist * 10) / 10,
        });
      }
    }

    this.grid = newGrid;

    
    // ── 2.5단계: 경로 렌더링 데이터 생성 ──
    this.pathCells = [];
    if (this.currentPath) {
      for (const node of this.currentPath) {
        const dx = Math.floor(node.x) - this.botWorldX;
        const dz = Math.floor(node.z) - this.botWorldZ;
        if (Math.abs(dx) <= GRID_RADIUS && Math.abs(dz) <= GRID_RADIUS) {
          const row = dz + GRID_RADIUS;
          const col = dx + GRID_RADIUS;
          this.pathCells.push({ row, col });
        }
      }
    }

    this.grid = newGrid;
    this._updateDirectionSafety();
  }

  // [정리] _updateDirectionSafety / isForwardDangerous / toJSON 의 '죽은' 앞 버전을 삭제.
  // (동일 이름이 두 번 정의돼 뒤 정의가 앞을 덮어쓰므로 앞 버전은 실행되지 않던 죽은 코드)
  // 사용처 없던 exactForwardSafety도 함께 제거하여 혼동을 없앴다. 아래 살아있는 정의만 유지.

  /**
   * 월드 좌표의 블록을 분류합니다.
   * @returns {number} CELL 상태값
   */
  _classifyBlock(worldX, botY, worldZ) {
    // 발 밑 블록 (botY - 1)
    const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(
      worldX - this.botWorldX,
      -1,
      worldZ - this.botWorldZ
    ));

    // 발 높이 블록 (botY)
    const blockAtFeet = this.bot.blockAt(this.bot.entity.position.offset(
      worldX - this.botWorldX,
      0,
      worldZ - this.botWorldZ
    ));

    // 머리 높이 블록 (botY + 1)
    const blockAtHead = this.bot.blockAt(this.bot.entity.position.offset(
      worldX - this.botWorldX,
      1,
      worldZ - this.botWorldZ
    ));

    // 로드되지 않은 청크
    if (!blockBelow && !blockAtFeet) return CELL.UNKNOWN;

    // 위험 지형 체크 (발/머리 높이)
    if (blockAtFeet && DANGER_BLOCKS.has(blockAtFeet.name)) return CELL.DANGER_TERRAIN;
    if (blockAtHead && DANGER_BLOCKS.has(blockAtHead.name)) return CELL.DANGER_TERRAIN;
    if (blockBelow && DANGER_BLOCKS.has(blockBelow.name)) return CELL.DANGER_TERRAIN;

    // [P2] 절벽 감지 — '실제 수직 낙하'(연속 3칸 이상 공중이 곧장 아래로)만 위험으로 본다.
    // 걸어 내려갈 수 있는 한두 칸 단차(완만한 내리막)는 DANGER로 잡지 않는다(pathfinder가 처리).
    // movements.maxDropDown=2 → 발밑 1~2칸 안에 단단한 바닥이 있으면 걸어 내려갈 수 있는 지형.
    const CLIFF_FALL = 3; // 이 깊이까지 '연속으로 모두 공중'일 때만 절벽으로 판정
    if (blockBelow && this._isAir(blockBelow)) {
      let solidFloorFound = false; // 1~2칸 안에 바닥이 있으면(완만한 단차) 절벽 아님
      let allAir = true;
      for (let d = 2; d <= CLIFF_FALL; d++) {
        const b = this.bot.blockAt(this.bot.entity.position.offset(
          worldX - this.botWorldX, -d, worldZ - this.botWorldZ
        ));
        // 미로드(null) 블록은 '공중'으로 단정하지 않는다 → 청크 경계의 가짜 절벽 방지
        if (!b) { allAir = false; break; }
        if (!this._isAir(b)) { solidFloorFound = true; break; }
      }
      if (allAir && !solidFloorFound) {
        return CELL.DANGER_TERRAIN; // 연속 3칸 이상 수직 낙하 = 진짜 절벽
      }
    }

    // 통과 불가 장애물 (발/머리 높이에 고체 블록)
    if (blockAtFeet && blockAtFeet.boundingBox === 'block') {
      // 장애물 키워드 매칭
      if (BLOCKED_KEYWORDS.some(kw => blockAtFeet.name.includes(kw))) {
        return CELL.BLOCKED;
      }
      // 일반 고체 블록 (벽)
      if (blockAtHead && blockAtHead.boundingBox === 'block') {
        return CELL.BLOCKED; // 2칸 높이 벽
      }
    }

    // 안전
    return CELL.SAFE;
  }

  _isAir(block) {
    if (!block) return true;
    return block.boundingBox === 'empty' || block.name === 'air' || block.name === 'cave_air';
  }

  /**
   * 봇의 전방/좌/우/후방 방향의 안전성을 요약합니다.
   * 각 방향의 3블록 부채꼴 영역에서 가장 높은 위험도를 반환.
   */
  _updateDirectionSafety() {
    const yaw = this.botYaw;
    // Mineflayer yaw: 봇 전방 = (-sin(yaw), -cos(yaw))
    const directions = {
      forward: { dx: -Math.sin(yaw), dz: -Math.cos(yaw) },
      left: { dx: -Math.sin(yaw + Math.PI / 2), dz: -Math.cos(yaw + Math.PI / 2) },
      right: { dx: -Math.sin(yaw - Math.PI / 2), dz: -Math.cos(yaw - Math.PI / 2) },
      back: { dx: Math.sin(yaw), dz: Math.cos(yaw) },
    };

    // [P1] 정면 정확히 한 칸 값은 부채꼴(worst)과 별개로 따로 저장 → 반응형 회피 전용
    this.exactForwardSafety = CELL.SAFE;

    for (const [dirName, dir] of Object.entries(directions)) {
      let worstCell = CELL.SAFE;

      // 해당 방향으로 1~4블록 스캔 (좌우 1블록 폭의 부채꼴) — 좌/우 회피 방향 선정·대시보드용
      for (let dist = 1; dist <= 4; dist++) {
        for (let side = -1; side <= 1; side++) {
          const perpDx = -Math.sin(yaw + Math.PI / 2) * side * 0.5;
          const perpDz = -Math.cos(yaw + Math.PI / 2) * side * 0.5;

          const checkDx = Math.round(dir.dx * dist + perpDx);
          const checkDz = Math.round(dir.dz * dist + perpDz);

          const col = checkDx + GRID_RADIUS;
          const row = checkDz + GRID_RADIUS;

          if (row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE) {
            const cell = this.grid[row][col];
            if (cell > worstCell) worstCell = cell;

            // [P1] 정면(forward) 바로 다음 1칸(중앙)만 따로 기록
            if (dirName === 'forward' && dist === 1 && side === 0) {
              this.exactForwardSafety = cell;
            }
          }
        }
      }

      this.directionSafety[dirName] = worstCell;
    }
  }

  /**
   * 그리드 맵에서 가장 안전한 이동 방향을 반환합니다.
   * @returns {'forward'|'left'|'right'|'back'} 가장 안전한 방향
   */
  getSafestDirection() {
    const dirs = ['forward', 'left', 'right', 'back'];
    let safest = 'forward';
    let safestLevel = CELL.DANGER_MOB + 1; // 최악

    for (const dir of dirs) {
      if (this.directionSafety[dir] < safestLevel) {
        safestLevel = this.directionSafety[dir];
        safest = dir;
      }
    }
    return safest;
  }

  /**
   * 전방이 위험한지 확인합니다.
   * [P1] 정면 '바로 다음 1칸'(exactForward)만 기준. 부채꼴 다수 위험·전체 위험 칸 수로는
   * 판단하지 않으므로, 완만한 내리막/언덕에선 발동하지 않고 pathfinder를 신뢰한다.
   * (P2로 절벽 판정이 실제 수직 낙하로 좁혀져, 이 값이 DANGER면 정면 1칸이 용암/물/불/수직절벽)
   * @returns {boolean}
   */
  isForwardDangerous() {
    // 정확히 DANGER_TERRAIN(용암/물/불/수직절벽)일 때만. UNKNOWN(미로드)·DANGER_MOB·BLOCKED(벽)은
    // 지형 반응 대상이 아니다(몹은 몹 루프가, 벽/미로드는 pathfinder가 처리).
    return this.exactForwardSafety === CELL.DANGER_TERRAIN;
  }

  /**
   * 특정 방향이 안전한지 확인합니다.
   * @param {'forward'|'left'|'right'|'back'} direction
   * @returns {boolean}
   */
  isDirectionSafe(direction) {
    return this.directionSafety[direction] <= CELL.SAFE;
  }

  /**
   * 전방 위험 시 최적 회피 방향을 결정합니다.
   * 좌/우 중 더 안전한 방향을 반환합니다.
   * @returns {'left'|'right'}
   */
  getBestAvoidDirection() {
    const leftSafety = this.directionSafety.left;
    const rightSafety = this.directionSafety.right;
    return leftSafety <= rightSafety ? 'left' : 'right';
  }

  /**
   * 그리드의 위험 셀 수를 카운트합니다.
   */
  getDangerCount() {
    let terrain = 0, mob = 0, blocked = 0;
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        switch (this.grid[r][c]) {
          case CELL.DANGER_TERRAIN: terrain++; break;
          case CELL.DANGER_MOB: mob++; break;
          case CELL.BLOCKED: blocked++; break;
        }
      }
    }
    return { terrain, mob, blocked, total: terrain + mob + blocked };
  }

  /**
   * JSON 직렬화 (dashboard/vision_server 전송용)
   */
  toJSON() {
    return {
      grid: this.grid,
      gridSize: GRID_SIZE,
      botWorldX: this.botWorldX,
      botWorldZ: this.botWorldZ,
      botYaw: this.botYaw,
      mobCells: this.mobCells,
      pathCells: this.pathCells, // [정리] 중복 제거로 누락됐던 경로 셀 복원 (dashboard 경로 렌더링용)
      directionSafety: this.directionSafety,
      dangerCount: this.getDangerCount(),
    };
  }

  /**
   * 콘솔 출력용 텍스트 맵
   */
  toAscii() {
    const symbols = ['.', '#', '!', 'M', '?'];
    const center = GRID_RADIUS;
    let out = '';
    for (let r = 0; r < GRID_SIZE; r++) {
      let line = '';
      for (let c = 0; c < GRID_SIZE; c++) {
        if (r === center && c === center) {
          line += 'B '; // Bot
        } else {
          line += symbols[this.grid[r][c]] + ' ';
        }
      }
      out += line.trim() + '\n';
    }
    return out;
  }

  getStatus() {
    const d = this.getDangerCount();
    const fwd = this.directionSafety.forward <= CELL.SAFE ? 'SAFE' : 'DANGER';
    return `Grid: ${fwd} | Terrain:${d.terrain} Mob:${d.mob} Block:${d.blocked}`;
  }
}

module.exports = { LocalGridMap, CELL, GRID_SIZE, GRID_RADIUS };
