"""
把超过服务端上限（2MB）的图片压小。

为什么需要：`scripts/import-cats.mjs` 遇到 >2MB 的图会跳过（服务端只收 2MB），
而上一届图鉴里有 20 张原图是 2.1–8.7MB 的。压小后可用 `--attach` 补进去：

    node scripts/import-cats.mjs --attach <压缩后的目录> --db ... --images ...

为什么是 Python 而不是 JS：仓库运行时零依赖，Node 没有内置图片编解码。
这是**一次性/开发期工具**，不参与运行时，需要 Pillow（`pip install pillow`）。
没有 Pillow 也能继续用小程序管理端手动补图（客户端上传时会自动压缩）。

规则：
  · 长边最大 1600px（手机上看图鉴够用）
  · 先 quality=85 存 JPEG，还超 2MB 就逐步降质量 / 缩尺寸
  · **输出文件名保持原名** —— 导入脚本是按「封面-<猫名>.jpg」「在校照片-<猫名>-<n>.jpg」
    认猫的，改了名就认不出来
  · 原图只读，不动

用法：
    python scripts/shrink-images.py "<原图目录>" "<输出目录>"
"""
import io
import os
import sys

try:
    from PIL import Image
except ImportError:                     # 给出能照着做的提示，而不是一个 traceback
    print("需要 Pillow：pip install pillow", file=sys.stderr)
    sys.exit(2)

LIMIT = 2 * 1024 * 1024
MAX_SIDE = 1600
# 依次尝试：(长边上限, 质量)。第一档压不下来才往下走
ATTEMPTS = [(1600, 85), (1600, 75), (1400, 75), (1200, 72), (1000, 70)]


def shrink(src_path, dst_path):
    """返回 (原始字节, 输出字节, 最终尺寸)。压不到 2MB 以内就抛错。"""
    with Image.open(src_path) as im:
        im = im.convert("RGB")          # PNG 透明通道丢掉：这些是照片，用不上
        for side, quality in ATTEMPTS:
            cur = im
            if max(im.size) > side:
                s = side / max(im.size)
                cur = im.resize((max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s))),
                                Image.LANCZOS)
            buf = io.BytesIO()
            cur.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
            if buf.tell() <= LIMIT:
                with open(dst_path, "wb") as f:
                    f.write(buf.getvalue())
                return os.path.getsize(src_path), buf.tell(), cur.size

    raise RuntimeError(f"{os.path.basename(src_path)} 压不到 2MB 以内")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1

    src_dir, out_dir = sys.argv[1], sys.argv[2]
    if not os.path.isdir(src_dir):
        print(f"不是目录：{src_dir}", file=sys.stderr)
        return 1
    os.makedirs(out_dir, exist_ok=True)

    done, failed, skipped = [], [], 0
    for name in sorted(os.listdir(src_dir)):
        src = os.path.join(src_dir, name)
        if not os.path.isfile(src):
            continue
        if os.path.getsize(src) <= LIMIT:
            skipped += 1                 # 本来就不超限，不用管
            continue
        dst = os.path.join(out_dir, os.path.splitext(name)[0] + ".jpg")
        try:
            before, after, size = shrink(src, dst)
            done.append((name, before, after, size))
        except Exception as e:           # noqa: BLE001 —— 一张失败不该让整批停
            failed.append((name, str(e)))

    print(f"\n输出目录：{out_dir}\n")
    print(f"{'文件':<34} {'原大小':>9} {'压缩后':>9}  尺寸")
    for name, before, after, size in sorted(done, key=lambda x: -x[1]):
        print(f"{name:<34} {before / 1024 / 1024:>7.1f}MB {after / 1024 / 1024:>7.2f}MB  {size[0]}x{size[1]}")
    print(f"\n压缩 {len(done)} 张，跳过（本来就不超限）{skipped} 张，失败 {len(failed)} 张")
    for name, err in failed:
        print(f"  ✗ {name}: {err}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
