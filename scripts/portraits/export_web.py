"""選手立繪 → 網頁資源與立繪清單。

讀量產成品 output/portraits-v1/final/（full/ 透明立繪、avatars/ 頭像），輸出：
  public/portraits/full/<id>.webp     最長邊 768
  public/portraits/avatars/<id>.webp  256×256
  src/manage/portraits.ts             立繪清單（id、品階、性別），開局分配用

性別取自角色表 output/portraits-roster-v2.json；頭像中心取自 final/full/avatar-crops.json（介面裁半身用）。
原圖不動；public/ 由 vite 原樣複製進建置產物。

用法（在專案根目錄）：
  python -I scripts/portraits/export_web.py <final 資料夾> <角色表.json> [--list-only] [--grade] [--out 資料夾]
    --list-only  只重寫立繪清單，不轉圖
    --grade      調色：降飽和、陰影偏墨藍、高光偏暖金，收攏到介面的墨黑＋金色調
    --out        圖檔輸出位置（預設 public/portraits）
例：
  python -I scripts/portraits/export_web.py ../../../output/portraits-v1/final ../../../output/portraits-roster-v2.json --grade
"""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RARITIES = ("N", "R", "SR", "SSR")
FULL_LONG = 768
AVATAR = 256
QUALITY = 82
ID_RE = re.compile(r"^(N|R|SR|SSR)_(\d{3})$")
# 調色：飽和度保留比例、陰影色（墨藍）、高光色（暖金）與各自的強度
GRADE_SAT = 0.8
GRADE_SHADOW = np.array([28, 37, 53], dtype=np.float32)
GRADE_HIGHLIGHT = np.array([255, 226, 170], dtype=np.float32)
GRADE_SHADOW_MIX = 0.22
GRADE_HIGHLIGHT_MIX = 0.12


def grade(im: Image.Image) -> Image.Image:
    a = np.asarray(im, dtype=np.float32)
    rgb, alpha = a[..., :3], a[..., 3:]
    lum = (rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[..., None]
    rgb = lum + (rgb - lum) * GRADE_SAT
    t = lum / 255
    rgb = rgb + (GRADE_SHADOW - rgb) * GRADE_SHADOW_MIX * (1 - t) ** 2
    rgb = rgb + (GRADE_HIGHLIGHT - rgb) * GRADE_HIGHLIGHT_MIX * t**2
    return Image.fromarray(np.concatenate([np.clip(rgb, 0, 255), alpha], axis=-1).astype(np.uint8), "RGBA")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("final")
    ap.add_argument("roster")
    ap.add_argument("--list-only", action="store_true")
    ap.add_argument("--grade", action="store_true")
    ap.add_argument("--out", default="public/portraits")
    args = ap.parse_args()
    final = Path(args.final)
    roster = json.loads(Path(args.roster).read_text(encoding="utf-8"))
    gender = {r["id"]: r["gender"] for r in roster}
    crops = json.loads((final / "full" / "avatar-crops.json").read_text(encoding="utf-8"))["crops"]

    ids = sorted((p.stem for p in (final / "full").glob("*.png")), key=lambda s: (RARITIES.index(s.split("_")[0]), s))
    for i in ids:
        if not ID_RE.match(i):
            sys.exit(f"檔名不是 <品階>_<三位數>：{i}")
        if not (final / "avatars" / f"{i}.png").exists():
            sys.exit(f"缺頭像：{i}")
        if gender.get(i) not in ("f", "m"):
            sys.exit(f"角色表沒有 {i} 的性別")
        if f"{i}.png" not in crops:
            sys.exit(f"avatar-crops.json 沒有 {i}")

    # 頭像中心與邊長，換成立繪寬高的比例（立繪 1024×1536，等比縮放後比例不變）
    size = Image.open(final / "full" / f"{ids[0]}.png").size
    face = {i: (crops[f"{i}.png"]["cx"] / size[0], crops[f"{i}.png"]["cy"] / size[1], crops[f"{i}.png"]["side"] / size[0]) for i in ids}

    root = Path(args.out)
    total = 0
    if not args.list_only:
        (root / "full").mkdir(parents=True, exist_ok=True)
        (root / "avatars").mkdir(parents=True, exist_ok=True)
        for i in ids:
            im = Image.open(final / "full" / f"{i}.png").convert("RGBA")
            k = FULL_LONG / max(im.size)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            if args.grade:
                im = grade(im)
            out = root / "full" / f"{i}.webp"
            im.save(out, "WEBP", quality=QUALITY, method=6)
            total += out.stat().st_size
            av = Image.open(final / "avatars" / f"{i}.png").convert("RGBA").resize((AVATAR, AVATAR), Image.LANCZOS)
            if args.grade:
                av = grade(av)
            out = root / "avatars" / f"{i}.webp"
            av.save(out, "WEBP", quality=QUALITY, method=6)
            total += out.stat().st_size

    lines = [
        "// 選手立繪清單：由 scripts/portraits/export_web.py 從 output/portraits-v1/final/ 掃出來生成，不要手改。",
        "// 圖檔在 public/portraits/（full＝全身立繪、avatars＝頭像）。性別只給分配與測試用，Player 不存性別。",
        "// face：頭像中心 x、y 與頭像邊長，都是立繪寬高的比例（x 與邊長對寬、y 對高），介面裁半身用。",
        "import type { Rarity } from './types.ts';",
        "",
        "export interface PortraitSpec {",
        "  readonly id: string;",
        "  readonly rarity: Rarity;",
        "  readonly gender: 'f' | 'm';",
        "  readonly face: readonly [number, number, number];",
        "}",
        "",
        "export const PORTRAITS: readonly PortraitSpec[] = [",
    ]
    lines += [f"  {{ id: '{i}', rarity: '{i.split('_')[0]}', gender: '{gender[i]}', face: [{face[i][0]:.3f}, {face[i][1]:.3f}, {face[i][2]:.3f}] }}," for i in ids]
    lines += ["];", ""]
    Path("src/manage/portraits.ts").write_text("\n".join(lines), encoding="utf-8", newline="\n")

    count = {r: sum(1 for i in ids if i.startswith(r + "_")) for r in RARITIES}
    print(f"{len(ids)} 張：{count}" + ("" if args.list_only else f"；WebP 合計 {total / 1024 / 1024:.2f} MB" + ("（已調色）" if args.grade else "")))


if __name__ == "__main__":
    main()
