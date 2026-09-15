import './style.css'

export default function Manual(): React.JSX.Element {
  return (
    <>
      <header>
        <h1>编程参数手册</h1>
        <p>自动回复 JavaScript 编程模式 · SerialFlow</p>
      </header>
      <main>
        <nav>
          <a href="#structure">基本结构</a>
          <a href="#arguments">函数参数</a>
          <a href="#global">分组 global</a>
          <a href="#match">帧与位提取</a>
          <a href="#return">返回参数</a>
          <a href="#examples">完整示例</a>
          <a href="#data-window">数据窗口换算</a>
        </nav>

        <section id="data-window">
          <h2>数据窗口：AD 换算为 gf</h2>
          <p>
            数据窗口选择“编程模式”后使用 process(data)，与自动回复的 calculate 接口独立。data
            的键是模板字段名，值已应用有符号和 DEC 小数位设置；AD 标定一般将 DEC 小数位设为 0。
          </p>
          <pre>
            <code>{`function process(data) {
  const zero = 1000
  const calibrationAD = 5000
  const calibrationGf = 500
  return [{
    name: '压力',
    value: (data['数据'] - zero) * calibrationGf / (calibrationAD - zero),
    unit: 'gf',
    decimals: 2
  }]
}`}</code>
          </pre>
          <p>
            上述数值仅作示例，请替换为实际空载值及砝码标定值。返回 1～64 项数组，每项包含
            name、有限数值 value，可选 unit 和 decimals（0～20，默认 2）。支持同步 JavaScript /
            TypeScript、Math 和多个字段运算。高频数据只保留最新待处理值，不适合逐帧累计。运行在隔离
            Worker 中，限制执行时间和内存；不能访问串口或文件。超过安全整数范围的输入会报错。
          </p>
        </section>
        <section id="structure">
          <h2>1. 基本结构</h2>
          <p>
            每次接收内容命中规则后，SerialFlow 调用一次 <code>calculate</code>
            。函数必须返回一个对象，对象键对应发送指令中的占位符。
          </p>
          <pre>
            <code>
              {'function calculate(input, match, context) {\n  return {\n    参数名: 100\n  }\n}'}
            </code>
          </pre>
          <p>
            发送指令使用：<code>AA &#123;&#123;参数名&#125;&#125; BB</code>
          </p>
        </section>

        <section id="arguments">
          <h2>2. 函数参数</h2>
          <table>
            <thead>
              <tr>
                <th>参数</th>
                <th>内容</th>
                <th>常用操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>input</code>
                </td>
                <td>本次匹配到的 ASCII 或标准化 HEX 字符串</td>
                <td>
                  <code>input.slice(0, 2)</code>
                </td>
              </tr>
              <tr>
                <td>
                  <code>match</code>
                </td>
                <td>正则完整匹配及捕获组；未使用正则时通常为空数组</td>
                <td>
                  <code>match[1]</code>
                </td>
              </tr>
              <tr>
                <td>
                  <code>context</code>
                </td>
                <td>端口、命名捕获组、时间、参数等上下文</td>
                <td>
                  <code>context.port</code>、<code>context.groups.name</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="note">
            <code>input[1]</code>取得的是第 2 个字符，不是第 2 个 HEX 字节。
          </p>
        </section>

        <section id="global">
          <h2>3. 分组全局变量</h2>
          <p>
            <code>global</code>{' '}
            是所属自动回复分组的共享对象。同组规则可读写相同变量，不同分组互不影响。
          </p>
          <pre>
            <code>
              {'global.counter ??= 0\nglobal.speed ??= 100\n\nglobal.counter++\nglobal.speed = 200'}
            </code>
          </pre>
          <p>
            <code>??=</code> 只在变量为 <code>undefined</code> 或 <code>null</code>{' '}
            时赋初值，不会覆盖已有的 <code>0</code>、<code>false</code> 或空字符串。
          </p>
          <p>变量会随本地配置和工程文件保存。分组的“重置”按钮会清空该组全部变量。</p>
        </section>

        <section id="match">
          <h2>4. 提取 HEX 字节和位</h2>
          <pre>
            <code>
              {
                "const hex = input.replace(/\\s+/g, '')\nconst byte0 = parseInt(hex.slice(0, 2), 16)\nconst byte1 = parseInt(hex.slice(2, 4), 16)\n\n// byte1 最低位为第 0 位；这里提取第 3 位\nconst bit3 = (byte1 >> 3) & 1"
              }
            </code>
          </pre>
          <h3>使用正则捕获组</h3>
          <pre>
            <code>
              {'// 表达式示例：^AA ([0-9A-F]{2}) BB$\nconst value = parseInt(match[1], 16)'}
            </code>
          </pre>
        </section>

        <section id="return">
          <h2>5. 返回值与编码</h2>
          <p>返回值必须是普通对象，且键名应与发送模板中的占位符一致。</p>
          <pre>
            <code>
              {
                'return {\n  计数: global.counter,\n  速度: global.speed,\n  状态: global.enabled\n}'
              }
            </code>
          </pre>
          <ul>
            <li>ASCII 发送：数字、布尔值会转换为文本。</li>
            <li>
              HEX 发送：非负整数转换为偶数位 HEX，例如 <code>10 → 0A</code>。
            </li>
            <li>HEX 字符串按原始 HEX 文本使用，请确保内容由完整字节组成。</li>
          </ul>
        </section>

        <section id="examples">
          <h2>6. 完整示例</h2>
          <p>接收一帧 HEX 数据，提取第 2 个字节及其第 3 位，同时累计分组计数。</p>
          <pre>
            <code>
              {
                "/**\n * @param {string} input 匹配到的输入内容\n * @param {string[]} match 正则匹配结果\n * @param {object} context 串口上下文\n */\nfunction calculate(input, match, context) {\n  global.counter ??= 0\n  global.counter++\n\n  const hex = input.replace(/\\s+/g, '')\n  const byte1 = parseInt(hex.slice(2, 4), 16)\n\n  return {\n    计数: global.counter,\n    字节1: byte1,\n    位3: (byte1 >> 3) & 1,\n    端口: context.port\n  }\n}"
              }
            </code>
          </pre>
          <p>
            发送模板：
            <code>
              AA &#123;&#123;计数&#125;&#125; &#123;&#123;字节1&#125;&#125;
              &#123;&#123;位3&#125;&#125; BB
            </code>
          </p>
        </section>
      </main>
    </>
  )
}
