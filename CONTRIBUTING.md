# 贡献指南

欢迎改进 SerialFlow。用户功能与安装说明见 [README](README.md)；本文说明源码开发、验证与发布流程。

## 开发环境

- Git。
- **Bun 1.4.2+**：依赖管理、TypeScript 辅助脚本和测试统一使用 Bun；建议与 `package.json` 的 `packageManager` 指定版本一致。
- Python 3 和当前平台可用的 C/C++ 编译工具链：`serialport` 等原生依赖需要与 Electron 的运行环境匹配，缺少可用预编译包时会从源码构建。

Windows 虚拟串口驱动是可选功能。编译它还需要 Visual Studio C++、匹配的 Windows SDK / WDK 和 WDK 扩展，详见 [驱动说明](driver/SerialFlowVirtualSerial/README.md)。

无需额外安装 Node.js 或 npm。`bunfig.toml` 的 `[run] bun = true` 让项目命令及第三方 CLI 的 Node shebang 统一使用 Bun，安装脚本也复用当前 Bun 可执行文件。GitHub Actions 仅安装 Bun 作为项目的 JavaScript 工具链；checkout、artifact 等 Action 自身的运行时由 GitHub Runner 提供。

Electron 应用仍使用其内置的 Node 运行时，因此保留 `node:*` 兼容 API、`@types/node`、`tsconfig.node.json` 和 Electron 调试器配置。它们不要求系统安装 Node。`electron-builder.yml` 中的 `npmRebuild` 是上游配置名，用于重建原生模块，也不表示使用 npm 安装依赖。

## 从源码运行

```bash
git clone https://github.com/calendarli/SerialFlow.git
cd SerialFlow
bun install --frozen-lockfile
bun run dev
```

依赖以 `package.json` 和 `bun.lock` 为准。增删或升级依赖时使用 Bun，并提交对应的清单与锁文件变更，避免引入其他包管理器的锁文件。

安装时的 `postinstall` 会依次安装 Electron 二进制、为 Electron 重建原生依赖，然后尝试构建虚拟串口驱动与下载 esptool。驱动和 esptool 失败只会警告，不阻止基础应用开发；Electron 安装或原生依赖重建失败则需要处理后重试。

切换 Electron 版本或运行环境后，若出现原生模块不匹配，可重新执行：

```bash
bun run postinstall
```

## 项目结构

Modbus 设备预设的数据校验、编码与顺序执行位于 `src/renderer/src/modbus-presets.ts`，
界面位于 `components/ModbusPresets.tsx`，复用 `ModbusPanel` 的 RTU 客户端。
侧栏内容区最小宽度由 `sidebar-layout.ts` 统一定义，普通 TAB 和 Modbus 拖拽侧栏应保持一致。
修改后运行 `bun test tests/modbus-presets.test.ts tests/serial-protocols.test.ts`，构建后执行
`bun run test:ui:serial`，覆盖二级 TAB 切换与状态保留、栏宽拖拽与恢复、空白右键新建、分组编辑、弹窗按钮布局、主页寄存器保存、配置列表切换、重载保存和寄存器数据精确还原；真实设备仍需单独验收。

实时曲线使用独立的 `plot-store.ts` 环形缓存，`plot-data.ts` 提供原始区间统计和按像素保留峰谷的降采样，计算通道在 QuickJS Worker 中批量执行。修改曲线时运行 `bun test tests/plot-data.test.ts`，生产构建后运行 `bun run test:ui:plot` 和 `bun run test:ui:serial`。曲线 UI 测试覆盖游标交叉/重合、冻结/恢复、日志独立性、计算通道以及 100,000 点 × 8 通道，并将截图和延迟指标写入 `.tmp/ui-smoke/`。这些测试使用模拟数据，不代表硬件采样精度验收。

数据窗口的字段解析位于 `src/renderer/src/data-window-parser.ts`，编程换算位于
`src/renderer/src/data-window-program.ts`，复用 QuickJS Worker 的内存和执行时间限制。
修改换算行为时运行 `bun test tests/data-window-parser.test.ts tests/data-window-program.test.ts`，
并在生产构建后运行 `bun run test:ui:serial`。处理队列仅保留最新待处理值；配置变更、断线和关闭窗口时须清理运行器，避免旧结果覆盖新配置。

```text
SerialFlow/
├── src/
│   ├── common/                 # 跨进程共享类型与固件、更新定义
│   ├── main/                   # Electron 主进程、串口、文件传输与更新
│   │   └── firmware/           # 固件校验与烧录任务管理
│   ├── preload/                # 暴露给界面的 IPC 接口与类型
│   └── renderer/
│       ├── src/                # React 主界面、分帧、协议与指令执行
│       │   ├── components/     # 界面组件
│       │   ├── scripts/        # QuickJS 运行时、TypeScript 转译与 Worker
│       │   └── workers/        # 曲线处理 Worker
│       ├── help/               # 帮助页面的 React / HTML 入口
│       └── programming-manual/ # 编程手册的 React / HTML 入口
├── scripts/                    # 安装、资源准备、UI 验证与发布脚本
├── tests/                      # Bun 自动化测试
├── driver/SerialFlowVirtualSerial/ # Windows UMDF 2 驱动及管理器
├── resources/                  # 运行时资源、固件工具和驱动包
├── build/                      # 图标、安装器资源及部分生成文件
├── docs/                       # 专题文档
├── .github/workflows/          # 发布验证、构建与上传流程
├── bunfig.toml                 # 强制第三方 CLI 使用 Bun 运行
├── electron.vite.config.ts     # 主进程、preload、界面及手册构建
└── electron-builder.yml        # 安装包、平台资源与更新源配置
```

技术栈为 Electron、React、TypeScript、electron-vite / Vite、serialport、QuickJS 和 TanStack Virtual，具体版本以 `package.json` 为准。

主进程、preload 和渲染进程通过 `@common/*` 使用共享代码；`@renderer/*` 指向 `src/renderer/src/`。帮助和编程手册都是 React / Vite 多页面入口，不再位于 `src/renderer/public/`，也不能直接打开源码 HTML 作为完整手册使用。

构建输出位于 `out/`，安装包默认输出到 `dist/`。不要提交生成的应用、安装包或下载的工具二进制。

## 常用命令与验证

| 命令                   | 用途                                     |
| ---------------------- | ---------------------------------------- |
| `bun run dev`          | 启动开发环境                             |
| `bun run start`        | 预览已构建应用，需先完成构建             |
| `bun run format`       | 格式化仓库文件，会修改文件               |
| `bun run format:check` | 检查格式                                 |
| `bun run lint`         | ESLint 检查                              |
| `bun run typecheck`    | 检查主进程 / preload、界面和工具脚本类型 |
| `bun test`             | 运行自动化测试                           |
| `bun run build`        | 类型检查并生成生产构建                   |

类型检查分别由 `tsconfig.node.json`、`tsconfig.web.json` 和 `tsconfig.tools.json` 配置，工具配置也包含 Bun 测试。

提交前运行格式检查、Lint、类型检查及与改动相关的测试。可以指定测试文件，例如：

```bash
bun test tests/serial-protocols.test.ts
```

涉及固件或更新界面时，先构建，再执行对应的 Electron 界面回归：

```bash
bun run build
bun run test:ui
bun run test:ui:updates
```

`test:ui` 验证固件流程，`test:ui:updates` 验证更新流程。这些测试使用模拟对象，不会实际烧写设备，不能替代硬件验收。固件改动还应验证真实设备的烧录、启动、取消、断线与串口恢复；虚拟串口兼容性验证见 [驱动说明](driver/SerialFlowVirtualSerial/README.md)。

## 构建与打包

| 命令                          | 输出目标                              |
| ----------------------------- | ------------------------------------- |
| `bun run build:unpack`        | 未封装为安装程序的应用目录            |
| `bun run build:win`           | Windows NSIS 安装程序                 |
| `bun run build:mac`           | macOS DMG、ZIP                        |
| `bun run build:linux`         | Linux AppImage、Snap、DEB             |
| `bun run package:win-x64`     | Windows x64 NSIS，不自动发布          |
| `bun run package:linux-x64`   | Linux x64 AppImage、DEB，不自动发布   |
| `bun run package:linux-arm64` | Linux ARM64 AppImage、DEB，不自动发布 |

这些命令均先执行生产构建。目标平台的打包工具、签名和原生依赖需另行准备，存在构建配置不代表任意宿主平台都能直接交叉打包。当前发布工作流覆盖 Windows x64、Linux x64 / ARM64；macOS 未纳入自动发布，配置中的公证也未启用。

### 可选工具与架构资源

```bash
bun run build:driver
bun run fetch:esptool
```

- 驱动仅在 Windows 上构建，使用 `SERIALFLOW_ARCH` 选择 `x64` 或 `arm64`。中间产物位于 `build/virtual-serial/<arch>`，完整驱动包复制到 `resources/virtual-serial/win-<arch>`。构建不会安装驱动或导入证书。
- esptool 的版本、资产和校验和固定在 `scripts/fetch-esptool.ts`，声明见 [NOTICE](resources/firmware/NOTICE.md)。资源保存在 `resources/firmware/esp32/<os>-<arch>`，目录前缀使用 `win`、`mac`、`linux`，ARM 32 位使用 `armv7l`。
- 下载目标由 `SERIALFLOW_PLATFORM`（`win32` / `darwin` / `linux`）和 `SERIALFLOW_ARCH`（`x64` / `arm64` / `arm`）决定，默认使用当前系统和架构。准备其他目标资源时，应在运行下载命令前设置这两个环境变量。
- 当前没有 Windows ARM64 的固定 esptool 预编译资产；用户可在界面中指定兼容工具。缺少目标资源时可能省略对应可选功能，发布前应检查日志和包内容。

安装包按目标系统与架构复制资源，Windows 虚拟串口驱动仅进入 Windows 包。macOS / Linux 固件功能的硬件验证边界见 [固件烧录说明](docs/firmware-flashing.md)。

## 提交改动

1. 围绕一个明确问题或功能组织改动；较大的行为变更建议先通过 Issue 讨论。
2. 修复行为时补充有意义的回归测试，界面变化可附截图或操作录屏。
3. PR 说明应包含问题、改动后的行为、验证结果及尚未验证的平台或硬件。
4. 改动用户功能、脚本或目录结构时，同步更新对应帮助页面和文档。

建议使用 `feat:`、`fix:`、`perf:`、`docs:` 等提交前缀，发布说明会按这些前缀分组。修改驱动时保留原有 Microsoft 版权和许可声明；许可证范围见 [README](README.md#开源协议)。

## 发布流程（维护者）

在工作区干净、位于分支且 Git 身份已配置的情况下，执行：

```bash
bun run release:version patch
```

参数也可为 `minor`、`major` 或更高的明确稳定版本号。该命令会修改 `package.json`，**创建版本提交和带注释的 `vX.Y.Z` 标签**，但不会推送；随后会打印用于原子推送分支与标签的命令。只在准备发布时执行。

推送版本标签后，[发布工作流](.github/workflows/release.yml) 将：

1. 校验标签版本与 `package.json`、当前提交一致，并从提交历史生成发布说明。
2. 执行依赖安装、Lint、类型检查和 Bun 测试。
3. 分别构建 Windows x64、Linux x64 / ARM64 安装包。
4. 检查安装包、blockmap 和更新元数据，生成 `SHA256SUMS.txt` 后发布 GitHub Release。

工作流允许重试失败的草稿，不覆盖已经正式发布的 Release。更新源为 `calendarli/SerialFlow` 的 GitHub Releases，发布时必须保留生成的更新元数据和差分文件。若另行发布 macOS 自动更新，还需要提供 ZIP 包。
