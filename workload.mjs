export const scenarios = ['traffic', 'logs', 'connections']
export const layers = ['page', 'component', 'dom']
export function workload(scenario, layer, profile = 'steady') {
  if (
    !scenarios.includes(scenario) ||
    !layers.includes(layer) ||
    !['steady', 'burst'].includes(profile) ||
    (scenario === 'traffic' && (layer !== 'component' || profile !== 'steady'))
  )
    throw new Error('Unsupported scenario/layer/profile')
  return {
    scenario,
    layer,
    profile,
    layout:
      scenario === 'connections'
        ? layer === 'page'
          ? 'table'
          : layer === 'component'
            ? 'list'
            : 'rows'
        : null,
    replayMs: scenario === 'traffic' ? 200 : scenario === 'logs' ? 100 : 1000,
    transport:
      scenario === 'traffic'
        ? 'loopback-append'
        : layer === 'page'
          ? 'loopback-js-adapter (no native plugin IPC)'
          : 'loopback-fixture',
    rows: scenario === 'logs' ? 1000 : scenario === 'connections' ? 100 : 0,
  }
}
export function fixture(scenario, sequence, profile = 'steady') {
  if (scenario === 'logs') {
    const count = profile === 'burst' && sequence % 10 === 0 ? 200 : 1
    return Array.from({ length: count }, (_, i) => ({
      type: 'info',
      time: '11-13 12:00:00',
      payload: `[TCP] frame-${sequence}-${i} 127.0.0.1:42000 --> fixture-${sequence}-${i}.invalid:443 match DomainSuffix using DIRECT`,
    }))
  }
  const count = profile === 'burst' && sequence % 10 === 0 ? 300 : 100
  return {
    uploadTotal: sequence * 100000,
    downloadTotal: sequence * 500000,
    connections: Array.from({ length: count }, (_, i) => ({
      id: `connection-${Math.floor(sequence / 10)}-${i}`,
      metadata: {
        network: 'tcp',
        type: 'HTTP',
        host: `frame-${sequence}-${i}.invalid`,
        sourceIP: '127.0.0.1',
        sourcePort: String(42000 + i),
        destinationIP: '192.0.2.1',
        destinationPort: '443',
        remoteDestination: '',
        process: 'fixture',
        processPath: '/fixture',
      },
      upload: sequence * 1024 + i,
      download: sequence * 4096 + i,
      curUpload: 1024,
      curDownload: 4096,
      start: '2026-11-13T04:00:00Z',
      chains: ['DIRECT'],
      rule: 'Match',
      rulePayload: '',
    })),
  }
}
