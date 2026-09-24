'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const helperPath = path.join(__dirname, 'helper.py').replace('app.asar/', 'app.asar.unpacked/')
let windowRef = null
let activeWatch = null

function validateTarget(target) {
  if (!target || target.kind === 'local') return { kind: 'local' }
  if (target.kind !== 'ssh') throw new Error('未知的连接类型')
  const host = String(target.host || '').trim()
  const user = String(target.user || '').trim()
  const password = String(target.password || '')
  const port = Number(target.port || 22)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/.test(host)) throw new Error('主机名或 SSH 别名无效')
  if (user && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user)) throw new Error('SSH 用户名无效')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口无效')
  return { kind: 'ssh', host, user, port, password }
}

function validName(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(value)) {
    throw new Error(label + ' 无效')
  }
  return value
}

function validPath(value) {
  if (value === '') return value
  if (typeof value !== 'string' || value.length > 500 || !/^\/(?:[a-zA-Z0-9_.-]+\/)+$/.test(value)) {
    throw new Error('路径无效')
  }
  return value
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function startHelper(target, action, args, onMessage, onExit) {
  const remote = target.kind === 'ssh'
  const command = remote ? 'ssh' : 'python3'
  let askpassDir = null
  let env = process.env
  if (remote && target.password) {
    askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsettings-explorer-'))
    const askpassPath = path.join(askpassDir, 'askpass.sh')
    fs.writeFileSync(askpassPath, '#!/bin/sh\nprintf \'%s\\n\' "$GSETTINGS_EXPLORER_SSH_PASSWORD"\n', { mode: 0o700 })
    env = Object.assign({}, process.env, {
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      GSETTINGS_EXPLORER_SSH_PASSWORD: target.password
    })
  }
  const sshAuth = target.password
    ? ['-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1']
    : ['-o', 'BatchMode=yes']
  const commandArgs = remote
    ? ['-T', ...sshAuth, '-o', 'ConnectTimeout=8', '-p', String(target.port),
      (target.user ? target.user + '@' : '') + target.host,
      ['python3', '-u', '-', action, ...args].map(shellQuote).join(' ')]
    : ['-u', helperPath, action, ...args]
  const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'], env })
  if (remote) child.stdin.end(fs.readFileSync(helperPath))
  else child.stdin.end()
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 32 * 1024 * 1024) {
      child.kill()
      onMessage({ type: 'error', message: '返回数据过大' })
      return
    }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      try { onMessage(JSON.parse(line)) } catch (_) { onMessage({ type: 'error', message: 'helper 返回了无效数据' }) }
    }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
  let finished = false
  const finish = reason => {
    if (!finished) {
      finished = true
      if (askpassDir) fs.rmSync(askpassDir, { recursive: true, force: true })
      onExit(reason)
    }
  }
  child.on('error', error => finish(error.message))
  child.on('close', code => finish(code === 0 ? null : (stderr.trim() || `进程退出，状态 ${code}`)))
  return child
}

function stopWatch() {
  if (activeWatch) {
    activeWatch.kill()
    activeWatch = null
  }
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1420, height: 880, minWidth: 980, minHeight: 650,
    title: 'GSettings Explorer', backgroundColor: '#f6f8fc',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  windowRef.loadFile(path.join(__dirname, 'index.html'))
  windowRef.on('closed', () => { stopWatch(); windowRef = null })
}

function trusted(event) {
  if (!windowRef || event.sender !== windowRef.webContents) throw new Error('无效的请求来源')
}

ipcMain.handle('snapshot', (event, input) => {
  trusted(event)
  const target = validateTarget(input)
  return new Promise((resolve, reject) => {
    let result = null
    let error = null
    const child = startHelper(target, 'snapshot', [], message => {
      if (message.type === 'snapshot') result = message
      if (message.type === 'error') error = message.message
    }, exitError => {
      clearTimeout(timer)
      if (error || exitError || !result) reject(new Error(error || exitError || '未收到配置数据'))
      else resolve(result)
    })
    const timer = setTimeout(() => child.kill(), 60000)
  })
})

ipcMain.handle('read-key', (event, input) => {
  trusted(event)
  const target = validateTarget(input.target)
  const schema = validName(input.schema, 'schema')
  const key = validName(input.key, 'key')
  const settingPath = validPath(input.path || '')
  return new Promise((resolve, reject) => {
    let result = null
    let error = null
    const child = startHelper(target, 'key', [schema, key, settingPath], message => {
      if (message.type === 'key') result = message
      if (message.type === 'error') error = message.message
    }, exitError => {
      clearTimeout(timer)
      if (error || exitError || !result) reject(new Error(error || exitError || '未收到配置值'))
      else resolve(result)
    })
    const timer = setTimeout(() => child.kill(), 15000)
  })
})

ipcMain.handle('watch-start', (event, input) => {
  trusted(event)
  const target = validateTarget(input.target)
  const schema = validName(input.schema, 'schema')
  const key = validName(input.key, 'key')
  const settingPath = validPath(input.path || '')
  stopWatch()
  const child = startHelper(target, 'watch', [schema, key, settingPath], message => {
    if (activeWatch !== child) return
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('watch-event', message)
  }, exitError => {
    if (activeWatch !== child) return
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.send('watch-event', { type: 'stopped', message: exitError || '监听已结束' })
    }
    activeWatch = null
  })
  activeWatch = child
  return true
})

ipcMain.handle('watch-stop', event => { trusted(event); stopWatch(); return true })

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { stopWatch(); if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!windowRef) createWindow() })
