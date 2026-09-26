import { useEffect, useRef, useState, type ReactNode } from 'react'
import { sidebarPageMinimumWidth } from '../sidebar-layout'
import {
  Cable,
  Network,
  SquareTerminal,
  MessagesSquare,
  Cpu,
  CircleHelp,
  PanelLeftOpen,
  PanelLeftClose,
  Info
} from 'lucide-react'

type Tab = 'serial' | 'pairs' | 'commands' | 'rules' | 'modbus' | 'about'
type Props = {
  modbusCollapsed: boolean
  onModbusCollapsedChange: (collapsed: boolean) => void
  activeTab: Tab
  commandCount: number
  enabledRuleCount: number
  onTabChange: (tab: Tab) => void
  serialContent: ReactNode
  pairsContent: ReactNode
  commandsContent: ReactNode
  rulesContent: ReactNode
  aboutContent: ReactNode
}
const storageKey = 'serialflow.sidebarWidth'
const collapsedStorageKey = 'serialflow.sidebarCollapsed'
const tabRailWidth = 52
const tabPageWidth = sidebarPageMinimumWidth
const defaultWidth = tabRailWidth + tabPageWidth + 1 // Include the sidebar's right border.

function clampWidth(value: number): number {
  return Math.max(Number.isFinite(value) ? value : defaultWidth, defaultWidth)
}

function initialWidth(): number {
  const saved = Number(localStorage.getItem(storageKey))
  return clampWidth(Number.isFinite(saved) && saved > 0 ? saved : defaultWidth)
}

export function Sidebar(props: Props): React.JSX.Element {
  const fullPage = props.activeTab === 'modbus'
  const [width, setWidth] = useState(initialWidth)
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(collapsedStorageKey) === 'true'
  )
  const [resizing, setResizing] = useState(false)
  const dragStart = useRef({ x: 0, width: defaultWidth })
  const widthRef = useRef(width)
  const collapsedRef = useRef(collapsed)
  const activeCollapsed = props.activeTab === 'modbus' ? props.modbusCollapsed : collapsed

  useEffect(() => {
    const handleResize = (): void =>
      setWidth((current) => {
        const nextWidth = clampWidth(current)
        widthRef.current = nextWidth
        return nextWidth
      })
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startWidth = collapsed ? tabRailWidth : width
    dragStart.current = { x: event.clientX, width: startWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const requestedWidth = dragStart.current.width + event.clientX - dragStart.current.x
    const nextCollapsed = requestedWidth <= tabRailWidth
    // Keep the last expanded width when dragging shut; never render a clipped page.
    if (!nextCollapsed) {
      const nextWidth = clampWidth(requestedWidth)
      widthRef.current = nextWidth
      setWidth(nextWidth)
    }
    collapsedRef.current = nextCollapsed
    setCollapsed(nextCollapsed)
  }
  const finishResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem(storageKey, String(widthRef.current))
    localStorage.setItem(collapsedStorageKey, String(collapsedRef.current))
    setResizing(false)
  }
  const resetWidth = (): void => {
    setWidth(defaultWidth)
    widthRef.current = defaultWidth
    collapsedRef.current = false
    setCollapsed(false)
    localStorage.setItem(storageKey, String(defaultWidth))
    localStorage.setItem(collapsedStorageKey, 'false')
  }
  const toggleCollapsed = (): void => {
    const next = !collapsedRef.current
    collapsedRef.current = next
    setCollapsed(next)
    localStorage.setItem(storageKey, String(widthRef.current))
    localStorage.setItem(collapsedStorageKey, String(next))
  }

  return (
    <aside
      className={`config-panel resizable-sidebar ${fullPage ? 'full-page-tab-only' : ''} ${collapsed ? 'collapsed' : ''} ${resizing ? 'resizing' : ''}`}
      style={{ width: fullPage || collapsed ? tabRailWidth : width }}
    >
      <nav className="side-tabs" aria-label="侧栏导航">
        <button
          aria-label="串口"
          data-tooltip="串口"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'serial' ? 'page' : undefined}
          className={props.activeTab === 'serial' ? 'active' : ''}
          onClick={() => props.onTabChange('serial')}
        >
          <Cable
            className="tab-icon tab-icon-serial"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        <button
          aria-label="快捷指令"
          data-tooltip="快捷指令"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'commands' ? 'page' : undefined}
          className={props.activeTab === 'commands' ? 'active' : ''}
          onClick={() => props.onTabChange('commands')}
        >
          <SquareTerminal
            className="tab-icon tab-icon-commands"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {props.commandCount > 0 && (
            <b aria-hidden="true">{props.commandCount > 99 ? '99+' : props.commandCount}</b>
          )}
        </button>
        <button
          aria-label="自动回复"
          data-tooltip="自动回复"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'rules' ? 'page' : undefined}
          className={props.activeTab === 'rules' ? 'active' : ''}
          onClick={() => props.onTabChange('rules')}
        >
          <MessagesSquare
            className="tab-icon tab-icon-rules"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {props.enabledRuleCount > 0 && (
            <b aria-hidden="true">{props.enabledRuleCount > 99 ? '99+' : props.enabledRuleCount}</b>
          )}
        </button>
        <button
          aria-label="虚拟串口对"
          data-tooltip="虚拟串口对"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'pairs' ? 'page' : undefined}
          className={props.activeTab === 'pairs' ? 'active' : ''}
          onClick={() => props.onTabChange('pairs')}
        >
          <Network
            className="tab-icon tab-icon-pairs"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        <button
          aria-label="Modbus RTU"
          data-tooltip="Modbus RTU"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'modbus' ? 'page' : undefined}
          className={props.activeTab === 'modbus' ? 'active' : ''}
          onClick={() => props.onTabChange('modbus')}
        >
          <Cpu
            className="tab-icon tab-icon-modbus"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        <button
          aria-label="帮助"
          data-tooltip="帮助"
          data-tooltip-side="right"
          className="help-tab"
          onClick={() =>
            window.open(
              new URL('help/index.html', window.location.href).toString(),
              'serialflow-help'
            )
          }
        >
          <CircleHelp
            className="tab-icon tab-icon-help"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        {(!fullPage || props.activeTab === 'modbus') && (
          <button
            className="sidebar-collapse-tab"
            data-tooltip={activeCollapsed ? '展开侧栏' : '收起侧栏'}
            data-tooltip-side="right"
            aria-label={activeCollapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!activeCollapsed}
            onClick={() =>
              props.activeTab === 'modbus'
                ? props.onModbusCollapsedChange(!activeCollapsed)
                : toggleCollapsed()
            }
          >
            {activeCollapsed ? (
              <PanelLeftOpen
                className="tab-icon tab-icon-utility"
                size={22}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ) : (
              <PanelLeftClose
                className="tab-icon tab-icon-utility"
                size={22}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            )}
          </button>
        )}
        <button
          aria-label="关于"
          data-tooltip="关于"
          data-tooltip-side="right"
          aria-current={props.activeTab === 'about' ? 'page' : undefined}
          className={`about-tab ${props.activeTab === 'about' ? 'active' : ''}`}
          onClick={() => props.onTabChange('about')}
        >
          <Info
            className="tab-icon tab-icon-about"
            size={22}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
      </nav>
      {!fullPage && (
        <>
          {!collapsed && (
            <div className="side-page">
              {props.activeTab === 'serial'
                ? props.serialContent
                : props.activeTab === 'pairs'
                  ? props.pairsContent
                  : props.activeTab === 'commands'
                    ? props.commandsContent
                    : props.activeTab === 'rules'
                      ? props.rulesContent
                      : props.aboutContent}
            </div>
          )}
          <div
            className="sidebar-resizer"
            title="拖拽调整宽度，双击恢复默认"
            onPointerDown={beginResize}
            onPointerMove={resize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onDoubleClick={resetWidth}
          />
        </>
      )}
    </aside>
  )
}
