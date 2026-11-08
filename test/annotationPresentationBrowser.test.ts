import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { loadDeck, saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { electronChildEnv } from '../src/cli/electronDisplay.js';
import { Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser } from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

let work = '';
let child: ChildProcess | null = null;
let server: RunningCollabServer | null = null;
const connections: Cdp[] = [];
afterEach(async () => {
  connections.splice(0).forEach((connection) => connection.close());
  await stopBrowser(child); child = null;
  await server?.close(); server = null;
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 5 });
});

/** Real pen input through Chromium, both persistence transports, then a real PDF. */
describe.skipIf(!electronBinary)('saved presentation annotations', () => {
  for (const backend of ['desktop', 'browser'] as const) it(`${backend}: saves stylus ink and keeps the laser out of the PDF`, async () => {
    work = await mkdtemp(join(tmpdir(), 'deckwerk-annotation-test-'));
    const decksRoot = join(work, 'decks');
    const deckDir = join(decksRoot, 'talk');
    await mkdir(deckDir, { recursive: true });
    const deck = emptyDeck('Ink test');
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'second-slide' });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }');
    const clientDir = await collabClientDir();
    let audience: Cdp;
    let editor: Cdp | null = null;
    if (backend === 'desktop') {
      const appDir = join(work, 'app');
      await materializeDesktopApp(appDir, 'deckwerk-annotation-test');
      const app = await launchDesktopApp(appDir, [deckDir], { profileDir: join(work, 'profile'), cwd: appDir });
      child = app.process;
      const target = await findTarget(app.debugPort, isEditorTarget, app.log);
      editor = await Cdp.connect(target.webSocketDebuggerUrl!); connections.push(editor);
      await eventually(() => editor!.evaluate<boolean>(`document.querySelectorAll('.rail-item').length === 2`), 'editor did not load');
      await editor.clickByText('button', 'Present', 'Present');
      const present = await findTarget(app.debugPort, (t) => t.url.includes('/present/index.html'), app.log);
      audience = await Cdp.connect(present.webSocketDebuggerUrl!);
    } else {
      server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
      const url = `http://127.0.0.1:${server.port}/present.html?deck=talk&name=Annotator`;
      const browser = await launchBrowser(url, join(work, 'profile'));
      child = browser.process;
      const target = await findTarget(browser.debugPort, (t) => t.url.includes('present.html'), browser.log);
      audience = await Cdp.connect(target.webSocketDebuggerUrl!);
    }
    connections.push(audience);
    await eventually(() => audience.evaluate<boolean>(`!!document.querySelector('.annotation-toolbar')`), 'tools did not mount');
    const rect = await audience.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
      const r = document.querySelector('.stage').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const points = [0.2, 0.35, 0.5, 0.65].map((t) => ({ x: rect.x + rect.width * t, y: rect.y + rect.height * (t < 0.4 ? 0.3 : 0.5) }));
    await audience.click('[data-annotation-mode="pen"]');
    // A real held stylus, followed by a held finger: neither may save ink or
    // advance the slide, and releasing each restores the selected Pen tool.
    for (const input of ['pen', 'touch']) {
      if (input === 'pen') await audience.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...points[0], button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1,
      });
      else await audience.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
      await eventually(() => audience.evaluate<boolean>(`!document.querySelector('.presentation-laser').hidden`), 'long press did not activate the laser');
      if (input === 'pen') {
        await audience.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points[2], button: 'left', buttons: 1, pointerType: 'pen' });
        await audience.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points[2], button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1 });
      } else {
        await audience.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [points[2]] });
        await audience.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      expect(await audience.evaluate<boolean>(`document.querySelector('.presentation-laser').hidden`)).toBe(true);
      expect(await audience.evaluate<string>(`document.querySelector('.stage .slide').dataset.slideId`)).toBe(deck.slides[0].id);
      expect(await audience.evaluate<string>(`document.querySelector('[data-annotation-mode="pen"]').getAttribute('aria-pressed')`)).toBe('true');
      expect((await loadDeck(deckDir)).slides[0].elements).toHaveLength(0);
    }
    // Drawing resumes immediately after lifting, without choosing a tool.
    for (let i = 0; i < points.length; i++) await audience.call('Input.dispatchMouseEvent', {
      type: i ? 'mouseMoved' : 'mousePressed', ...points[i], button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1,
    });
    await audience.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...points.at(-1)!, button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1,
    });
    await eventually(async () => (await loadDeck(deckDir)).slides[0].elements.length, 'annotation was not saved', (count) => count === 1);
    const saved = await loadDeck(deckDir);
    expect(saved.slides[0].elements[0]).toMatchObject({ type: 'shape', shape: 'path', stroke: '#e53935' });
    expect(saved.slides[1].elements).toHaveLength(0);
    await audience.click('[data-annotation-mode="laser"]');
    await audience.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points[1], button: 'none', buttons: 0 });
    await audience.clickAt(points[1].x, points[1].y);
    expect(await audience.evaluate<boolean>(`!document.querySelector('.presentation-laser').hidden`)).toBe(true);
    expect(await audience.evaluate<string>(`document.querySelector('.stage .slide').dataset.slideId`)).toBe(deck.slides[0].id);
    const capture = await audience.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(tmpdir(), `deckwerk-annotations-${backend}.png`), Buffer.from(capture.data, 'base64'));
    await audience.key('v', 86); // Put laser down, keep the presentation.
    expect(await audience.evaluate<boolean>(`document.querySelector('[data-annotation-mode="navigate"]').getAttribute('aria-pressed') === 'true'`)).toBe(true);
    if (editor) {
      // Saved presentation ink is a normal undo unit in the owning editor.
      await editor.key('Escape', 27);
      await editor.chord('z', 'KeyZ', 90, process.platform === 'darwin' ? 4 : 2);
      await eventually(() => editor!.evaluate<number>(`document.querySelectorAll('.slide-layer [data-element-id^="ink"]').length`), 'annotation did not undo', (count) => count === 0);
      await editor.chord('z', 'KeyZ', 90, (process.platform === 'darwin' ? 4 : 2) | 8);
      await eventually(async () => (await loadDeck(deckDir)).slides[0].elements.length, 'redo did not save ink', (count) => count === 1);
    }
    // Print the persisted deck through the shared PDF page renderer.
    if (!server) server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    const pdfPath = join(work, 'annotated.pdf');
    const script = join(work, 'print.cjs');
    const preload = join(work, 'print-preload.cjs');
    await writeFile(preload, 'window.print = () => {};');
    await writeFile(script, `const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      app.whenReady().then(async () => {
        const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: false, preload: ${JSON.stringify(preload)} } });
        await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.port}/print.html?deck=talk`)});
        for (let i = 0; i < 300; i++) {
          if (await w.webContents.executeJavaScript('document.documentElement.dataset.ready === "true"')) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const count = await w.webContents.executeJavaScript('document.querySelectorAll("[data-element-id^=ink] svg path").length');
        if (!count) throw Error('Print page lost ink');
        fs.writeFileSync(${JSON.stringify(pdfPath)}, await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }));
        app.quit();
      }).catch(e => { console.error(e); app.exit(1); });`);
    await new Promise<void>((resolve, reject) => {
      const printer = spawn(electronBinary, [script, `--user-data-dir=${join(work, 'print-profile')}`], { env: electronChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      printer.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => { printer.kill(); reject(new Error(`PDF print timed out: ${stderr}`)); }, 30_000);
      printer.on('error', reject);
      printer.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
    });
    const bytes = await readFile(pdfPath);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await loadDeck(deckDir)).slides[0].elements).toHaveLength(1);
    await writeFile(join(tmpdir(), `deckwerk-annotations-${backend}.pdf`), bytes);
  }, 180_000);
});
