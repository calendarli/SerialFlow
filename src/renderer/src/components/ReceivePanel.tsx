import { ClearActionIcon } from './ClearActionIcon'
import { InteractionSettings } from './InteractionSettings'
import type { InteractionDisplay } from '../interaction-settings'
import { Clock3, Pause, ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { InteractionEntry } from '../types'
import { formatFirmwareTraffic } from '../firmware-traffic-display'

type SearchDirection = 'up' | 'down' | null
type ContextMenu = { x: number; y: number; entry: InteractionEntry | null }

type Props = {
  display: InteractionDisplay
  onDisplayChange: (value: InteractionDisplay) => void
  entries: InteractionEntry[]
  rxHex: boolean
  timestamp: boolean
  paused: boolean
  autoPauseEnabled: boolean
  autoPausePattern: string
  autoPauseRegex: boolean
  autoPauseHex: boolean
  cacheSizeMb: number
  cacheEntryLimit: number
  fontSize: number
  onClear: () => void
  onRxHexChange: (value: boolean) => void
  onTimestampChange: (value: boolean) => void
  onPausedChange: (value: boolean) => void
  onAutoPauseEnabledChange: (value: boolean) => void
  onAutoPausePatternChange: (value: string) => void
  onAutoPauseRegexChange: (value: boolean) => void
  onAutoPauseHexChange: (value: boolean) => void
  onCacheSizeChange: (value: number) => void
  onCacheEntryLimitChange: (value: number) => void
  onFontSizeChange: (value: number) => void
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const InteractionRow = memo(function InteractionRow({
  entry,
  text,
  matched,
  onContextMenu
}: {
  entry: InteractionEntry
  text: string
  matched: boolean
  onContextMenu: (event: React.MouseEvent, entry: InteractionEntry) => void
}): React.JSX.Element {
  return (
    <div
      data-interaction-id={entry.id}
      className={`interaction-entry ${entry.direction} ${matched ? 'search-match' : ''}`}
      onContextMenu={(event) => onContextMenu(event, entry)}
    >
      <div className="interaction-meta">
        <b>{entry.direction.toUpperCase()}</b>
        <em>{entry.port}</em>
        {entry.time && <time>{entry.time}</time>}
        <span>{entry.bytes} B</span>
      </div>
      <pre>{text || ' '}</pre>
    </div>
  )
})

export function ReceivePanel(props: Props): React.JSX.Element {
  const entryText = useCallback(
    (entry: InteractionEntry) =>
      entry.kind === 'firmware-wire' && entry.rawHex
        ? formatFirmwareTraffic(entry.rawHex, props.rxHex, props.display.encoding)
        : entry.text,
    [props.rxHex, props.display.encoding]
  )
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [autoPauseExpanded, setAutoPauseExpanded] = useState(
    () => localStorage.getItem('serialflow.autoPauseExpanded') !== 'false'
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [direction, setDirection] = useState<SearchDirection>(null)
  const [matchedEntryId, setMatchedEntryId] = useState<number | null>(null)
  const [searchMessage, setSearchMessage] = useState('')
  const followTailRef = useRef(true)
  // Keep callbacks stable during scroll/menu updates: a new getItemKey causes
  // the virtualizer to rebuild measurements for the entire retained history.
  const getItemKey = useCallback((index: number) => props.entries[index].id, [props.entries])
  const getScrollElement = useCallback(() => scrollElement, [scrollElement])
  const estimateSize = useCallback(
    (index: number) =>
      Math.max(
        20,
        Math.ceil((props.display[props.entries[index].direction].size ?? props.fontSize) * 1.55)
      ),
    [props.entries, props.display, props.fontSize]
  )
  const virtualizer = useVirtualizer({
    count: props.entries.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 14
  })
  const lastEntryId = props.entries[props.entries.length - 1]?.id

  useEffect(() => virtualizer.measure(), [props.fontSize, props.display, props.rxHex, virtualizer])

  useLayoutEffect(() => {
    if (!scrollElement || !props.entries.length || !followTailRef.current) return
    scrollElement.scrollTop = scrollElement.scrollHeight
  }, [lastEntryId, props.entries.length, scrollElement])

  useEffect(() => {
    const closeMenu = (): void => setMenu(null)
    const openWithShortcut = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        window.setTimeout(() => document.getElementById('interaction-search-input')?.focus(), 0)
      }
    }
    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('keydown', openWithShortcut)
    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('keydown', openWithShortcut)
    }
  }, [])

  const openContextMenu = useCallback(
    (event: React.MouseEvent, entry: InteractionEntry | null): void => {
      event.preventDefault()
      event.stopPropagation()
      setMenu({
        x: Math.min(event.clientX, window.innerWidth - 180),
        y: Math.min(event.clientY, window.innerHeight - 90),
        entry
      })
    },
    []
  )
  const copyEntry = async (entry: InteractionEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entryText(entry))
      setMenu(null)
    } catch {
      setSearchMessage('复制失败，请检查剪贴板权限')
      setMenu(null)
    }
  }
  const clearEntries = (): void => {
    props.onClear()
    setMatchedEntryId(null)
    setSearchMessage('')
    setMenu(null)
  }
  const closeSearch = (): void => {
    setSearchOpen(false)
    setMatchedEntryId(null)
    setSearchMessage('')
  }
  const findNext = (): void => {
    if (!query) return setSearchMessage('请输入搜索内容')
    let matcher: RegExp
    try {
      matcher = new RegExp(regex ? query : escapeRegExp(query), 'i')
    } catch (error) {
      return setSearchMessage(
        error instanceof Error ? `正则错误：${error.message}` : '正则表达式错误'
      )
    }
    const matches = props.entries
      .map((entry, index) => (matcher.test(entryText(entry)) ? index : -1))
      .filter((index) => index >= 0)
    if (!matches.length) {
      setMatchedEntryId(null)
      return setSearchMessage('未找到匹配内容')
    }
    const currentIndex =
      matchedEntryId === null ? -1 : props.entries.findIndex((entry) => entry.id === matchedEntryId)
    let next: number | undefined
    if (direction === 'up')
      next = [...matches]
        .reverse()
        .find((index) => index < (currentIndex < 0 ? props.entries.length : currentIndex))
    else if (direction === 'down') next = matches.find((index) => index > currentIndex)
    else next = matches.find((index) => index > currentIndex) ?? matches[0]
    if (next === undefined)
      return setSearchMessage(direction === 'up' ? '已到达顶部' : '已到达底部')
    const entry = props.entries[next]
    setMatchedEntryId(entry.id)
    setSearchMessage(`${matches.indexOf(next) + 1} / ${matches.length}`)
    virtualizer.scrollToIndex(next, { align: 'center' })
  }
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey) return
    event.preventDefault()
    props.onFontSizeChange(props.fontSize + (event.deltaY < 0 ? 1 : -1))
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && searchOpen) closeSearch()
  }
  let autoPausePatternValid = true
  if (props.autoPauseRegex && props.autoPausePattern) {
    try {
      new RegExp(props.autoPausePattern)
    } catch {
      autoPausePatternValid = false
    }
  } else if (props.autoPauseHex && props.autoPausePattern) {
    autoPausePatternValid = /^(?:[0-9a-f]{2}\s*)+$/i.test(props.autoPausePattern)
  }

  return (
    <div className="receiver card">
      <div className="card-head interaction-head">
        <div className="interaction-title">
          <strong>数据交互</strong>
          <button
            type="button"
            className="auto-pause-disclosure"
            aria-expanded={autoPauseExpanded}
            aria-controls="auto-pause-settings"
            title={`${autoPauseExpanded ? '收起' : '展开'}条件暂停设置${props.autoPauseEnabled ? '（条件暂停已启用）' : ''}`}
            onClick={() => {
              const next = !autoPauseExpanded
              setAutoPauseExpanded(next)
              localStorage.setItem('serialflow.autoPauseExpanded', String(next))
            }}
          >
            {autoPauseExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            条件暂停
            {props.autoPauseEnabled && <span className="auto-pause-enabled">已启用</span>}
          </button>
        </div>
        <div className="head-tools">
          <div className="receive-display-toggles" role="group" aria-label="接收显示选项">
            <InteractionSettings
              display={props.display}
              onDisplayChange={props.onDisplayChange}
              fontSize={props.fontSize}
              onFontSizeChange={props.onFontSizeChange}
              cacheSizeMb={props.cacheSizeMb}
              onCacheSizeChange={props.onCacheSizeChange}
              cacheEntryLimit={props.cacheEntryLimit}
              onCacheEntryLimitChange={props.onCacheEntryLimitChange}
            />
            <button
              type="button"
              className="receive-display-toggle receive-format-toggle"
              aria-pressed={props.rxHex}
              title={props.rxHex ? '当前为 Hex，点击切换为 ASCII' : '当前为 ASCII，点击切换为 Hex'}
              aria-label={props.rxHex ? '接收格式 Hex，切换为 ASCII' : '接收格式 ASCII，切换为 Hex'}
              onClick={() => props.onRxHexChange(!props.rxHex)}
            >
              {props.rxHex ? 'Hex' : 'ASCII'}
            </button>
            <button
              type="button"
              className="receive-display-toggle"
              aria-pressed={props.timestamp}
              title={props.timestamp ? '时间戳已启用，点击关闭' : '时间戳未启用，点击开启'}
              onClick={() => props.onTimestampChange(!props.timestamp)}
            >
              <Clock3 size={15} aria-hidden="true" />
              时间戳
            </button>
            <button
              type="button"
              className="receive-display-toggle"
              aria-pressed={props.paused}
              title={props.paused ? '接收显示已暂停，点击恢复显示' : '点击暂停接收显示'}
              onClick={() => props.onPausedChange(!props.paused)}
            >
              <Pause size={15} aria-hidden="true" />
              暂停接收
            </button>
            <button
              type="button"
              className="head-tool-button subtle clear-action-button"
              title="清空交互记录"
              aria-label="清空交互记录"
              onClick={clearEntries}
            >
              <ClearActionIcon />
            </button>
          </div>
        </div>
      </div>
      {autoPauseExpanded && (
        <div className="auto-pause-bar" id="auto-pause-settings">
          <label className="head-check">
            <input
              type="checkbox"
              checked={props.autoPauseEnabled}
              onChange={(event) => props.onAutoPauseEnabledChange(event.target.checked)}
            />
            条件暂停
          </label>
          <div className="mini-segment">
            <button
              className={!props.autoPauseHex ? 'active' : ''}
              onClick={() => props.onAutoPauseHexChange(false)}
            >
              ASCII
            </button>
            <button
              className={props.autoPauseHex ? 'active' : ''}
              onClick={() => props.onAutoPauseHexChange(true)}
            >
              HEX
            </button>
          </div>
          <input
            className={autoPausePatternValid ? '' : 'invalid'}
            disabled={!props.autoPauseEnabled}
            value={props.autoPausePattern}
            placeholder={props.autoPauseHex ? '例如：AA 01 BB' : '例如：STOP'}
            onChange={(event) => props.onAutoPausePatternChange(event.target.value)}
            title={autoPausePatternValid ? '匹配后自动暂停后续接收显示' : '条件格式无效'}
          />
          <label className="head-check">
            <input
              type="checkbox"
              disabled={!props.autoPauseEnabled}
              checked={props.autoPauseRegex}
              onChange={(event) => props.onAutoPauseRegexChange(event.target.checked)}
            />
            正则
            <span
              className="regex-help"
              tabIndex={0}
              aria-label="条件暂停正则使用说明"
              data-tooltip={
                props.autoPauseHex
                  ? '匹配标准化 HEX 字节文本，字节间用空格分隔。\n示例：^AA [0-9A-F]{2} BB$\n匹配后显示当前数据，并暂停后续 RX 显示。'
                  : '匹配接收到的 ASCII 文本，并兼容 CR/LF 行尾。\n示例：^STOP$ 或 ^TEMP=[0-9]+$\n匹配后暂停后续 RX 显示。'
              }
            >
              ?
            </span>
          </label>
          {!autoPausePatternValid && <span className="auto-pause-error">条件格式无效</span>}
        </div>
      )}
      {searchOpen && (
        <div
          className="interaction-search"
          onKeyDown={(event) => {
            if (event.key === 'Enter') findNext()
            else if (event.key === 'Escape') closeSearch()
          }}
        >
          <input
            id="interaction-search-input"
            value={query}
            placeholder={regex ? '输入正则表达式' : '搜索交互内容'}
            onChange={(event) => {
              setQuery(event.target.value)
              setMatchedEntryId(null)
              setSearchMessage('')
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={regex}
              onChange={(event) => {
                setRegex(event.target.checked)
                setMatchedEntryId(null)
                setSearchMessage('')
              }}
            />
            正则
            <span
              className="regex-help"
              tabIndex={0}
              aria-label="搜索正则使用说明"
              data-tooltip={
                '在全部缓存的交互内容中进行正则搜索。\n. 匹配任意字符；[0-9]+ 匹配连续数字；| 表示或。\n示例：AA .* BB 或 ERROR|WARN'
              }
            >
              ?
            </span>
          </label>
          <button
            title="向上搜索；再次点击取消方向"
            className={direction === 'up' ? 'active' : ''}
            onClick={() => setDirection(direction === 'up' ? null : 'up')}
          >
            ↑
          </button>
          <button
            title="向下搜索；再次点击取消方向"
            className={direction === 'down' ? 'active' : ''}
            onClick={() => setDirection(direction === 'down' ? null : 'down')}
          >
            ↓
          </button>
          <button className="find-button" onClick={findNext}>
            查找
          </button>
          <span>{searchMessage}</span>
          <button className="close-search" onClick={closeSearch}>
            ×
          </button>
        </div>
      )}
      <div
        className="terminal interaction-view"
        ref={setScrollElement}
        tabIndex={0}
        onWheel={handleWheel}
        onScroll={(event) => {
          const target = event.currentTarget
          followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32
        }}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => openContextMenu(event, null)}
        style={
          {
            '--interaction-font-size': `${props.fontSize}px`,
            '--interaction-rx-color': props.display.rx.color,
            '--interaction-tx-color': props.display.tx.color,
            '--interaction-rx-font': `"${props.display.rx.font}", monospace`,
            '--interaction-tx-font': `"${props.display.tx.font}", monospace`
          } as React.CSSProperties
        }
      >
        {props.entries.length ? (
          <div className="interaction-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = props.entries[item.index]
              return (
                <div
                  className="interaction-virtual-row"
                  key={item.key}
                  data-index={item.index}
                  style={{
                    transform: `translateY(${item.start}px)`,
                    height: item.size,
                    fontSize: props.display[entry.direction].size ?? props.fontSize
                  }}
                >
                  <InteractionRow
                    entry={entry}
                    text={entryText(entry)}
                    matched={matchedEntryId === entry.id}
                    onContextMenu={openContextMenu}
                  />
                </div>
              )
            })}
          </div>
        ) : (
          <span className="placeholder">等待串口数据交互…</span>
        )}
      </div>
      {menu && (
        <div
          className="context-menu interaction-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menu.entry && (
            <button onClick={() => void copyEntry(menu.entry!)}>
              复制当前
              {menu.entry.kind === 'firmware-wire'
                ? '烧录通讯'
                : menu.entry.direction === 'tx'
                  ? '发送指令/数据'
                  : '接收数据'}
            </button>
          )}
          {menu.entry && <div className="menu-separator" />}
          <button className="danger" onClick={clearEntries}>
            清空列表
          </button>
        </div>
      )}
    </div>
  )
}
