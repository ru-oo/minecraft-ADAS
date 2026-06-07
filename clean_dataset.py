import os
import glob
import cv2
import numpy as np

DATASET_DIR = "dataset/frames"

def clean_folder(folder_path):
    print(f"\n[Cleaning] 폴더 스캔 중: {folder_path}")
    files = glob.glob(os.path.join(folder_path, "*.jpg"))
    if not files:
        print("  - 이미지가 없습니다.")
        return
    
    # 생성 시간 순 정렬 (시계열 흐름 파악)
    files.sort(key=lambda x: os.path.getmtime(x))
    
    deleted_count = 0
    duplicate_count = 0
    invalid_count = 0
    prev_gray = None
    
    for file_path in files:
        img = cv2.imread(file_path)
        if img is None:
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
            except Exception:
                pass
            deleted_count += 1
            invalid_count += 1
            continue

        # 단색 창(절전 모드, 바탕화면, 검은 화면, 봇 강제종료 등) 구분
        # 분산(Variance)이 비정상적으로 낮으면 삭제
        if np.std(img) < 10.0:
            try:
                os.remove(file_path)
            except Exception:
                pass
            deleted_count += 1
            invalid_count += 1
            continue

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        if prev_gray is not None:
            if gray.shape == prev_gray.shape:
                # 차이 계산 (Mean Absolute Difference)
                diff = cv2.absdiff(gray, prev_gray)
                mean_diff = np.mean(diff)
                
                # 평균 픽셀 차이가 2.5 미만이면 멈춰있는 '완전 중복 화면'으로 간주하여 삭제
                if mean_diff < 2.5:
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
                    deleted_count += 1
                    duplicate_count += 1
                    continue
        
        prev_gray = gray
        
    print(f"  -> 총 {len(files)}장 중 {deleted_count}장 지움. (중복: {duplicate_count}장 | 손상/다른화면: {invalid_count}장)")
    print(f"  -> 남은 유효한 사진: {len(files)-deleted_count}장")

if __name__ == '__main__':
    if not os.path.exists(DATASET_DIR):
        print(f"폴더가 존재하지 않습니다: {DATASET_DIR}")
        exit()

    subfolders = [f.path for f in os.scandir(DATASET_DIR) if f.is_dir()]
    print(f"총 {len(subfolders)}개의 데이터셋 폴더 정리(Cleanup) 알고리즘을 시작합니다...")
    
    for folder in subfolders:
        clean_folder(folder)
        
    print("\n[완료] 불필요한 중복 사진 및 영양가 없는 화면이 성공적으로 정리되었습니다!")
