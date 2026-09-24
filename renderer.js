'use strict'

const $ = id => document.getElementById(id)
const state = { items: [], schemas: [], selectedSchema: null, selectedItem: null, target: { kind: 'local' }, watchItem: null, loading: false }

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function currentTarget() {
  if (document.querySelector('input[name="mode"]:checked').value === 'local') return { kind: 'local' }
  return { kind: 'ssh', host: $('host').value.trim(), user: $('user').value.trim(), port: Number($('port').value), password: $('password').value }
}

function setError(message) {
  $('error-banner').textContent = message || ''
  $('error-banner').classList.toggle('hidden', !message)
}

function setMonitorState(value, className) {
  $('monitor-state').textContent = value
  $('monitor-state').className = 'state ' + className
}

function renderSchemas() {
  const container = $('schema-list')
  container.replaceChildren()
  const entries = [['全部 schema', null, state.items.length], ...state.schemas]
  const fragment = document.createDocumentFragment()
  for (const [name, id, count] of entries) {
    const row = element('button', 'schema-row' + (state.selectedSchema === id ? ' active' : ''))
    row.type = 'button'
    row.append(element('span', '', name), element('small', '', String(count)))
    row.title = name
    row.addEventListener('click', () => { state.selectedSchema = id; renderSchemas(); renderItems() })
    fragment.append(row)
  }
  container.append(fragment)
  $('schema-count').textContent = String(state.schemas.length)
}

function filteredItems() {
  const query = $('search').value.trim().toLocaleLowerCase()
  return state.items.filter(item => {
    if (state.selectedSchema && item.schema !== state.selectedSchema) return false
    if (!query) return true
    return [item.schema, item.key, item.value, item.default, item.summary, item.description, item.path]
      .some(value => String(value || '').toLocaleLowerCase().includes(query))
  })
}

function renderItems() {
  const items = filteredItems()
  $('catalog-title').textContent = state.selectedSchema || '所有配置'
  $('catalog-subtitle').textContent = state.selectedSchema ? '当前 schema 下的配置项' : '浏览所有固定路径和可重定位 schema'
  $('result-count').textContent = `${items.length} / ${state.items.length} 项`
  const container = $('settings-list')
  const scrollTop = container.scrollTop
  container.replaceChildren()
  if (!items.length) {
    const empty = element('div', 'empty-state')
    empty.append(element('strong', '', state.items.length ? '没有匹配的配置' : '准备浏览配置'),
      element('p', '', state.items.length ? '试试其他关键词或 schema。' : '点击左侧“加载配置”开始。'))
    container.append(empty)
    return
  }
  const rowHeight = 64
  const virtualize = items.length > 100
  const start = virtualize ? Math.max(0, Math.floor(scrollTop / rowHeight) - 6) : 0
  const end = virtualize ? Math.min(items.length, Math.ceil((scrollTop + (container.clientHeight || 600)) / rowHeight) + 6) : items.length
  if (start) {
    const spacer = element('div', 'virtual-spacer')
    spacer.style.height = `${start * rowHeight}px`
    container.append(spacer)
  }
  const fragment = document.createDocumentFragment()
  for (const item of items.slice(start, end)) {
    const row = element('button', 'setting-row' + (state.selectedItem === item ? ' selected' : ''))
    row.type = 'button'
    const name = element('span', 'setting-name')
    name.append(element('strong', '', item.key || 'schema 错误'), element('small', '', item.schema))
    row.append(name, element('span', 'value-preview', item.error || item.value || (item.path === null ? '需要实例路径' : '')))
    row.addEventListener('click', () => { state.selectedItem = item; renderItems(); renderDetail() })
    fragment.append(row)
  }
  container.append(fragment)
  if (end < items.length) {
    const spacer = element('div', 'virtual-spacer')
    spacer.style.height = `${(items.length - end) * rowHeight}px`
    container.append(spacer)
  }
  container.scrollTop = scrollTop
}

function field(grid, label, value, className) {
  grid.append(element('dt', '', label), element('dd', className || '', value === null || value === undefined ? '—' : String(value)))
}

function renderDetail() {
  const container = $('detail-content')
  container.replaceChildren()
  const item = state.selectedItem
  if (!item) { container.append(element('div', 'detail-placeholder', '选择左侧列表中的键')); return }
  if (item.error) { container.append(element('div', 'detail-placeholder', item.error)); return }
  container.append(element('div', 'detail-title', item.schema + ' / ' + item.key))
  const grid = element('dl', 'meta-grid')
  field(grid, '类型', item.type)
  field(grid, '默认值', item.default, 'code-value')
  if (item.path === null) {
    grid.append(element('dt', '', '实例路径'))
    const dd = element('dd', 'path-entry')
    const input = element('input')
    input.id = 'instance-path'; input.placeholder = '/org/example/instance/'; input.value = item.instancePath || ''
    input.addEventListener('input', () => { item.instancePath = input.value.trim() })
    const readButton = element('button', 'secondary', '读取')
    readButton.type = 'button'
    readButton.addEventListener('click', () => readKey(item))
    dd.append(input, readButton); grid.append(dd)
  } else {
    field(grid, '路径', item.path)
  }
  field(grid, '当前值', item.value === null ? '填写实例路径后可监听此键' : item.value, 'code-value')
  field(grid, '用户已设置', item.userValue === null ? '需要实例路径' : (item.userValue ? '是' : '否'))
  field(grid, '可写', item.writable === null ? '需要实例路径' : (item.writable ? '是' : '否'))
  if (item.summary) field(grid, '摘要', item.summary)
  if (item.description) field(grid, '说明', item.description)
  container.append(grid)
  const actions = element('div', 'detail-actions')
  const button = element('button', 'secondary', state.watchItem === item ? '停止监听' : '监听此键')
  button.addEventListener('click', () => state.watchItem === item ? stopWatch() : startWatch(item))
  actions.append(button, element('span', 'detail-note', '监听开始前的历史变化无法恢复'))
  container.append(actions)
}

async function loadSnapshot() {
  if (state.loading) return
  state.loading = true
  $('connect').disabled = true
  $('connect').textContent = '正在加载…'
  setError('')
  await stopWatch()
  try {
    const target = currentTarget()
    const result = await window.gsettingsApi.snapshot(target)
    state.target = target
    state.items = result.items
    state.selectedSchema = null
    state.selectedItem = null
    const count = new Map()
    for (const item of result.items) count.set(item.schema, (count.get(item.schema) || 0) + 1)
    state.schemas = [...count].sort((a, b) => a[0].localeCompare(b[0])).map(([id, total]) => [id, id, total])
    $('connection-status').textContent = `${state.schemas.length} 个 schema · ${state.items.length} 项 · ${formatTime(result.capturedAt)}`
    $('host-badge').textContent = target.kind === 'local' ? '● 本机' : `● ${target.user ? target.user + '@' : ''}${target.host}`
    renderSchemas(); renderItems(); renderDetail()
  } catch (error) {
    setError(error.message || String(error))
    $('connection-status').textContent = '加载失败'
  } finally {
    state.loading = false
    $('connect').disabled = false
    $('connect').textContent = '加载配置'
  }
}

async function startWatch(item) {
  setError('')
  try {
    const instancePath = item.path === null ? (item.instancePath || '') : item.path
    if (item.path === null && !/^\/(?:[a-zA-Z0-9_.-]+\/)+$/.test(instancePath)) {
      throw new Error('请填写有效的实例路径，例如 /org/example/instance/')
    }
    state.watchItem = item
    $('monitor-target').textContent = `${item.schema} / ${item.key}${item.path === null ? ' · ' + instancePath : ''}`
    $('monitor-log').replaceChildren(element('div', 'log-placeholder', '监听已启动，等待变化…'))
    setMonitorState('连接中', 'idle')
    renderDetail()
    await window.gsettingsApi.startWatch({ target: state.target, schema: item.schema, key: item.key, path: instancePath })
  } catch (error) { state.watchItem = null; renderDetail(); setError(error.message || String(error)) }
}

async function readKey(item) {
  setError('')
  try {
    const result = await window.gsettingsApi.readKey({
      target: state.target, schema: item.schema, key: item.key,
      path: item.instancePath || ''
    })
    item.value = result.value
    item.writable = result.writable
    item.userValue = result.userValue
    renderItems(); renderDetail()
  } catch (error) { setError(error.message || String(error)) }
}

async function stopWatch() {
  if (state.watchItem) await window.gsettingsApi.stopWatch()
  state.watchItem = null
  setMonitorState('未监听', 'idle')
  renderDetail()
}

function appendChange(event) {
  const log = $('monitor-log')
  if (log.querySelector('.log-placeholder')) log.replaceChildren()
  const row = element('div', 'log-event')
  const top = element('div', 'log-top')
  top.append(element('strong', '', '检测到配置变化'), element('time', '', formatTime(event.observedAt)))
  row.append(top)
  for (const [label, value] of [['修改前', event.oldValue], ['修改后', event.newValue]]) {
    const line = element('div', 'change-line')
    line.append(element('span', '', label), element('code', '', value))
    row.append(line)
  }
  row.append(element('div', 'modifier', `修改者：${event.modifier}（${event.modifierConfidence}）`))
  row.append(element('div', 'modifier', `前值观测：${formatTime(event.previousObservedAt)} · 新值观测：${formatTime(event.observedAt)}`))
  log.prepend(row)
  while (log.children.length > 100) log.lastChild.remove()
}

window.gsettingsApi.onWatchEvent(event => {
  if (event.type === 'ready') {
    setMonitorState('监听中', 'live')
    $('monitor-target').textContent += ` · 初值 ${event.value}`
    if (state.watchItem) { state.watchItem.value = event.value; renderItems(); renderDetail() }
  } else if (event.type === 'change') {
    appendChange(event)
    if (state.watchItem) { state.watchItem.value = event.newValue; renderItems(); renderDetail() }
  } else if (event.type === 'error' || event.type === 'stopped') {
    setMonitorState('已停止', 'error')
    setError(event.message)
    state.watchItem = null
    renderDetail()
  }
})

document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => {
  $('ssh-fields').classList.toggle('hidden', document.querySelector('input[name="mode"]:checked').value === 'local')
}))
$('connect').addEventListener('click', loadSnapshot)
$('search').addEventListener('input', () => { $('settings-list').scrollTop = 0; renderItems() })
$('settings-list').addEventListener('scroll', () => {
  if (state.items.length <= 100 || state.listRenderQueued) return
  state.listRenderQueued = true
  requestAnimationFrame(() => { state.listRenderQueued = false; renderItems() })
})
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); $('search').focus()
  }
})
