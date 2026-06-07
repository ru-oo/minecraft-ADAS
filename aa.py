import albumentations as A
import cv2
import os
import glob

# 1. 증강 파이프라인 정의 (용암 특성에 맞춤)
transform = A.Compose([
    A.HorizontalFlip(p=0.5),              # 좌우 반전
    A.VerticalFlip(p=0.5),                # 상하 반전 (용암은 방향 무관)
    A.RandomRotate90(p=0.5),              # 90도 회전
    A.Rotate(limit=30, p=0.5),            # 미세 회전
    A.RandomBrightnessContrast(p=0.2),    # 밝기/대비 변형 (빛나는 효과)
    A.HueSaturationValue(p=0.2),          # 색상 변형 (붉은색 농도 변화)
    A.GaussNoise(p=0.2),                  # 노이즈 추가 (변별력 강화)
])

# 2. 경로 설정
input_path = "dataset/frames/2_danger_lava"     # 원본 용암 사진 50장 폴더
output_path = "dataset/lava_augmented/"   # 증강된 사진 저장 폴더
os.makedirs(output_path, exist_ok=True)

# 3. 이미지 로드 및 증강 실행
images = glob.glob(os.path.join(input_path, "*.png"))

count = 0
multiply_factor = 20  # 1장당 20장 생성 (50 * 20 = 1,000장)

print(f"증강 시작: 원본 {len(images)}장")

for img_p in images:
    image = cv2.imread(img_p)
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB) # Albumentations는 RGB 기준
    
    file_name = os.path.basename(img_p).split('.')[0]
    
    for i in range(multiply_factor):
        augmented = transform(image=image)["image"]
        save_img = cv2.cvtColor(augmented, cv2.COLOR_RGB2BGR)
        
        # 저장 파일명 규칙: 원본명_증강번호.jpg
        cv2.imwrite(os.path.join(output_path, f"{file_name}_aug_{i}.jpg"), save_img)
        count += 1

print(f"증강 완료: 총 {count}장 생성됨")