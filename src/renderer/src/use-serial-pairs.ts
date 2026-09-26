import { useCallback, useEffect, useRef, useState } from 'react'

type Status = {
  installed: boolean
  pairs: string[]
  occupiedPorts: string[]
  availablePorts: string[]
  commandPath?: string
  certificateAvailable: boolean
  certificateInstalled: boolean
  message?: string
}

export type SerialPairsModel = {
  first: string
  setFirst: (value: string) => void
  second: string
  setSecond: (value: string) => void
  status: Status | null
  busy: boolean
  message: string
  refresh: () => Promise<void>
  createPair: () => Promise<void>
  installCertificate: () => Promise<void>
  removePair: (pair: string) => Promise<void>
}

export function useSerialPairs(active: boolean): SerialPairsModel {
  const [first, setFirst] = useState('COM10')
  const [second, setSecond] = useState('COM11')
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const operationRunning = useRef(false)
  const [message, setMessage] = useState('正在检测 SerialFlow 虚拟串口驱动…')

  const loadStatus = useCallback(async (): Promise<void> => {
    const next = await window.api.getVirtualPortStatus()
    setStatus(next)
    setFirst(next.availablePorts[0] || '')
    setSecond(next.availablePorts[1] || '')
    setMessage(
      next.installed ? next.message || 'SerialFlow 驱动包已就绪' : '未检测到 SerialFlow 驱动包'
    )
  }, [])

  const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (operationRunning.current) return
    operationRunning.current = true
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      operationRunning.current = false
      setBusy(false)
    }
  }, [])

  const refresh = useCallback(() => run(loadStatus), [run, loadStatus])

  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [active, refresh])

  const createPair = async (): Promise<void> => {
    await run(async () => {
      const result = await window.api.createVirtualPortPair(first, second)
      await loadStatus()
      setMessage(`已创建 ${result.first} ↔ ${result.second}`)
    })
  }

  const installCertificate = async (): Promise<void> => {
    await run(async () => {
      const result = await window.api.installVirtualPortCertificate()
      await loadStatus()
      setMessage(result)
    })
  }

  const removePair = async (pair: string): Promise<void> => {
    const [a, b] = pair.split(' ↔ ')
    if (!/^COM\d+$/.test(a) || !/^COM\d+$/.test(b ?? '')) return
    await run(async () => {
      await window.api.removeVirtualPortPair(a, b)
      await loadStatus()
      setMessage(`已删除 ${pair}`)
    })
  }

  return {
    first,
    setFirst,
    second,
    setSecond,
    status,
    busy,
    message,
    refresh,
    createPair,
    installCertificate,
    removePair
  }
}
