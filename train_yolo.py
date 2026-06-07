# train_yolo.py
# YOLO 모델 추가 학습(Fine-tuning)을 위한 스크립트입니다.
# Roboflow 등에서 다운로드한 데이터셋(data.yaml)의 경로를 지정해주면 됩니다.
# 기본적으로 last.pt 가중치를 불러와 이어서 학습합니다.

import os
from ultralytics import YOLO

def train_yolo(data_yaml="path/to/your/dataset/data.yaml", epochs=50, imgsz=640, batch=16):
    """
    YOLO 디텍터 학습 함수.
    
    주의: data.yaml 내부의 클래스 이름과 설정(config/settings.py)의 `DANGEROUS_MOBS`, `SAFE_MOBS` 등이 일치해야 합니다.
    """
    print("========================================")
    print("YOLO 추가 학습(Fine-tuning) 시작")
    print(f"  Dataset YAML : {data_yaml}")
    print(f"  Epochs       : {epochs}")
    print(f"  Image Size   : {imgsz}")
    print(f"  Batch Size   : {batch}")
    print("========================================")

    model_weight = "last.pt"
    if not os.path.exists(model_weight):
        print(f"[경고] {model_weight} 파일이 존재하지 않습니다. yolo26n.pt 와 같은 사전학습 가중치를 사용하거나 파일 경로를 확인해주세요.")
        # 모델의 공식 사전학습 가중치를 불러올 수도 있습니다. (예: model = YOLO("yolo11n.pt"))
        return

    # 모델 불러오기 (기존 학습된 가중치에서 이어서 학습)
    print(f"[INFO] '{model_weight}' 가중치를 불러옵니다.")
    model = YOLO(model_weight)

    # 데이터 학습
    # device=0 등 GPU/CPU 지정, 추가 옵션 적용 가능
    results = model.train(
        data=data_yaml,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        project="runs/detect",  # 학습 결과 저장될 부모 디렉토리
        name="tune_mobs",       # 저장될 폴더 이름 (예: runs/detect/tune_mobs)
        exist_ok=True           # 중복 시 덮어쓰기 허용 (또는 False로 새 폴더 생성)
    )

    print("\n========================================")
    print("YOLO 학습 완료!")
    print("결과물은 runs/detect/tune_mobs/weights 에 저장되었습니다.")
    print("새로운 best.pt 가중치를 last.pt 로 이름을 바꿔서 최상위 경로에 두면 다음 실행 시 바로 반영됩니다.")
    print("  명령어 예시: xcopy runs\\detect\\tune_mobs\\weights\\best.pt last.pt /Y")
    print("========================================")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="YOLO 디텍터 파인튜닝 스크립트")
    parser.add_argument("--data", type=str, required=True, help="데이터셋 data.yaml 경로 (예: C:/my_dataset/data.yaml)")
    parser.add_argument("--epochs", type=int, default=50, help="에폭 수")
    parser.add_argument("--imgsz", type=int, default=640, help="입력 이미지 크기")
    parser.add_argument("--batch", type=int, default=16, help="배치 크기")

    args = parser.parse_args()

    train_yolo(data_yaml=args.data, epochs=args.epochs, imgsz=args.imgsz, batch=args.batch)
