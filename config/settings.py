# config/settings.py
# 전체 파이프라인에서 공유하는 설정값 모음
# 환경에 맞게 수정해서 사용

import os

# ── 경로 설정 ──────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

YOLO_WEIGHTS     = os.path.join(BASE_DIR, "best.pt")
CNN_WEIGHTS      = os.path.join(BASE_DIR, "weights", "danger_cnn.pth")
DATASET_DIR      = os.path.join(BASE_DIR, "dataset")
CROP_SAVE_DIR    = os.path.join(DATASET_DIR, "crops")
LOG_DIR          = os.path.join(BASE_DIR, "logs")

# ── 화면 캡처 설정 ─────────────────────────────────────────
# Minecraft 창 위치/크기에 맞게 수정
CAPTURE_REGION = {
    "top":    0,
    "left":   0,
    "width":  2560,
    "height": 1600,
}

# ── YOLO 설정 ──────────────────────────────────────────────
YOLO_CONF_THRESHOLD = 0.30   # 이 값 미만 detection은 무시
YOLO_IOU_THRESHOLD  = 0.45
YOLO_IMGSZ          = 640

# ── 위험 mob 목록 ──────────────────────────────────────────
# last.pt 모델 클래스: bee, chicken, cow, creeper, enderman, fox, frog,
#   ghast, goat, llama, pig, sheep, skeleton, spider, turtle, wolf, zombie
DANGEROUS_MOBS = {
    "creeper", "zombie", "skeleton", "spider",
    "ghast", "enderman"
}

SAFE_MOBS = {
    "pig", "cow", "sheep", "chicken",
    "bee", "fox", "frog", "goat", "llama", "turtle"
}

# wolf는 중립 mob (도발 시 공격) -> 주의 필요
NEUTRAL_MOBS = {"wolf"}

# ── CNN 설정 ───────────────────────────────────────────────
CNN_INPUT_SIZE    = 64    # 크롭 이미지 리사이즈 크기
CNN_DANGER_THRESH = 0.55  # 이 값 이상이면 위험으로 판단

# CNN 가중치가 없으면 자동으로 규칙 기반 분류로 전환된다
USE_CNN = os.path.exists(CNN_WEIGHTS)

# ── ADAS 제어 설정 ─────────────────────────────────────────
THREAT_STOP_LEVEL    = 0.35   # 이 이상이면 즉시 정지
ACTION_INTERVAL      = 0.05   # 제어 루프 간격 (초), 20 FPS
TURN_MOUSE_DELTA     = 120    # 좌우 회피 시 마우스 이동량 (픽셀)
AGENT_START_DELAY    = 3      # 에이전트 시작 전 대기 시간 (초)

# ── 수집 모드 설정 ─────────────────────────────────────────
COLLECT_MIN_CROP_SIZE = 20    # 이 픽셀 미만 크롭은 저장 안 함
