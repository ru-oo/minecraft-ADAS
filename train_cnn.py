import os
import torch
import torch.nn as nn
from torchvision import datasets, transforms
from torch.utils.data import DataLoader, random_split
from PIL import Image

from models.danger_cnn import SceneCNN, SKY_CROP_RATIO, SCENE_INPUT_SIZE

DATA_DIR = "dataset/frames"
EPOCHS = 100
BATCH_SIZE = 16
LR = 1e-3
FINE_TUNE_LR = 1e-4
FREEZE_EPOCHS = 10  # 처음 10 에포크는 백본 동결 → 나머지 10 에포크는 전체 fine-tune


class SkyCropTransform:
    """PIL 이미지에서 상단 40%(하늘)를 잘라내는 커스텀 변환기"""
    def __init__(self, ratio=SKY_CROP_RATIO):
        self.ratio = ratio

    def __call__(self, img: Image.Image) -> Image.Image:
        w, h = img.size
        top = int(h * self.ratio)
        return img.crop((0, top, w, h))


def main():
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print("=" * 60)
    print("  [ADAS V4.0] EfficientNet-B0 Transfer Learning 학습")
    print("  - 하늘 크롭(상단 40% 제거) + 128x128 입력")
    print("  - Phase 1: 백본 동결 학습 → Phase 2: 전체 Fine-tuning")
    print("=" * 60)
    print(f"* 하드웨어 가속기: {device}")

    if not os.path.exists(DATA_DIR):
        print(f"오류: 데이터셋 폴더 '{DATA_DIR}'가 존재하지 않습니다.")
        return

    # 1. 전처리 파이프라인 (하늘 크롭 → 리사이즈 → ImageNet 정규화)
    train_transform = transforms.Compose([
        SkyCropTransform(SKY_CROP_RATIO),
        transforms.Resize((SCENE_INPUT_SIZE, SCENE_INPUT_SIZE)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.2),
        transforms.RandomAffine(degrees=10, translate=(0.05, 0.05)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],   # ImageNet 표준
                             std=[0.229, 0.224, 0.225])
    ])

    val_transform = transforms.Compose([
        SkyCropTransform(SKY_CROP_RATIO),
        transforms.Resize((SCENE_INPUT_SIZE, SCENE_INPUT_SIZE)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225])
    ])

    # 2. 데이터셋 로드
    try:
        full_dataset = datasets.ImageFolder(DATA_DIR, transform=train_transform)
    except Exception as e:
        print(f"데이터셋 로드 실패: {e}")
        return

    num_classes = len(full_dataset.classes)
    if num_classes < 2:
        print(f"경고: 클래스(폴더)가 {num_classes}개 뿐입니다. (최소 2개 필요)")
        return

    print(f"\n* 총 이미지: {len(full_dataset)}장")
    print(f"* 클래스 ({num_classes}개):")
    for cls_name, cls_idx in full_dataset.class_to_idx.items():
        count = sum(1 for _, label in full_dataset.samples if label == cls_idx)
        print(f"  [{cls_idx}] {cls_name} — {count}장")

    # 3. Train / Val 분리 (8:2)
    train_size = int(0.8 * len(full_dataset))
    val_size = len(full_dataset) - train_size
    train_dataset, val_dataset = random_split(full_dataset, [train_size, val_size])

    # Val 세트에는 증강 없는 transform 적용
    val_dataset.dataset = datasets.ImageFolder(DATA_DIR, transform=val_transform)

    print(f"\n* 학습: {train_size}장 | 검증: {val_size}장")

    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=BATCH_SIZE, shuffle=False)

    # 4. EfficientNet-B0 모델 생성 (ImageNet 사전학습 가중치 포함)
    model = SceneCNN(num_classes=num_classes, pretrained=True).to(device)

    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"\n* 전체 파라미터: {total_params:,}개")
    print(f"* 학습 가능 파라미터: {trainable_params:,}개")

    criterion = nn.CrossEntropyLoss()
    best_acc = 0.0
    save_path = "weights/adas_scene_cnn.pth"
    os.makedirs("weights", exist_ok=True)

    class_names = full_dataset.classes

    # ═══════════════════════════════════════════════════════
    # Phase 1: 백본 동결 (Feature Extractor Frozen)
    #   → 분류 헤드만 빠르게 학습시켜 안정적인 초기 수렴을 유도
    # ═══════════════════════════════════════════════════════
    print(f"\n{'─' * 60}")
    print(f"Phase 1: 백본 동결 학습 ({FREEZE_EPOCHS} Epochs, LR={LR})")
    print(f"{'─' * 60}")
    model.freeze_backbone()
    optimizer = torch.optim.Adam(
        filter(lambda p: p.requires_grad, model.parameters()), lr=LR
    )

    for epoch in range(1, FREEZE_EPOCHS + 1):
        best_acc = _train_one_epoch(
            model, train_loader, val_loader, criterion, optimizer,
            device, epoch, FREEZE_EPOCHS, best_acc, save_path, "Phase1"
        )

    # ═══════════════════════════════════════════════════════
    # Phase 2: 전체 Fine-tuning (Backbone Unfrozen)
    #   → 낮은 학습률로 전체 모델을 미세 조정
    # ═══════════════════════════════════════════════════════
    fine_tune_epochs = EPOCHS - FREEZE_EPOCHS
    print(f"\n{'─' * 60}")
    print(f"Phase 2: 전체 Fine-tuning ({fine_tune_epochs} Epochs, LR={FINE_TUNE_LR})")
    print(f"{'─' * 60}")
    model.unfreeze_backbone()
    optimizer = torch.optim.Adam(model.parameters(), lr=FINE_TUNE_LR)

    for epoch in range(1, fine_tune_epochs + 1):
        best_acc = _train_one_epoch(
            model, train_loader, val_loader, criterion, optimizer,
            device, epoch, fine_tune_epochs, best_acc, save_path, "Phase2"
        )

    # 클래스 이름 매핑 저장
    class_map_path = "weights/class_names.txt"
    with open(class_map_path, "w", encoding="utf-8") as f:
        for name in class_names:
            f.write(name + "\n")

    print(f"\n{'=' * 60}")
    print(f"✨ [학습 완료] 최고 검증 정확도: {best_acc * 100:.2f}%")
    print(f"   가중치: {os.path.abspath(save_path)}")
    print(f"   클래스 매핑: {os.path.abspath(class_map_path)}")
    print(f"{'=' * 60}")


def _train_one_epoch(model, train_loader, val_loader, criterion, optimizer,
                     device, epoch, total_epochs, best_acc, save_path, phase_name):
    """1 에포크 학습 + 검증을 수행하고 best_acc를 반환"""
    # Training
    model.train()
    train_loss = 0.0
    for imgs, labels in train_loader:
        imgs, labels = imgs.to(device), labels.to(device)
        optimizer.zero_grad()
        outputs = model(imgs)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()
        train_loss += loss.item()

    # Validation
    model.eval()
    correct = total = 0
    with torch.no_grad():
        for imgs, labels in val_loader:
            imgs, labels = imgs.to(device), labels.to(device)
            outputs = model(imgs)
            _, preds = torch.max(outputs, 1)
            total += labels.size(0)
            correct += (preds == labels).sum().item()

    val_acc = correct / total if total > 0 else 0
    avg_loss = train_loss / len(train_loader)
    print(f"[{phase_name}] Epoch {epoch:2d}/{total_epochs} | Loss: {avg_loss:.4f} | Val Acc: {val_acc:.4f}")

    if val_acc > best_acc:
        best_acc = val_acc
        torch.save(model.state_dict(), save_path)
        print(f"  [!] 최고 성능 → 모델 저장: {save_path}")

    return best_acc


if __name__ == "__main__":
    main()
