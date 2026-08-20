import { app, BrowserWindow } from 'electron';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';

export type UpdateChannel = 'stable' | 'preview';
export type UpdatePhase = 'unconfigured' | 'ready' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error' | 'development' | 'unsupported';

export interface UpdateSettings {
  feedUrl: string;
  channel: UpdateChannel;
}

export interface UpdateState {
  phase: UpdatePhase;
  message: string;
  currentVersion: string;
  channel: UpdateChannel;
  feedUrl: string;
  availableVersion?: string;
  releaseNotes?: string;
  progress?: number;
}

const DEFAULT_SETTINGS: UpdateSettings = { feedUrl: '', channel: 'stable' };
let settings: UpdateSettings = { ...DEFAULT_SETTINGS };
let state: UpdateState = {
  phase: 'unconfigured',
  message: 'Configure a managed release feed to enable in-app updates.',
  currentVersion: app.getVersion(),
  channel: 'stable',
  feedUrl: '',
};
let eventsAttached = false;

function settingsFile() {
  return join(app.getPath('userData'), 'update-settings.json');
}

function emitUpdate() {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('update:event', state);
}

function setState(changes: Partial<UpdateState>) {
  state = { ...state, ...changes, currentVersion: app.getVersion(), channel: settings.channel, feedUrl: settings.feedUrl };
  emitUpdate();
  return state;
}

function validateFeedUrl(value: string) {
  if (!value) return '';
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('The update feed must use HTTPS.');
  return parsed.toString().replace(/\/$/, '');
}

function notesToText(notes: UpdateInfo['releaseNotes']) {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes.map((entry) => entry.note ?? '').filter(Boolean).join('\n\n');
}

function attachEvents() {
  if (eventsAttached) return;
  eventsAttached = true;
  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', message: 'Checking the managed release feed…', progress: undefined }));
  autoUpdater.on('update-available', (info) => setState({ phase: 'available', message: `Version ${info.version} is ready to download.`, availableVersion: info.version, releaseNotes: notesToText(info.releaseNotes), progress: undefined }));
  autoUpdater.on('update-not-available', () => setState({ phase: 'current', message: 'You are on the latest release for this channel.', availableVersion: undefined, releaseNotes: undefined, progress: undefined }));
  autoUpdater.on('download-progress', (progress: ProgressInfo) => setState({ phase: 'downloading', message: `Downloading ${Math.round(progress.percent)}%…`, progress: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => setState({ phase: 'downloaded', message: `Version ${info.version} is ready. Restart when you are ready to install it.`, availableVersion: info.version, releaseNotes: notesToText(info.releaseNotes), progress: 100 }));
  autoUpdater.on('error', (error) => setState({ phase: 'error', message: `Update service: ${error.message}`, progress: undefined }));
}

async function persistSettings() {
  await mkdir(app.getPath('userData'), { recursive: true });
  const temp = `${settingsFile()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(temp, settingsFile());
}

function feedOptions() {
  const parsed = new URL(settings.feedUrl);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'github.com' && parts.length >= 2) {
    return { provider: 'github' as const, owner: parts[0], repo: parts[1], private: false };
  }
  return { provider: 'generic' as const, url: settings.feedUrl, channel: settings.channel === 'preview' ? 'beta' : 'latest' };
}

function configureUpdater() {
  if (!app.isPackaged) return setState({ phase: 'development', message: 'Update checks are available in the installed Windows release, not in development preview.' });
  if (process.platform !== 'win32' || Boolean(process.env.PORTABLE_EXECUTABLE_FILE)) return setState({ phase: 'unsupported', message: 'Use the installed Aether setup build for managed updates. Portable builds remain an offline recovery option.' });
  if (!settings.feedUrl) return setState({ phase: 'unconfigured', message: 'Add your HTTPS release feed to enable managed updates.' });

  attachEvents();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = settings.channel === 'preview';
  autoUpdater.allowDowngrade = false;
  autoUpdater.channel = settings.channel === 'preview' ? 'beta' : 'latest';
  autoUpdater.setFeedURL(feedOptions());
  return setState({ phase: 'ready', message: `Ready to check the ${settings.channel} release channel.`, availableVersion: undefined, releaseNotes: undefined, progress: undefined });
}

export async function initializeUpdates() {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8')) as Partial<UpdateSettings>;
    settings = {
      feedUrl: typeof parsed.feedUrl === 'string' ? validateFeedUrl(parsed.feedUrl) : '',
      channel: parsed.channel === 'preview' ? 'preview' : 'stable',
    };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return configureUpdater();
}

export function getUpdateState() {
  return state;
}

export async function saveUpdateSettings(payload: unknown) {
  const value = payload as Partial<UpdateSettings>;
  settings = {
    feedUrl: validateFeedUrl(typeof value.feedUrl === 'string' ? value.feedUrl.trim() : settings.feedUrl),
    channel: value.channel === 'preview' ? 'preview' : 'stable',
  };
  await persistSettings();
  return configureUpdater();
}

export async function checkForUpdates() {
  const configured = configureUpdater();
  if (configured.phase !== 'ready' && configured.phase !== 'current') return configured;
  await autoUpdater.checkForUpdates();
  return state;
}

export async function downloadUpdate() {
  if (state.phase !== 'available') throw new Error('Check for updates and select an available release before downloading.');
  setState({ phase: 'downloading', message: 'Preparing update download…', progress: 0 });
  await autoUpdater.downloadUpdate();
  return state;
}

export function installDownloadedUpdate() {
  if (state.phase !== 'downloaded') throw new Error('No downloaded update is ready to install.');
  autoUpdater.quitAndInstall(false, true);
}

export function releaseArtifactPolicy() {
  return {
    currentVersion: app.getVersion(),
    channels: [
      { id: 'stable', manifest: 'latest.yml', label: 'Stable' },
      { id: 'preview', manifest: 'beta.yml', label: 'Preview' },
    ],
    rollback: 'Publish the last known-good code as a new higher version on the affected channel. Keep previous signed installers available for manual recovery.',
  };
}
