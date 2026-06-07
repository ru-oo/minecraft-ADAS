# vision_server.py
# ─────────────────────────────────────────────────────────────
# ADAS V5.0 — YOLO + EfficientNet-B0 비전 서버 (WebSocket 실시간 스트리밍)
#
# 변경 (V5.0):
#   - HTTP 폴링 → WebSocket 양방향 스트리밍 (ws://localhost:5001)
#   - 매 프레임 추론 결과를 즉시 push (봇이 폴링할 필요 없음)
#   - 봇으로부터 그리드 맵 데이터를 WS로 수신
#   - Flask는 /collect, /health 등 보조 엔드포인트만 담당
#
# 실행: python vision_server.py
# ─────────────────────────────────────────────────────────────

import os
import sys
import time
import math
import json
import threading
import uuid
import asyncio
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import numpy as np
from flask import Flask, jsonify, request

try:
    import mss
except ImportError:
    print("[오류] mss 모듈이 없습니다. → pip install mss")
    sys.exit(1)

try:
    from ultralytics import YOLO
except ImportError:
    print("[오류] ultralytics 모듈이 없습니다. → pip install ultralytics")
    sys.exit(1)

try:
    import websockets
    import websockets.server
except ImportError:
    print("[오류] websockets 모듈이 없습니다. → pip install websockets")
    sys.exit(1)

from models.danger_cnn import create_classifier, crop_sky
from config.settings import DATASET_DIR, DANGEROUS_MOBS, SAFE_MOBS, NEUTRAL_MOBS

# ── 전역 상태 ───────────────────────────────────────────────
latest_result = {
    "detections": [],
    "scene_label": "unknown",
    "scene_confidence": 0.0,
    "frame_time": 0,
    "fps": 0,
}
latest_frame = None
latest_grid = None
result_lock = threading.Lock()

# WebSocket 연결된 클라이언트 집합
ws_clients = set()
ws_clients_lock = threading.Lock()

# ── Flask API 서버 (보조 엔드포인트) ─────────────────────────
app = Flask(__name__)

@app.route('/detect', methods=['GET'])
def detect():
    with result_lock:
        return jsonify(latest_result)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "ws_port": 5001})

@app.route('/grid', methods=['POST'])
def receive_grid():
    global latest_grid
    data = request.json
    if data and 'grid' in data:
        with result_lock:
            latest_grid = data
        return jsonify({"status": "ok"})
    return jsonify({"status": "invalid"}), 400

@app.route('/collect', methods=['POST'])
def collect():
    data = request.json or {}
    state = data.get("state", "0_safe")
    with result_lock:
        if latest_frame is None:
            return jsonify({"status": "no frame"}), 400
        frame_copy = latest_frame.copy()
    save_dir = os.path.join(DATASET_DIR, "frames", state)
    os.makedirs(save_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:8]}.jpg"
    path = os.path.join(save_dir, filename)
    cv2.imwrite(path, frame_copy)
    return jsonify({"status": "saved", "path": path, "state": state})

# ── WebSocket 서버 ───────────────────────────────────────────
async def ws_handler(websocket):
    """각 WebSocket 클라이언트 핸들러"""
    with ws_clients_lock:
        ws_clients.add(websocket)
    print(f"[WS] 클라이언트 연결됨 (총 {len(ws_clients)}개)")

    try:
        async for message in websocket:
            # 봇으로부터 그리드 데이터 수신
            try:
                data = json.loads(message)
                if data.get('type') == 'grid' and 'grid' in data:
                    global latest_grid
                    with result_lock:
                        latest_grid = data
            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        with ws_clients_lock:
            ws_clients.discard(websocket)
        print(f"[WS] 클라이언트 연결 해제 (총 {len(ws_clients)}개)")

def broadcast_ws(data_str):
    """모든 연결된 WS 클라이언트에 데이터 브로드캐스트 (비동기 루프에서 실행)"""
    with ws_clients_lock:
        clients = list(ws_clients)
    if not clients:
        return

    async def _send():
        for ws in clients:
            try:
                await ws.send(data_str)
            except Exception:
                pass

    try:
        loop = ws_loop
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(_send(), loop)
    except Exception:
        pass

ws_loop = None

def run_ws_server():
    """WebSocket 서버를 별도 스레드에서 실행"""
    global ws_loop

    async def _start():
        global ws_loop
        ws_loop = asyncio.get_event_loop()
        async with websockets.serve(ws_handler, "0.0.0.0", 5001):
            print("[WS] WebSocket 서버 시작: ws://localhost:5001")
            await asyncio.Future()  # 무한 대기

    asyncio.run(_start())

# ── 화면 캡처 ───────────────────────────────────────────────
class ScreenCapture:
    def __init__(self, region=None):
        # region: {"top","left","width","height"} dict. 주어지면 그 영역만, 없으면 전체 모니터.
        # (게임 창 영역만 캡처해 바탕화면/터미널/HUD 되먹임을 화면에서 배제하기 위함)
        self.sct = mss.mss()
        if region is not None:
            self.monitor = region
            print(f"[ScreenCapture] 영역 캡처: {self.monitor['width']}x{self.monitor['height']} "
                  f"@ (left={self.monitor['left']}, top={self.monitor['top']})")
        else:
            self.monitor = self.sct.monitors[1]
            print(f"[ScreenCapture] 전체 모니터: {self.monitor['width']}x{self.monitor['height']}")

    def grab(self) -> np.ndarray:
        screenshot = self.sct.grab(self.monitor)
        frame = np.array(screenshot)
        return cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)

# ── 색상 팔레트 (프리미엄 HUD) ──────────────────────────────
C_BG        = (15, 15, 20)
C_DANGER    = (60, 60, 255)
C_SAFE      = (80, 230, 80)
C_NEUTRAL   = (60, 200, 255)
C_ACCENT    = (255, 200, 50)
C_TEXT      = (240, 240, 240)
C_DIM       = (120, 120, 120)
C_GAUGE_BG  = (40, 40, 50)
C_GAUGE_SAFE   = (80, 200, 80)
C_GAUGE_WARN   = (50, 200, 255)
C_GAUGE_DANGER = (50, 50, 255)

def get_mob_color(class_name: str) -> tuple:
    if class_name.lower() in DANGEROUS_MOBS:
        return C_DANGER
    if class_name.lower() in NEUTRAL_MOBS:
        return C_NEUTRAL
    return C_SAFE

def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))

# ── 프리미엄 오버레이 렌더링 ─────────────────────────────────

def draw_rounded_rect(img, pt1, pt2, color, radius=8, thickness=-1, alpha=0.7):
    overlay = img.copy()
    x1, y1 = pt1
    x2, y2 = pt2
    cv2.rectangle(overlay, (x1 + radius, y1), (x2 - radius, y2), color, thickness)
    cv2.rectangle(overlay, (x1, y1 + radius), (x2, y2 - radius), color, thickness)
    cv2.circle(overlay, (x1 + radius, y1 + radius), radius, color, thickness)
    cv2.circle(overlay, (x2 - radius, y1 + radius), radius, color, thickness)
    cv2.circle(overlay, (x1 + radius, y2 - radius), radius, color, thickness)
    cv2.circle(overlay, (x2 - radius, y2 - radius), radius, color, thickness)
    cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0, img)

def draw_yolo_box(vis, x1, y1, x2, y2, class_name, confidence, color):
    overlay = vis.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), color, 3)
    cv2.addWeighted(overlay, 0.8, vis, 0.2, 0, vis)
    cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
    corner_len = min(15, (x2 - x1) // 4, (y2 - y1) // 4)
    for cx, cy, dx, dy in [(x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)]:
        cv2.line(vis, (cx, cy), (cx + corner_len * dx, cy), color, 3)
        cv2.line(vis, (cx, cy), (cx, cy + corner_len * dy), color, 3)
    label = f"{class_name} {int(confidence * 100)}%"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    lx, ly = x1, y1 - th - 10
    if ly < 0:
        ly = y2 + 5
    draw_rounded_rect(vis, (lx, ly), (lx + tw + 12, ly + th + 8), C_BG, radius=4, alpha=0.8)
    cv2.putText(vis, label, (lx + 6, ly + th + 3), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

def draw_scene_hud(vis, scene_label, scene_conf, fps, num_detections, num_dangerous):
    h, w = vis.shape[:2]
    hud_h = 60
    overlay = vis.copy()
    cv2.rectangle(overlay, (0, h - hud_h), (w, h), C_BG, -1)
    cv2.addWeighted(overlay, 0.85, vis, 0.15, 0, vis)
    cv2.line(vis, (0, h - hud_h), (w, h - hud_h), C_ACCENT, 1)
    is_safe = 'safe' in scene_label.lower()
    indicator_color = C_SAFE if is_safe else C_DANGER
    glow_overlay = vis.copy()
    cv2.circle(glow_overlay, (30, h - hud_h // 2), 18, indicator_color, -1)
    cv2.addWeighted(glow_overlay, 0.3, vis, 0.7, 0, vis)
    cv2.circle(vis, (30, h - hud_h // 2), 12, indicator_color, -1)
    cv2.circle(vis, (30, h - hud_h // 2), 12, (255, 255, 255), 1)
    status_text = scene_label.upper()
    cv2.putText(vis, status_text, (52, h - hud_h // 2 + 6),
        cv2.FONT_HERSHEY_SIMPLEX, 0.7, C_TEXT, 2, cv2.LINE_AA)
    gauge_x = w // 3
    gauge_y = h - hud_h + 15
    gauge_w = w // 3
    gauge_h = 20
    danger_score = scene_conf if not is_safe else (1.0 - scene_conf)
    cv2.rectangle(vis, (gauge_x, gauge_y), (gauge_x + gauge_w, gauge_y + gauge_h), C_GAUGE_BG, -1)
    cv2.rectangle(vis, (gauge_x, gauge_y), (gauge_x + gauge_w, gauge_y + gauge_h), C_DIM, 1)
    fill_w = int(gauge_w * danger_score)
    if danger_score < 0.4:
        fill_color = C_GAUGE_SAFE
    elif danger_score < 0.7:
        fill_color = C_GAUGE_WARN
    else:
        fill_color = C_GAUGE_DANGER
    cv2.rectangle(vis, (gauge_x, gauge_y), (gauge_x + fill_w, gauge_y + gauge_h), fill_color, -1)
    gauge_label = f"DANGER: {int(danger_score * 100)}%"
    cv2.putText(vis, gauge_label, (gauge_x + 5, gauge_y + 15),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, C_TEXT, 1, cv2.LINE_AA)
    info_x = w - 280
    cv2.putText(vis, f"FPS: {fps:.0f}", (info_x, h - 38),
        cv2.FONT_HERSHEY_SIMPLEX, 0.5, C_ACCENT, 1, cv2.LINE_AA)
    cv2.putText(vis, f"YOLO: {num_detections} | DANGER: {num_dangerous}", (info_x, h - 15),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, C_DIM, 1, cv2.LINE_AA)

# ── 그리드 미니맵 렌더링 ─────────────────────────────────────
GRID_CELL_COLORS = {
    0: (60, 60, 60), 1: (100, 80, 50), 2: (40, 40, 230),
    3: (20, 20, 255), 4: (30, 30, 30),
}

def draw_grid_minimap(vis, grid_data):
    if grid_data is None:
        return
    grid = grid_data.get('grid', [])
    grid_size = grid_data.get('gridSize', 11)
    bot_yaw = grid_data.get('botYaw', 0)
    mob_cells = grid_data.get('mobCells', [])
    direction_safety = grid_data.get('directionSafety', {})
    h, w = vis.shape[:2]
    cell_px = 14
    map_size = grid_size * cell_px
    padding = 10
    map_x = w - map_size - padding - 10
    map_y = 45
    overlay = vis.copy()
    cv2.rectangle(overlay, (map_x - padding, map_y - 30),
        (map_x + map_size + padding, map_y + map_size + padding + 25), C_BG, -1)
    cv2.addWeighted(overlay, 0.85, vis, 0.15, 0, vis)
    cv2.putText(vis, "LOCAL GRID MAP", (map_x, map_y - 12),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, C_ACCENT, 1, cv2.LINE_AA)
    center = grid_size // 2
    for r in range(grid_size):
        for c in range(grid_size):
            cell_val = grid[r][c] if r < len(grid) and c < len(grid[r]) else 4
            color = GRID_CELL_COLORS.get(cell_val, (30, 30, 30))
            px = map_x + c * cell_px
            py = map_y + r * cell_px
            if cell_val == 0:
                cv2.rectangle(vis, (px, py), (px + cell_px - 1, py + cell_px - 1), (40, 70, 40), -1)
                cv2.rectangle(vis, (px, py), (px + cell_px - 1, py + cell_px - 1), (50, 90, 50), 1)
            else:
                cv2.rectangle(vis, (px, py), (px + cell_px - 1, py + cell_px - 1), color, -1)
                if cell_val >= 2:
                    cv2.rectangle(vis, (px, py), (px + cell_px - 1, py + cell_px - 1),
                        (min(color[0]+60, 255), min(color[1]+60, 255), min(color[2]+60, 255)), 1)
    bot_px = map_x + center * cell_px + cell_px // 2
    bot_py = map_y + center * cell_px + cell_px // 2
    arrow_len = cell_px
    tip_x = int(bot_px - math.sin(bot_yaw) * arrow_len)
    tip_y = int(bot_py - math.cos(bot_yaw) * arrow_len)
    left_x = int(bot_px - math.sin(bot_yaw + 2.4) * (arrow_len * 0.5))
    left_y = int(bot_py - math.cos(bot_yaw + 2.4) * (arrow_len * 0.5))
    right_x = int(bot_px - math.sin(bot_yaw - 2.4) * (arrow_len * 0.5))
    right_y = int(bot_py - math.cos(bot_yaw - 2.4) * (arrow_len * 0.5))
    pts = np.array([[tip_x, tip_y], [left_x, left_y], [right_x, right_y]], np.int32)
    cv2.fillPoly(vis, [pts], C_ACCENT)
    cv2.polylines(vis, [pts], True, (255, 255, 255), 1)
    for mob in mob_cells:
        mr, mc = mob.get('row', 0), mob.get('col', 0)
        mx = map_x + mc * cell_px + cell_px // 2
        my = map_y + mr * cell_px + cell_px // 2
        cv2.drawMarker(vis, (mx, my), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 8, 2)
    info_y = map_y + map_size + 5
    safety_labels = {
        'forward': ('FWD', direction_safety.get('forward', 0)),
        'left': ('L', direction_safety.get('left', 0)),
        'right': ('R', direction_safety.get('right', 0)),
    }
    sx = map_x
    for label, (short, level) in safety_labels.items():
        color = C_SAFE if level <= 0 else (C_NEUTRAL if level == 1 else C_DANGER)
        cv2.putText(vis, short, (sx, info_y + 14),
            cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)
        sx += 40
    danger_count = grid_data.get('dangerCount', {})
    total = danger_count.get('total', 0)
    if total > 0:
        count_text = f"T:{danger_count.get('terrain',0)} M:{danger_count.get('mob',0)}"
        cv2.putText(vis, count_text, (sx, info_y + 14),
            cv2.FONT_HERSHEY_SIMPLEX, 0.3, C_DIM, 1, cv2.LINE_AA)

def draw_top_bar(vis, mode_text):
    h, w = vis.shape[:2]
    bar_h = 32
    overlay = vis.copy()
    cv2.rectangle(overlay, (0, 0), (w, bar_h), C_BG, -1)
    cv2.addWeighted(overlay, 0.7, vis, 0.3, 0, vis)
    cv2.line(vis, (0, bar_h), (w, bar_h), C_ACCENT, 1)
    cv2.putText(vis, "ADAS V5.0 | SENSOR FUSION [WS]", (10, 22),
        cv2.FONT_HERSHEY_SIMPLEX, 0.55, C_ACCENT, 1, cv2.LINE_AA)
    cv2.putText(vis, mode_text, (w - 250, 22),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, C_DIM, 1, cv2.LINE_AA)

# ── Vision 루프 ─────────────────────────────────────────────
def vision_loop(region=None):
    global latest_result, latest_frame

    print("[Vision] 모듈 초기화 중...")
    capture = ScreenCapture(region)

    yolo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "best.pt")
    yolo_model = None
    if os.path.exists(yolo_path):
        yolo_model = YOLO(yolo_path)
        print(f"[Vision] YOLO 모델 로드 완료: {yolo_path}")
    else:
        print(f"[Vision] YOLO 가중치 없음: {yolo_path}")

    classifier = create_classifier()
    has_cnn = classifier.loaded

    mode_parts = []
    if yolo_model:
        mode_parts.append("YOLO")
    if has_cnn:
        mode_parts.append("EfficientNet-B0")
    mode_text = " + ".join(mode_parts) if mode_parts else "Collection Only"

    display_scale = 0.75

    print(f"[Vision] 초기화 완료 (모드: {mode_text})")
    print("[Vision] OpenCV 창 'q' 종료, '+'/'-' 크기 조절.")

    # [P4] HUD 창이 캡처 영역에 겹쳐 되먹임되지 않도록, region이 있으면 캡처 영역
    # 바로 오른쪽 바깥으로 창을 이동. 전체 모니터 모드(region=None)일 땐 기존 동작 유지.
    HUD_WINDOW = "ADAS V5.0 - Sensor Fusion HUD"
    if region is not None:
        cv2.namedWindow(HUD_WINDOW, cv2.WINDOW_AUTOSIZE)
        hud_x = region["left"] + region["width"] + 10
        hud_y = region["top"]
        cv2.moveWindow(HUD_WINDOW, hud_x, hud_y)
        print(f"[Vision] HUD 창을 캡처 영역 오른쪽 바깥으로 이동: ({hud_x}, {hud_y})")

    frame_count = 0
    fps = 0.0
    fps_start = time.time()

    while True:
        t0 = time.time()

        frame = capture.grab()

        # YOLO
        det_list = []
        if yolo_model:
            results = yolo_model(frame, verbose=False, conf=0.30, imgsz=640)
            for r in results:
                for box in r.boxes:
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    conf = float(box.conf[0])
                    cls_id = int(box.cls[0])
                    cls_name = yolo_model.names.get(cls_id, f"class_{cls_id}")
                    h_frame, w_frame = frame.shape[:2]
                    center_x = ((x1 + x2) / 2) / float(w_frame)
                    is_dangerous = cls_name.lower() in DANGEROUS_MOBS
                    det_list.append({
                        "class_name": cls_name,
                        "confidence": round(conf, 3),
                        "bbox": [x1, y1, x2, y2],
                        "center_x": round(center_x, 3),
                        "dangerous": is_dangerous,
                    })

        # CNN
        scene_label = "collecting..."
        scene_conf = 0.0
        if has_cnn:
            scene_label, scene_conf = classifier.predict(frame)

        frame_time = round(time.time() - t0, 4)

        result_data = {
            "detections": det_list,
            "scene_label": scene_label,
            "scene_confidence": round(scene_conf, 3),
            "frame_time": frame_time,
            "fps": round(fps, 1),
        }

        with result_lock:
            latest_frame = frame
            latest_result = result_data

        # WebSocket으로 즉시 브로드캐스트 (폴링 불필요!)
        try:
            ws_msg = json.dumps({"type": "vision", **result_data})
            broadcast_ws(ws_msg)
        except Exception:
            pass

        # HUD 오버레이 렌더링
        vis = frame.copy()
        num_dangerous = 0
        for det in det_list:
            x1, y1, x2, y2 = det["bbox"]
            color = get_mob_color(det["class_name"])
            draw_yolo_box(vis, x1, y1, x2, y2, det["class_name"], det["confidence"], color)
            if det["dangerous"]:
                num_dangerous += 1
        draw_top_bar(vis, mode_text)
        draw_scene_hud(vis, scene_label, scene_conf, fps, len(det_list), num_dangerous)
        with result_lock:
            grid_snapshot = latest_grid
        draw_grid_minimap(vis, grid_snapshot)

        h_disp, w_disp = vis.shape[:2]
        display = cv2.resize(vis, (int(w_disp * display_scale), int(h_disp * display_scale)))
        cv2.imshow(HUD_WINDOW, display)
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('+') or key == ord('='):
            display_scale = min(1.5, display_scale + 0.1)
        elif key == ord('-'):
            display_scale = max(0.3, display_scale - 0.1)

        frame_count += 1
        elapsed = time.time() - fps_start
        if elapsed >= 1.0:
            fps = frame_count / elapsed
            frame_count = 0
            fps_start = time.time()

    cv2.destroyAllWindows()
    os._exit(0)


def find_window_region(substr):
    """제목에 substr를 포함하는 최상위 창의 '클라이언트 영역'을 화면 절대좌표 region으로 반환.
    예: --window Minecraft → 마인크래프트 창만 캡처. 못 찾으면 None. (Windows 전용)"""
    if sys.platform != 'win32':
        print("[Window] Windows 전용 기능입니다 → 전체 모니터로 진행.")
        return None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    # DPI 스케일 환경에서도 좌표가 mss(물리 픽셀)와 일치하도록 DPI-aware 설정
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass

    target = substr.lower()
    matches = []  # (area, title, left, top, width, height)
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if target not in buf.value.lower():
            return True
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w > 0 and h > 0:  # 런처(0x0)·최소화 창 제외
            pt = wintypes.POINT(0, 0)
            user32.ClientToScreen(hwnd, ctypes.byref(pt))
            matches.append((w * h, buf.value, int(pt.x), int(pt.y), int(w), int(h)))
        return True

    user32.EnumWindows(EnumProc(_cb), 0)
    if not matches:
        print(f"[Window] '{substr}' 제목의 유효한 창을 찾지 못함 → 전체 모니터로 진행.")
        return None

    # 매칭 창 중 클라이언트 면적이 가장 큰 것(=실제 게임 창, 런처가 아님)을 선택
    matches.sort(reverse=True)
    _, title, left, top, w, h = matches[0]
    region = {"left": left, "top": top, "width": w, "height": h}
    print(f"[Window] '{title}' → region {region}")
    return region


def select_region_interactive():
    """[P3] 전체 화면을 한 번 캡처해 cv2.selectROI로 영역을 드래그 선택.
    선택된 region dict를 반환(취소 시 None → 전체 모니터)."""
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        shot = np.array(sct.grab(monitor))
    full = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)

    print("[SelectRegion] 게임 창 영역을 드래그로 지정한 뒤 ENTER/SPACE 확정, 'c'로 취소.")
    win = "Select Capture Region (drag, then ENTER)"
    x, y, w, h = cv2.selectROI(win, full, showCrosshair=False, fromCenter=False)
    cv2.destroyWindow(win)

    if w == 0 or h == 0:
        print("[SelectRegion] 영역이 선택되지 않아 전체 모니터로 진행합니다.")
        return None

    # selectROI는 monitors[1] 기준 상대 좌표 → 모니터 원점(left/top)을 더해 절대 좌표로 변환
    region = {
        "left": int(monitor["left"] + x),
        "top": int(monitor["top"] + y),
        "width": int(w),
        "height": int(h),
    }
    print("[SelectRegion] 선택된 region (다음 실행부터 아래 인자로 재사용 가능):")
    print(f"    --left {region['left']} --top {region['top']} "
          f"--width {region['width']} --height {region['height']}")
    return region


def parse_region_args():
    """[P2/P3] CLI 인자에서 캡처 region을 구성. 우선순위: --select-region > 네 인자 모두 > 전체 모니터."""
    parser = argparse.ArgumentParser(description="ADAS V5.0 Vision Server")
    parser.add_argument("--left", type=int, default=None, help="캡처 영역 좌측 x")
    parser.add_argument("--top", type=int, default=None, help="캡처 영역 상단 y")
    parser.add_argument("--width", type=int, default=None, help="캡처 영역 너비")
    parser.add_argument("--height", type=int, default=None, help="캡처 영역 높이")
    parser.add_argument("--select-region", action="store_true",
                        help="전체 화면을 한 번 띄워 드래그로 캡처 영역을 선택")
    parser.add_argument("--window", type=str, default=None,
                        help="제목에 이 문자열을 포함하는 창만 캡처 (예: --window Minecraft)")
    args = parser.parse_args()

    # P3: 드래그 선택이 최우선
    if args.select_region:
        region = select_region_interactive()
        if region is not None:
            return region

    # --window: 제목으로 창 자동 탐지(클라이언트 영역). 매번 좌표 입력 불필요.
    if args.window:
        region = find_window_region(args.window)
        if region is not None:
            return region

    # P2: 네 인자가 모두 주어지면 region 구성, 아니면 전체 모니터(None)
    if None not in (args.left, args.top, args.width, args.height):
        region = {"left": args.left, "top": args.top,
                  "width": args.width, "height": args.height}
        print(f"[Args] 지정 영역 사용: {region}")
        return region

    return None


def main():
    region = parse_region_args()

    print("=" * 55)
    print("  ADAS V5.0 — Vision Server [WebSocket]")
    print("  YOLO + EfficientNet-B0 + WS Push")
    print("  HTTP: http://localhost:5000")
    print("  WS:   ws://localhost:5001")
    print("  종료: OpenCV 창에서 'q' 키")
    print("=" * 55)

    # WebSocket 서버 스레드
    ws_thread = threading.Thread(target=run_ws_server, daemon=True)
    ws_thread.start()

    # Flask HTTP 서버 스레드
    flask_thread = threading.Thread(
        target=lambda: app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=False),
        daemon=True
    )
    flask_thread.start()

    # 메인 스레드에서 Vision 루프 실행
    time.sleep(0.5)  # WS 서버 준비 대기
    vision_loop(region)


if __name__ == '__main__':
    main()
