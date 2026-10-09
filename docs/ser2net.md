# 使用 ser2net 远程调试串口

没有桌面的 Linux 设备只需运行 ser2net；在另一台有桌面的电脑运行 SerialFlow，通过网络收发串口数据，无需安装虚拟串口驱动。

```text
SerialFlow（有 GUI 的电脑）
       │ TCP 网络连接
       ▼
ser2net（无 GUI 的 Linux 设备）
       │ /dev/ttyUSB0、/dev/ttyACM0 或板载 UART
       ▼
待调试设备
```

## 支持范围

SerialFlow 的“ser2net TCP（远程串口）”使用 **原始 TCP 字节流**。支持文本/HEX 收发、接收分帧、快捷指令、自动回复、数据窗口、曲线及基于这些收发接口的 Modbus RTU。可同时配置本地串口和多个远程端点，配置可保存到本机并随 `.serialflow` 工程导入导出。

- 波特率、数据位、停止位、校验和流控由 **ser2net 所在设备** 配置。远程模式不显示本地串口参数控件；不能从 SerialFlow 修改远端参数、DTR、RTS 或发送 BREAK。
- 当前不支持 Telnet、RFC2217 协商、直接 TLS 或 ser2net 的 `mux/certauth` 协议。服务端请使用 `accepter: tcp,...`，不要使用 `telnet(rfc2217),tcp,...`。RFC2217 可传递串口控制参数，但它与原始 TCP 不是同一种协议，详见 [ser2net 官方说明](https://github.com/cminyard/ser2net)。
- 固件烧录页面仍使用本地串口或 ST-LINK，不支持把远程 TCP 地址交给 STM32 / ESP32 / Ymodem 烧录流程。
- 普通文件传输使用同一条连接；SerialFlow 文件协议仍要求串口另一端实现该协议，ser2net 本身不会接收文件或烧写固件。
- 检测到远端关闭或网络错误时更新连接状态；手动重新连接，不自动重发旧数据。TCP 建连和阻塞写入各有 10 秒超时；空闲连接不会因为没有串口数据而被主动关闭。静默网络中断由系统 TCP 保活检测，提示不一定立即出现。

以下示例使用 Linux 上的 ser2net **4.x YAML 配置**，以 Debian / Ubuntu / Raspberry Pi OS 为例。不同发行版的配置路径和 systemd 单元可能不同，请以安装包和 `systemctl cat ser2net` 的输出为准。

## 1. 在无 GUI 设备上安装并确认串口

通过 SSH 登录远端 Linux 设备：

```bash
sudo apt update
sudo apt install ser2net
ser2net -v
ls -l /dev/serial/by-id/
ls -l /dev/ttyUSB* /dev/ttyACM*
```

没有对应 USB 设备时，部分 `ls` 命令显示不存在是正常现象。板载 UART 常见名称包括 `/dev/ttyS0`、`/dev/ttyAMA0`，也可能需要先在系统设置中启用。

后续假设串口为 `/dev/ttyUSB0`，设备参数为 **115200、8 数据位、无校验、1 停止位、无流控**。请替换成实际参数。有稳定的 `/dev/serial/by-id/...` 路径时优先使用它，避免 USB 重新插拔后编号变化。

检查权限和占用：

```bash
ls -l /dev/ttyUSB0
sudo fuser -v /dev/ttyUSB0
systemctl cat ser2net
systemctl show ser2net -p User -p Group -p ExecStart
```

关闭正在占用该端口的串口终端或其他服务。若该 UART 用作系统登录控制台，还需在确认不依赖它登录后停用对应的 `serial-getty`，并检查系统启动参数。USB TTL 的电平、GND、TX/RX 交叉连接也必须正确。

## 2. 配置原始 TCP 转发

软件包常使用 `/etc/ser2net.yaml` 或 `/etc/ser2net/ser2net.yaml`。先从 `systemctl cat ser2net` 查看 `ExecStart` 的 `-c` 参数，确认实际配置文件；修改前备份现有文件。不要把示例覆盖到仍承载其他业务的配置上。

下面以 `/etc/ser2net.yaml` 为例；如果实际路径不同，后续命令统一替换：

```bash
sudo cp -a /etc/ser2net.yaml /etc/ser2net.yaml.backup
sudo nano /etc/ser2net.yaml
```

使用以下配置，将示例地址 `192.168.1.50` 替换成 **无 GUI 设备自身的局域网地址**：

```yaml
%YAML 1.1
---
connection: &serialflow_uart0
  accepter: tcp,192.168.1.50,2000
  connector: serialdev,/dev/ttyUSB0,115200n81,local
  timeout: 0
  options:
    max-connections: 1
```

这段配置沿用 ser2net 的 version 1 YAML 形式。`accepter` 指定 TCP 监听地址和端口；`connector` 指定串口及参数；`local` 忽略调制解调器载波状态；`timeout: 0` 禁用空闲断开；只允许一个连接，避免多个调试端同时写入。配置语法见 [官方配置示例](https://github.com/cminyard/ser2net/blob/master/ser2net.yaml) 和 [配置手册](https://github.com/cminyard/ser2net/blob/master/ser2net.yaml.5)。

`115200n81` 表示 115200 / 无校验 / 8 数据位 / 1 停止位。其他例子：`9600e71` 表示 9600 / 偶校验 / 7 数据位 / 1 停止位。示例未启用流控；设备确实需要 RTS/CTS 时在 connector 中添加 `rtscts`，需要软件流控时参阅所安装版本的 `man gensio`。参数说明见 [gensio 官方手册](https://github.com/cminyard/gensio/blob/master/man/gensio.5)。

为保证二进制协议的字节完整性，不要为此连接配置 `banner`、`openstr` 或 `closestr`，也不要沿用会为这些选项设置内容的全局默认值。它们会插入欢迎文字或额外串口数据。单纯将 SerialFlow 地址写成 `tcp://...` 不会把服务端的 Telnet 端口转换为原始 TCP。

## 3. 启动与排错

修改好配置后：

```bash
sudo systemctl restart ser2net
sudo systemctl enable ser2net
sudo systemctl status ser2net --no-pager
sudo journalctl -u ser2net -n 80 --no-pager
sudo ss -ltnp 'sport = :2000'
```

应看到 `192.168.1.50:2000` 正在监听。不要同时运行 systemd 服务和另一个占用相同端口的 ser2net 进程。

若需要前台诊断，先停止服务，再明确指定配置文件：

```bash
sudo systemctl stop ser2net
sudo ser2net -d -c /etc/ser2net.yaml
```

`-d` 在前台运行并输出日志，`-c` 指定配置文件；这不是仅检查配置的命令，执行后会实际启动监听。按 Ctrl+C 结束，再运行 `sudo systemctl start ser2net`。参阅 [ser2net 命令行手册](https://github.com/cminyard/ser2net/blob/master/ser2net.8)。

前台以 root 运行成功而 systemd 服务失败，通常需要检查服务用户权限。若 `systemctl show` 显示服务使用 `ser2net` 用户，且串口设备属于 `dialout` 组，可执行：

```bash
sudo usermod -aG dialout ser2net
sudo systemctl restart ser2net
```

仅在实际存在该用户和组时使用以上命令；其他发行版可能使用 `uucp` 等组。不要用 `chmod 777` 解决设备权限问题。

## 4. 在 GUI 电脑上连接 SerialFlow

1. 打开左侧“串口”，添加或选择一套配置，可将名称改为“开发板 UART”。
2. 将“连接方式”改为 **ser2net TCP（远程串口）**。
3. 在“远程地址”输入 `tcp://192.168.1.50:2000`，点击 **连接远程串口**。主机名也可以，例如 `tcp://board.local:2000`；IPv6 使用 `tcp://[2001:db8::10]:2000`，当前地址格式不支持带网卡作用域的 IPv6 link-local 地址。
4. 在底部发送区选择这个 TCP 端点，按设备协议发送文本或 HEX，查看 RX/TX。发送文本时确认换行符是否符合设备要求。
5. 需要接收文本行时打开“接收分帧”并选择分隔符；二进制协议使用固定长度或帧头/帧尾。再按需配置快捷指令、自动回复和曲线。
6. 结束时点击 **断开远程串口**。修改远端串口参数后重启 ser2net，再重新连接。

GUI 电脑无需插入任何本地串口设备。刷新按钮只枚举 GUI 电脑的本地串口，不扫描远端串口，也不会替换已保存的 TCP 地址。每个远程串口由服务端单独映射为一个 TCP 端口。

连接成功表示 TCP 通道已建立，并不能独立证明 UART 参数正确或设备已经响应。发送成功表示本机 TCP 写入完成，不等于远端串口已排空或设备已执行命令，应以设备应答为准。

TCP 可能拆分、合并报文，网络接收时间也不同于 UART 字节到达时间。对 Modbus RTU 等场景，请按实际网络延迟增大响应超时，避免用网络数据块或空闲间隔推断精确的串口帧边界；这里传输的仍是 RTU 帧，不会转换为 Modbus TCP。

## 5. 多个远程串口

在 version 1 配置文件中继续添加不同名称、不同 TCP 端口的连接，例如：

```yaml
connection: &serialflow_uart1
  accepter: tcp,192.168.1.50,2001
  connector: serialdev,/dev/ttyUSB1,9600n81,local
  timeout: 0
  options:
    max-connections: 1
```

重启服务后，在 SerialFlow 添加第二套配置，地址填 `tcp://192.168.1.50:2001`。不要将同一个物理串口配置成多个独立转发入口。应用会阻止同一规范化 TCP 地址被重复打开，但主机别名和 IP 可能指向同一设备，仍应由服务端的连接数量限制保证独占。

ser2net version 1 的重复 `connection` 键是该程序支持的特殊格式，通用 YAML 校验器可能报重复键；不要与较新版本的 `connections:` 写法混用。

## 6. 跨网络连接：SSH 隧道

原始 TCP 没有认证和加密。局域网直连时，将监听地址和防火墙规则限制在可信网络；不要将这个端口直接映射到公网。跨网络可使用已有 VPN，或 SSH 隧道。

使用 SSH 隧道时，将远端 `accepter` 改为仅监听回环地址：

```yaml
accepter: tcp,127.0.0.1,2000
```

重启 ser2net，然后在 **GUI 电脑** 的终端运行：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:12000:127.0.0.1:2000 user@192.168.1.50
```

替换用户名和服务器地址，保持该终端运行。SerialFlow 的远程地址填写 **`tcp://127.0.0.1:12000`**。如果本机 12000 已被占用，更换 `-L` 中的本机端口并同步修改应用地址。SSH 使用你已有的认证方式，SerialFlow 不保存 SSH 密码或密钥。

## 常见问题

| 现象                             | 检查方法                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示连接被拒绝                   | 检查 IP/端口、`systemctl status ser2net`、`ss -ltnp`；仅监听 `127.0.0.1` 时必须通过隧道连接。                                                                                    |
| 连接超时或网络不可达             | 检查两台设备之间的路由、防火墙、VPN/隧道。Windows 可在连接前运行 `Test-NetConnection 192.168.1.50 -Port 2000`；Linux 可运行 `nc -vz 192.168.1.50 2000`。探测会短暂占用一个连接。 |
| 连接后立即断开                   | 查看 ser2net 日志；检查设备路径、服务用户权限、串口占用和 `max-connections`。                                                                                                    |
| 出现 `FF FB`、`FF FD` 或欢迎文字 | 检查是否误连 Telnet/RFC2217 端口，或启用了 banner。必须使用原始 `tcp` accepter。                                                                                                 |
| 能发但没有回应                   | 目标设备未必自动回显；检查协议、换行、串口参数、TX/RX/GND、电平和流控。可以按设备条件做 UART TX/RX 回环验证。                                                                    |
| 乱码或缺少某些字节               | 检查远端参数、文本编码及流控；HEX 模式可排除显示编码问题。确保未用 Telnet 终端作为原始二进制测试工具。                                                                           |
| USB 重插后失败                   | 优先用 `/dev/serial/by-id/...`，确认新设备权限，再重启 ser2net 并重新连接。                                                                                                      |
| 发送成功但设备没执行             | TCP 写入确认不能替代设备协议应答；按设备协议读取确认信息。                                                                                                                       |
| GUI 参数改了仍无效               | TCP 模式参数由 ser2net 管理；修改远端 connector 后重启服务。                                                                                                                     |
| 老版本只支持 `ser2net.conf`      | 优先升级到支持 YAML 的 4.x；不要把本教程 YAML 写入旧版冒号分隔配置文件。                                                                                                         |

## 开发验证

```bash
bun test tests/remote-serial.test.ts tests/serial-write.test.ts tests/serial-protocols.test.ts
bun run build
bun run test:ui:remote
```

测试使用本机 TCP 服务验证全部字节值、断线和多端点隔离；Electron 回归覆盖实际 IPC 收发、重复连接保护、配置恢复及工程导入导出。截图保存在 `.tmp/ui-smoke/remote-serial.png`。这些测试不代替实际 ser2net + UART 硬件验收。
