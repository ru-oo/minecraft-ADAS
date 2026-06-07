# models/danger_cnn.py
# ─────────────────────────────────────────────────────────────
# ADAS V4.0 — EfficientNet-B0 기반 배경/지형 분류 모델
#
# 목적: 봇의 1인칭 화면(블랙박스 프레임)을 입력받아
#       현재 지형이 안전한지, 위험한지를 분류하는 딥러닝 모델.
#
# 핵심 설계:
#   1) EfficientNet-B0: ImageNet 사전학습 가중치를 기반으로 한 전이 학습(Transfer Learning)
#      → 적은 데이터로도 높은 정확도를 달성할 수 있습니다.
#   2) 하늘 크롭(Sky-Crop): 화면 상단 40%를 잘라내어 하단 60%만 사용합니다.
#   3) 입력 해상도 128x128: EfficientNet의 성능을 유지하면서 경량화.
#   4) N-Class 동적 지원: 사용자가 만든 폴더 수에 맞춰 출력 노드를 자동 조절.
# ─────────────────────────────────────────────────────────────

import os
import torch
import torch.nn as nn
from torchvision import transforms, models
import numpy as np
import cv2

# ── 상수 ────────────────────────────────────────────────────
SCENE_INPUT_SIZE = 128         # EfficientNet-B0 입력 해상도
SKY_CROP_RATIO   = 0.40       # 상단 40% 하늘 제거
DEFAULT_NUM_CLASSES = 2        # 기본 클래스 수 (safe / danger)

SCENE_WEIGHTS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "weights", "adas_scene_cnn.pth"
)


# ── 모델 구조 ───────────────────────────────────────────────

class SceneCNN(nn.Module):
    """
    ADAS 배경/지형 분류 — EfficientNet-B0 Transfer Learning

    입력 : (B, 3, 128, 128) — 하늘이 잘려나간 하단 60% 프레임
    출력 : (B, num_classes)  — 각 지형 클래스에 대한 logit

    구조 : EfficientNet-B0 백본(ImageNet 사전학습) + Custom FC Head
           백본의 feature extractor를 동결(freeze)하거나 fine-tune 가능.
    """

    def __init__(self, num_classes: int = DEFAULT_NUM_CLASSES, pretrained: bool = True):
        super().__init__()

        # EfficientNet-B0 백본 로드
        if pretrained:
            weights = models.EfficientNet_B0_Weights.DEFAULT
            self.backbone = models.efficientnet_b0(weights=weights)
        else:
            self.backbone = models.efficientnet_b0(weights=None)

        # 원래 분류기(classifier) 헤드의 입력 차원 확인
        in_features = self.backbone.classifier[1].in_features

        # 사용자 정의 분류 헤드로 교체
        self.backbone.classifier = nn.Sequential(
            nn.Dropout(0.3),
            nn.Linear(in_features, num_classes)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.backbone(x)

    def freeze_backbone(self):
        """백본(Feature Extractor) 가중치를 동결합니다. (소량 데이터 학습 시 권장)"""
        for param in self.backbone.features.parameters():
            param.requires_grad = False
        print("[SceneCNN] 백본 동결 완료 (분류 헤드만 학습)")

    def unfreeze_backbone(self):
        """백본 가중치를 해제합니다. (Fine-tuning 시 사용)"""
        for param in self.backbone.features.parameters():
            param.requires_grad = True
        print("[SceneCNN] 백본 해동 완료 (전체 모델 학습)")


# ── 하늘 크롭 유틸리티 ──────────────────────────────────────

def crop_sky(image: np.ndarray, ratio: float = SKY_CROP_RATIO) -> np.ndarray:
    """
    입력 이미지(BGR 또는 RGB)의 상단 `ratio` 비율을 잘라내어
    하단(도로/지면) 영역만 반환합니다.

    예) ratio=0.40 이면 상단 40%를 버리고 하단 60%만 남깁니다.
        1920x1080 화면 → 상단 432px 제거 → 1920x648 반환
    """
    h = image.shape[0]
    start_y = int(h * ratio)
    return image[start_y:, :]


# ── 전처리 변환 ─────────────────────────────────────────────

def get_train_transform():
    """학습용 Data Augmentation 파이프라인"""
    return transforms.Compose([
        transforms.Resize((SCENE_INPUT_SIZE, SCENE_INPUT_SIZE)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.2),
        transforms.RandomAffine(degrees=10, translate=(0.05, 0.05)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],   # ImageNet 표준
                             std=[0.229, 0.224, 0.225])
    ])


def get_infer_transform():
    """추론용 전처리 파이프라인 (증강 없음, ImageNet 정규화)"""
    return transforms.Compose([
        transforms.Resize((SCENE_INPUT_SIZE, SCENE_INPUT_SIZE)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225])
    ])


# ── 추론 클래스 ─────────────────────────────────────────────

class SceneClassifier:
    """
    학습 완료된 EfficientNet-B0 가중치를 로드하여
    실시간으로 화면 프레임의 지형 위험도를 판단하는 추론기.

    사용법:
        clf = SceneClassifier("weights/adas_scene_cnn.pth")
        label, confidence = clf.predict(frame_bgr)
    """

    def __init__(self, weights_path: str = None, class_names: list = None):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        path = weights_path or SCENE_WEIGHTS_PATH
        self.loaded = False

        # 클래스 이름 목록 로드
        class_map_path = os.path.join(os.path.dirname(path), "class_names.txt")
        if class_names:
            self.class_names = class_names
        elif os.path.exists(class_map_path):
            with open(class_map_path, "r", encoding="utf-8") as f:
                self.class_names = [line.strip() for line in f if line.strip()]
        else:
            self.class_names = ["0_safe", "1_danger"]

        if os.path.exists(path):
            num_classes = len(self.class_names)
            checkpoint = torch.load(path, map_location=self.device, weights_only=True)

            # 가중치 키를 분석하여 모델 구조 자동 판별
            keys = list(checkpoint.keys())
            is_legacy = any(k.startswith('features.') and not k.startswith('backbone.') for k in keys)

            try:
                if is_legacy:
                    # ── 이전 3-Block CNN 가중치 감지 → 레거시 모델로 로드 ──
                    # 사용자가 이전 구조로 열심히 학습한 결과를 그대로 활용합니다.
                    for key in reversed(keys):
                        if 'weight' in key and 'classifier' in key:
                            num_classes = checkpoint[key].shape[0]
                            break
                    self.model = _LegacySceneCNN(num_classes=num_classes).to(self.device)
                    self.model.load_state_dict(checkpoint)
                    self.model.eval()
                    self.loaded = True
                    print(f"[SceneClassifier] 레거시 3-Block CNN 모델 로드 완료: {path}")
                    print(f"  클래스: {self.class_names} ({num_classes}개)")
                else:
                    # ── EfficientNet-B0 가중치 → 새 모델로 로드 ──
                    self.model = SceneCNN(num_classes=num_classes, pretrained=False).to(self.device)
                    self.model.load_state_dict(checkpoint)
                    self.model.eval()
                    self.loaded = True
                    print(f"[SceneClassifier] EfficientNet-B0 모델 로드 완료: {path}")
                    print(f"  클래스: {self.class_names}")
            except RuntimeError as e:
                print(f"[SceneClassifier] ⚠️ 가중치 로드 실패: {e}")
                self.model = None
                self.loaded = False
        else:
            self.model = None
            print(f"[SceneClassifier] 가중치 파일 없음: {path}")
            print(f"  → 먼저 'python train_cnn.py'로 학습을 진행해 주세요.")

        self._transform = get_infer_transform()

    def predict(self, frame_bgr: np.ndarray) -> tuple:
        """BGR 프레임을 받아 (클래스명, 확률) 튜플을 반환"""
        if not self.loaded:
            return "unknown", 0.0

        from PIL import Image

        # 1. 하늘 제거
        cropped = crop_sky(frame_bgr)

        # 2. BGR → RGB → PIL
        rgb = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)

        # 3. 전처리 → 추론
        tensor = self._transform(pil).unsqueeze(0).to(self.device)

        with torch.no_grad():
            logits = self.model(tensor)
            probs = torch.softmax(logits, dim=1)
            confidence, idx = torch.max(probs, dim=1)

        idx = idx.item()
        conf = confidence.item()
        label = self.class_names[idx] if idx < len(self.class_names) else f"class_{idx}"

        return label, conf

    def score(self, frame_bgr: np.ndarray) -> float:
        """하위 호환용: 위험도 점수(0.0~1.0)만 반환"""
        label, conf = self.predict(frame_bgr)
        if 'safe' in label.lower():
            return 1.0 - conf
        else:
            return conf


# ── 팩토리 함수 ─────────────────────────────────────────────

def create_classifier(weights_path: str = None):
    """가중치가 있으면 SceneClassifier를 로드, 없으면 빈 인스턴스 반환"""
    return SceneClassifier(weights_path)
