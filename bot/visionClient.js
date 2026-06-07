// bot/visionClient.js
// ADAS V5.0 — Python Vision Server (YOLO + EfficientNet-B0) WebSocket 연동
// HTTP 폴링 → WebSocket 실시간 푸시로 전환 (지연 최소화)

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:5001';
const RECONNECT_DELAY = 2000; // 재연결 대기 (ms)

class VisionClient {
  constructor() {
    this.lastResult = {
      detections: [],
      scene_label: 'unknown',
      scene_confidence: 0.0,
      fps: 0,
      frame_time: 0,
    };
    this.isConnected = false;
    this._ws = null;
    this._reconnectTimer = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._connect();
    console.log('[VisionClient] ADAS V5.0 WebSocket 비전 서버 연동 시작');
  }

  stop() {
    this._started = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
  }

  _connect() {
    if (!this._started) return;

    const ws = new WebSocket(WS_URL);
    this._ws = ws;

    ws.on('open', () => {
      this.isConnected = true;
      console.log('[VisionClient] ✅ Vision WebSocket 연결 성공 (ws://localhost:5001)');
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'vision') {
          this.lastResult = {
            detections: msg.detections || [],
            scene_label: msg.scene_label || 'unknown',
            scene_confidence: msg.scene_confidence || 0.0,
            fps: msg.fps || 0,
            frame_time: msg.frame_time || 0,
          };
        }
      } catch (e) { /* JSON 파싱 실패 무시 */ }
    });

    ws.on('close', () => {
      if (this.isConnected) {
        console.log('[VisionClient] Vision WebSocket 연결 끊김. 재연결 중...');
        this.isConnected = false;
      }
      this._ws = null;
      if (this._started) {
        this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY);
      }
    });

    ws.on('error', () => {
      // 'close' 이벤트가 이어서 발생하므로 여기서는 무시
    });
  }

  /**
   * 그리드 맵 데이터를 Vision 서버로 전송합니다. (HUD 미니맵 렌더링용)
   * @param {object} gridData - localGridMap.toJSON() 결과
   */
  sendGrid(gridData) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify({ type: 'grid', ...gridData }));
    } catch (e) { /* 전송 실패 무시 */ }
  }

  // ── YOLO 관련 ──

  /** YOLO가 감지한 위험 몹 목록 반환 */
  getDangerousDetections() {
    if (!this.lastResult || !this.lastResult.detections) return [];
    return this.lastResult.detections.filter(d => d.dangerous);
  }

  /** YOLO 전체 탐지 결과 반환 */
  getAllDetections() {
    if (!this.lastResult || !this.lastResult.detections) return [];
    return this.lastResult.detections;
  }

  // ── CNN 지형 분류 관련 ──

  /** CNN이 판단한 현재 지형 상태 반환 */
  getSceneState() {
    return {
      label: this.lastResult.scene_label || 'unknown',
      confidence: this.lastResult.scene_confidence || 0.0,
    };
  }

  /** 현재 지형이 위험한지 여부 (danger 계열 라벨이면 true) */
  isSceneDangerous() {
    const label = (this.lastResult.scene_label || '').toLowerCase();
    return label.includes('danger');
  }

  // ── 상태 출력 ──

  getStatus() {
    if (!this.isConnected) return 'Vision: 연결 안됨';
    const dets = this.lastResult.detections || [];
    const danger = dets.filter(d => d.dangerous).length;
    const scene = this.lastResult.scene_label || 'unknown';
    const conf = Math.round((this.lastResult.scene_confidence || 0) * 100);
    return `Vision: YOLO ${dets.length}탐지(${danger}위험) | CNN: ${scene}(${conf}%) | FPS: ${this.lastResult.fps || 0}`;
  }
}

module.exports = { VisionClient };
