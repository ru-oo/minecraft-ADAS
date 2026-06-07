// bot/combatManager.js
// 전투/생존 관리 모듈
// 체력이 낮으면 긴급 도주, 도주 불가 시 방패/반격

const { logEvent } = require('./logger');

class CombatManager {
  constructor(bot, navigator) {
    this.bot = bot;
    this.navigator = navigator;
    this.isEmergency = false;

    // 체력 임계값 (하트 기준, 20이 풀HP)
    // [재설계] 도주 트리거를 8 → 11로 상향. 크리퍼 한 방이 풀피를 거의 비우므로, 8까지
    // 떨어지길 기다리면 이미 늦다. 11 이하에서 즉시 후퇴 우선, 회복(16+) 후 목표 재개.
    this.FLEE_HP_THRESHOLD = 11;   // 약 5.5하트 이하 → 긴급 후퇴
    this.HEAL_HP_THRESHOLD = 16;   // 8하트 이상 회복 시 긴급 해제

    this._lastHp = 20;
    this._init();
  }

  _init() {
    // 체력 변동 감지
    this.bot.on('health', () => {
      const hp = this.bot.health;

      if (hp !== this._lastHp) {
        logEvent('health', { hp, delta: Math.round((hp - this._lastHp) * 10) / 10, emergency: this.isEmergency });
        this._lastHp = hp;
      }

      if (hp <= this.FLEE_HP_THRESHOLD && !this.isEmergency) {
        this.isEmergency = true;
        logEvent('flee_start', { hp, threshold: this.FLEE_HP_THRESHOLD });
        console.log(`[Combat] 🚨 체력 위험! (${hp}/20) 긴급 후퇴 모드`);
        this.bot.chat(`체력 위험! (${hp}/20) 긴급 후퇴합니다!`);
        this._emergencyFlee();
      }

      if (hp >= this.HEAL_HP_THRESHOLD && this.isEmergency) {
        this.isEmergency = false;
        this.bot.deactivateItem();
        logEvent('flee_recover', { hp });
        console.log('[Combat] 체력 회복, 긴급 모드 해제');
      }
    });

    // 피격 감지
    this.bot.on('entityHurt', (entity) => {
      if (entity === this.bot.entity) {
        console.log(`[Combat] 💥 피격! 현재 체력: ${this.bot.health}/20`);
      }
    });
  }

  _emergencyFlee() {
    // 방패가 있으면 들기
    this._equipShield();

    // [재설계] 한 마리가 아니라 '주변 적대 군집 중심'의 반대로 후퇴(다른 몹으로 도망치는 것 방지).
    const info = this._liveThreatInfo(14);
    if (info) {
      this.navigator.retreatFrom(info.centroid, 12, { live: () => this._liveThreatInfo(14) });
    }
  }

  // 반경 내 적대 몹들의 중심점 + 최소거리(라이브 후퇴 재평가용). 없으면 null.
  _liveThreatInfo(radius = 14) {
    const { HOSTILE_MOBS } = require('./mobRadar');
    const bp = this.bot.entity.position;
    let x = 0, z = 0, n = 0, minDist = Infinity;
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      if (!entity.name || !HOSTILE_MOBS[entity.name]) continue;
      const d = bp.distanceTo(entity.position);
      if (d > radius) continue;
      x += entity.position.x; z += entity.position.z; n++;
      if (d < minDist) minDist = d;
    }
    return n > 0 ? { centroid: { x: x / n, z: z / n }, minDist } : null;
  }

  _equipShield() {
    const shield = this.bot.inventory.items().find(
      item => item.name.includes('shield')
    );
    if (shield) {
      this.bot.equip(shield, 'off-hand').then(() => {
        this.bot.activateItem(true);
        console.log('[Combat] 방패 장착 및 방어 태세 활성화');
      }).catch(() => { });
    }
  }

  _findNearestHostile() {
    const { HOSTILE_MOBS } = require('./mobRadar');
    let nearest = null;
    let minDist = Infinity;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      if (!entity.name || !HOSTILE_MOBS[entity.name]) continue;

      const dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist < minDist) {
        minDist = dist;
        nearest = entity;
      }
    }

    return nearest;
  }

  getStatus() {
    const hp = this.bot.health || 20;
    const food = this.bot.food || 20;
    const emoji = this.isEmergency ? '🚨' : (hp > 14 ? '💚' : '💛');
    return `${emoji} HP: ${hp}/20 | 배고픔: ${food}/20`;
  }
}

module.exports = { CombatManager };
