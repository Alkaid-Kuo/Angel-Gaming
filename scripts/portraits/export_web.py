"""選手立繪 → 網頁資源與立繪清單。

讀量產成品 output/portraits-v1/final/（full/ 透明立繪、avatars/ 頭像），輸出：
  public/portraits/full/<id>.webp     最長邊 768
  public/portraits/avatars/<id>.webp  256×256
  src/manage/portraits.ts             立繪清單（id、品階、性別），開局分配用

性別取自角色表 output/portraits-roster-v2.json。原圖不動；public/ 由 vite 原樣複製進建置產物。

用法（在專案根目錄）：
  python -I scripts/portraits/export_web.py <final 資料夾> <角色表.json>
例：
  python -I scripts/portraits/export_web.py ../../../output/portraits-v1/final ../../../output/portraits-roster-v2.json
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image

RARITIES = ("N", "R", "SR", "SSR")
FULL_LONG = 768
AVATAR = 256
QUALITY = 82
ID_RE = re.compile(r"^(N|R|SR|SSR)_(\d{3})$")


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    final = Path(sys.argv[1])
    roster = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    gender = {r["id"]: r["gender"] for r in roster}

    ids = sorted((p.stem for p in (final / "full").glob("*.png")), key=lambda s: (RARITIES.index(s.split("_")[0]), s))
    for i in ids:
        if not ID_RE.match(i):
            sys.exit(f"檔名不是 <品階>_<三位數>：{i}")
        if not (final / "avatars" / f"{i}.png").exists():
            sys.exit(f"缺頭像：{i}")
        if gender.get(i) not in ("f", "m"):
            sys.exit(f"角色表沒有 {i} 的性別")

    root = Path("public/portraits")
    (root / "full").mkdir(parents=True, exist_ok=True)
    (root / "avatars").mkdir(parents=True, exist_ok=True)
    total = 0
    for i in ids:
        im = Image.open(final / "full" / f"{i}.png").convert("RGBA")
        k = FULL_LONG / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        out = root / "full" / f"{i}.webp"
        im.save(out, "WEBP", quality=QUALITY, method=6)
        total += out.stat().st_size
        av = Image.open(final / "avatars" / f"{i}.png").convert("RGBA").resize((AVATAR, AVATAR), Image.LANCZOS)
        out = root / "avatars" / f"{i}.webp"
        av.save(out, "WEBP", quality=QUALITY, method=6)
        total += out.stat().st_size

    lines = [
        "// 選手立繪清單：由 scripts/portraits/export_web.py 從 output/portraits-v1/final/ 掃出來生成，不要手改。",
        "// 圖檔在 public/portraits/（full＝全身立繪、avatars＝頭像）。性別只給分配與測試用，Player 不存性別。",
        "import type { Rarity } from './types.ts';",
        "",
        "export interface PortraitSpec {",
        "  readonly id: string;",
        "  readonly rarity: Rarity;",
        "  readonly gender: 'f' | 'm';",
        "}",
        "",
        "export const PORTRAITS: readonly PortraitSpec[] = [",
    ]
    lines += [f"  {{ id: '{i}', rarity: '{i.split('_')[0]}', gender: '{gender[i]}' }}," for i in ids]
    lines += ["];", ""]
    Path("src/manage/portraits.ts").write_text("\n".join(lines), encoding="utf-8", newline="\n")

    count = {r: sum(1 for i in ids if i.startswith(r + "_")) for r in RARITIES}
    print(f"{len(ids)} 張：{count}；WebP 合計 {total / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
