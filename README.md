> **原项目：[qianyiai/kurocat](https://github.com/qianyiai/kurocat)**
>
> 本项目是在原项目 [qianyiai/kurocat](https://github.com/qianyiai/kurocat) 基础上进行的二次开发（衍生作品），遵循原项目的开源协议（[MIT License](./LICENSE)）。本项目与原作者无关，不代表原作者立场；原项目的版权与贡献归原作者及所有贡献者所有。

# MiniCat

一只住在桌面上的打字小黑猫。透明、置顶、极轻量，你敲键盘它就跟着敲；支持 Windows 与 macOS，内置 7 款皮肤、6 种实时心情、密码防偷窥、65% / 108 键切换和 AI 捏猫。

[官方网站](https://37lj1lcl30ek76wo2d9.traesite.cn/) · [在线试玩](https://37lj1lcl30ek76wo2d9.traesite.cn/#playground) · [下载安装](https://github.com/xpfyg/minicat/releases) · [项目源码](https://github.com/xpfyg/minicat)

## 这是什么

MiniCat 是一个开源桌面宠物：一只会随着你的键盘和鼠标动作敲键盘的小猫，常驻在桌面右下角。

技术上使用 **Tauri v2 + Rust 原生全局键鼠钩子 + HTML5 Canvas 2D**，没有 Electron 运行时，单文件安装包约 1.6 MB，常驻内存约 20 MB 级别。

## 官网

https://37lj1lcl30ek76wo2d9.traesite.cn/

官网支持在浏览器里直接试玩：切换 7 款皮肤、6 种心情、65% / 108 键布局、正反视角、密码防偷窥和无级缩放，无需安装。

## 功能特性

### 皮肤与动画

- 6 款手绘猫咪：经典小黑猫、暖奶茶布偶猫、大橘猫、三花猫、奶牛猫、暹罗猫
- 🐳 大肥鱼（鲸鱼娘）：左手点鼠标、右手敲键盘、鲸尾甩拍功能键，手速越快越脸红
- 右键或托盘 0.1 秒无缝换肤，无需重启

### 情绪系统

- **6 种实时心情**：平常、好奇、开心、放松、烦躁、犯困，全部由真实输入自动驱动
- 光标靠近时好奇：瞳孔放大、追瞳增强、耳朵上提，偶尔冒出问号
- 摸头时开心：眯眼、腮红与爱心粒子；播放音乐时放松并飘出音符
- 45 秒无操作开始犯困：眼睛缓慢闭合、呼吸变慢、低头并飘出 Zzz，按键或摸头立即清醒
- 连续打字 16 秒进入烦躁；密码模式优先级最高，会覆盖并隐藏所有心情特效

### 键盘与鼠标

- **65% 紧凑** 与 **108 键全尺寸** 一键切换，108 键包含完整 F 区、编辑区和数字小键盘
- **面向猫咪 / 面向观众** 双视角，同步重投影 3D 梯形透视
- 鼠标左键、右键、中键/滚轮独立识别高亮，左右键可同时按住
- 按键时弹出 3D 键帽气泡，可随时隐藏

### 隐私保护

- 系统级识别密码输入框：Windows 使用 UI Automation 与 `ES_PASSWORD`，macOS 使用 `IsSecureEventInputEnabled` 与 `AXSecureTextField`
- 检测到密码框时猫咪自动闭眼，大肥鱼双手捂眼，同时隐藏所有键帽与气泡
- Rust 底层钩子拦截按键，不向外传递

### 交互与系统集成

- 摸头互动：光标变成小手，来回抚摸触发眯眼表情和 Web Audio 实时合成的呼噜声
- **20%–150% 无级缩放**，右下角锚定不漂移
- 透明区域点击穿透，按住 `Alt` 临时解锁拖动或右键
- 无边框 / 全屏优化游戏下的持续 Z 序置顶，不抢焦点
- 托盘支持以管理员身份重启（捕获游戏键鼠）与反作弊护航暂停
- App 内自动检测新版本，SHA-256 校验后静默升级

### AI 捏猫（MCP）

程序内置 **Stdio** 与 **本机 Streamable HTTP（`127.0.0.1:27420`）** 两种 MCP 服务端，无需 Node.js 或 Python。把自家猫的照片发给 Claude Desktop、Cursor、Antigravity、Windsurf 等客户端，即可让 AI 生成专属花色并热更新上屏。

## 下载安装

安装包由 GitHub Actions 自动编译并发布到 [Releases](https://github.com/xpfyg/minicat/releases)。

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10 / 11 (x64) | [MiniCat-x64-setup.exe](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-x64-setup.exe) | NSIS 安装版，自动创建桌面图标与卸载入口 |
| macOS 10.15+ | [MiniCat-macos-universal.dmg](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-macos-universal.dmg) | Universal 通用镜像，兼容 Apple Silicon 与 Intel |
| Linux x86_64 | [.deb](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-linux-amd64.deb) · [.AppImage](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-linux-amd64.AppImage) | Debian / Ubuntu / 麒麟 / UOS |
| Linux ARM64 | [.deb](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-linux-arm64.deb) · [.AppImage](https://github.com/xpfyg/minicat/releases/latest/download/MiniCat-linux-arm64.AppImage) | 飞腾 / 鲲鹏 / 树莓派 |

### Windows 首次运行

开源软件未购买商业代码签名证书，Edge / Chrome 可能提示「通常不会下载」：

1. 在下载记录上点右侧 `···` → 「保留」
2. 弹窗出现「删除」时，点旁边下箭头 `▾` → 「仍然保留」
3. 安装时若出现「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」

极少数精简版 Win10 缺少 WebView2 Runtime，可安装微软官方引导程序：[MicrosoftEdgeWebview2Setup.exe](https://go.microsoft.com/fwlink/p/?LinkId=2124703)。

### macOS 首次运行

未公证应用首次打开若提示「无法验证开发者」或「已损坏」，在终端执行一次：

```bash
xattr -cr /Applications/MiniCat.app
```

随后在「系统设置 → 隐私与安全性」中，为 `MiniCat` 勾选 **辅助功能** 和 **输入监控**。

## MCP 接入

运行 MiniCat，右键猫咪 → 开启「MCP 扩展」→ 点击「复制 MCP 配置」，粘贴到客户端配置文件中。

Stdio 模式（Windows 示例）：

```json
{
  "mcpServers": {
    "minicat": {
      "command": "C:\\Users\\<你的用户名>\\AppData\\Local\\MiniCat\\MiniCat.exe",
      "args": ["--mcp"]
    }
  }
}
```

本机 HTTP 模式（桌宠运行时可用）：

```json
{
  "mcpServers": {
    "minicat": {
      "url": "http://127.0.0.1:27420/mcp"
    }
  }
}
```

内置工具：

| 工具 | 作用 |
| --- | --- |
| `list_cats` | 列出内置与自定义皮肤 |
| `get_cat_schema` | 获取花色参数规范与花纹模板 |
| `upsert_cat` | 新增或修改自定义猫咪，实时热更新 |
| `switch_cat` | 切换当前皮肤 |
| `delete_cat` | 删除自定义皮肤 |
| `get_settings` / `update_settings` | 读取或修改缩放、气泡、呼噜声、置顶等设置 |

自定义皮肤保存在：

- Windows：`%APPDATA%\mini-cat-pet\cats.json`
- macOS：`~/Library/Application Support/mini-cat-pet/cats.json`

## 从源码构建

前置环境：Node.js 18+、Rust 工具链、系统对应的 Tauri 依赖。

```bash
git clone https://github.com/xpfyg/minicat.git
cd minicat
npm install

npm run tauri:dev      # 本地调试
npm run tauri:build    # 编译安装包
npm run build:web      # 构建官网静态站（输出 dist-web）
```

## 自动发布

推送 `v*` 标签即触发构建：Windows 生成 NSIS 安装包，macOS 生成 Universal DMG 与 `app.tar.gz`，Linux 生成 deb 与 AppImage，全部完成后自动发布 Release。

```bash
git tag v4.8.0
git push origin v4.8.0
```

也可以在 Actions 中手动运行 workflow，并填写 `release_tag` 指定版本。

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。第三方素材与依赖遵循各自许可证。

---

原项目：[qianyiai/kurocat](https://github.com/qianyiai/kurocat)
