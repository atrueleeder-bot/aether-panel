import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { checkForUpdates, downloadUpdate, getUpdateState, initializeUpdates, installDownloadedUpdate, releaseArtifactPolicy, saveUpdateSettings } from './updater';
import { applyOverrides, downloadMrpackVersion, inspectMrpack, listModrinthPackVersions, removeTemporaryPack, searchModrinthPacks, type ModrinthPackVersion, type PackInspection, type PackFilePlan } from './pack-import';

type ServerType = 'paper' | 'spigot' | 'forge' | 'fabric' | 'vanilla';
type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'failed';

interface InstalledContent {
  projectId: string;
  title: string;
  filename: string;
  kind: 'mod' | 'plugin';
  installedAt: string;
}

interface ManagedServer {
  id: string;
  name: string;
  type: ServerType;
  version: string;
  directory: string;
  jarPath: string;
  memory: number;
  port: number;
  createdAt: string;
  status: ServerStatus;
  installedMods: number;
  installedContent: InstalledContent[];
}

interface BuildRequest {
  name: string;
  type: ServerType;
  version: string;
  directory: string;
  memory: number;
  port: number;
}

interface ImportRequest {
  name: string;
  directory: string;
  memory: number;
  port: number;
  archivePath: string;
  source: PackInspection['source'];
}

const USER_AGENT = 'AetherPanel/0.1.0 (https://github.com/aetherpanel/aether-panel)';
const GIT_RELEASES_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
const SERVER_TYPES: ServerType[] = ['paper', 'spigot', 'forge', 'fabric', 'vanilla'];
const runningServers = new Map<string, ChildProcess>();
let previousCpuSample: { idle: number; total: number } | null = null;

function dataFile() {
  return join(app.getPath('userData'), 'servers.json');
}

function emit(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function buildEvent(phase: 'queued' | 'download' | 'install' | 'complete' | 'error', message: string, serverId?: string) {
  emit('builder:event', { phase, message, serverId });
}

async function readServers(): Promise<ManagedServer[]> {
  try {
    const raw = await readFile(dataFile(), 'utf8');
    const parsed = JSON.parse(raw) as ManagedServer[];
    return parsed.map((server) => {
      const installedContent = Array.isArray(server.installedContent) ? server.installedContent : [];
      return { ...server, installedContent, installedMods: installedContent.length || Number(server.installedMods ?? 0), status: runningServers.has(server.id) ? 'online' : 'offline' };
    });
  } catch {
    return [];
  }
}

async function saveServers(servers: ManagedServer[]) {
  await mkdir(app.getPath('userData'), { recursive: true });
  const temp = `${dataFile()}.tmp`;
  await writeFile(temp, JSON.stringify(servers, null, 2), 'utf8');
  await rename(temp, dataFile());
}

async function updateServer(id: string, changes: Partial<ManagedServer>) {
  const servers = await readServers();
  const index = servers.findIndex((server) => server.id === id);
  if (index === -1) throw new Error('Server not found.');
  servers[index] = { ...servers[index], ...changes };
  await saveServers(servers);
  if (changes.status !== undefined) emit('server:state', { serverId: id, status: servers[index].status });
  return servers[index];
}

function normalizeServerName(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 48) throw new Error('Choose a server name between 1 and 48 characters.');
  const safe = trimmed.replace(/[^a-zA-Z0-9 _.-]/g, '').replace(/\s+/g, '-');
  if (!safe) throw new Error('The server name does not contain a usable folder name.');
  return { display: trimmed, folder: safe };
}

function validateImportRequest(payload: unknown): ImportRequest {
  const value = payload as Partial<ImportRequest>;
  if (!value || typeof value !== 'object') throw new Error('Invalid pack import request.');
  if (typeof value.directory !== 'string' || !value.directory.trim()) throw new Error('Choose a local installation directory.');
  if (typeof value.archivePath !== 'string' || !value.archivePath.toLowerCase().endsWith('.mrpack')) throw new Error('Choose a valid Modrinth .mrpack archive.');
  if (!value.source || (value.source.kind !== 'local' && value.source.kind !== 'modrinth')) throw new Error('The pack source is not valid.');
  const memory = Number(value.memory);
  const port = Number(value.port);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536) throw new Error('Memory must be between 1024 MB and 65536 MB.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid port between 1024 and 65535.');
  const { display } = normalizeServerName(String(value.name ?? ''));
  return { name: display, directory: resolve(value.directory), memory, port, archivePath: resolve(value.archivePath), source: value.source };
}

function validateBuildRequest(payload: unknown): BuildRequest {
  const value = payload as Partial<BuildRequest>;
  if (!value || typeof value !== 'object') throw new Error('Invalid build request.');
  if (!SERVER_TYPES.includes(value.type as ServerType)) throw new Error('Unsupported server type.');
  if (typeof value.version !== 'string' || !/^[0-9A-Za-z._-]+$/.test(value.version)) throw new Error('Invalid Minecraft version.');
  if (typeof value.directory !== 'string' || !value.directory.trim()) throw new Error('Choose a local installation directory.');
  const memory = Number(value.memory);
  const port = Number(value.port);
  if (!Number.isInteger(memory) || memory < 1024 || memory > 65536) throw new Error('Memory must be between 1024 MB and 65536 MB.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid port between 1024 and 65535.');
  const { display } = normalizeServerName(String(value.name ?? ''));
  return {
    name: display,
    type: value.type as ServerType,
    version: value.version,
    directory: resolve(value.directory),
    memory,
    port,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed (${response.status}) while accessing ${new URL(url).hostname}.`);
  return response.json() as Promise<T>;
}

async function downloadToFile(url: string, destination: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS downloads are permitted.');
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) from ${parsed.hostname}.`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function ensureEulaAndProperties(serverDir: string, port: number) {
  await writeFile(join(serverDir, 'eula.txt'), 'eula=true\n', 'utf8');
  const properties = join(serverDir, 'server.properties');
  try {
    await access(properties);
  } catch {
    await writeFile(properties, `server-port=${port}\nonline-mode=true\nspawn-protection=16\nmotd=Aether Panel Server\n`, 'utf8');
  }
}

async function enforceManagedPackProperties(serverDir: string, port: number, packName: string) {
  await writeFile(join(serverDir, 'eula.txt'), 'eula=true\n', 'utf8');
  const propertiesPath = join(serverDir, 'server.properties');
  let existing = '';
  try {
    existing = await readFile(propertiesPath, 'utf8');
  } catch {
    // A package may omit server.properties; Aether will generate the controlled defaults.
  }
  const protectedKeys = new Set(['server-port', 'server-ip', 'online-mode', 'enable-rcon', 'rcon.port', 'rcon.password']);
  const retained = existing.split(/\r?\n/).filter((line) => {
    const key = line.split('=', 1)[0]?.trim();
    return line.trim() && !protectedKeys.has(key);
  });
  retained.push(`server-port=${port}`, 'online-mode=true', 'enable-rcon=false');
  if (!retained.some((line) => line.startsWith('motd='))) retained.push(`motd=${packName.replace(/[\r\n]/g, ' ')}`);
  await writeFile(propertiesPath, `${retained.join('\n')}\n`, 'utf8');
}

function runCommand(command: string, args: string[], cwd: string, serverId: string, phase: 'install' | 'download' = 'install') {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    child.stdout?.on('data', (data) => buildEvent(phase, String(data).trimEnd(), serverId));
    child.stderr?.on('data', (data) => buildEvent(phase, String(data).trimEnd(), serverId));
    child.once('error', (error) => reject(error));
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`)));
  });
}

async function buildVanilla(version: string, serverDir: string, id: string) {
  buildEvent('download', `Resolving Vanilla ${version} metadata…`, id);
  const manifest = await fetchJson<{ versions: Array<{ id: string; url: string }> }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const release = manifest.versions.find((entry) => entry.id === version);
  if (!release) throw new Error(`Minecraft ${version} is not available from the official manifest.`);
  const metadata = await fetchJson<{ downloads: { server?: { url: string } } }>(release.url);
  if (!metadata.downloads.server?.url) throw new Error(`Minecraft ${version} does not include a dedicated-server download.`);
  buildEvent('download', `Downloading official Minecraft ${version} server JAR…`, id);
  const jar = join(serverDir, 'server.jar');
  await downloadToFile(metadata.downloads.server.url, jar);
  return jar;
}

async function buildPaper(version: string, serverDir: string, id: string) {
  buildEvent('download', `Resolving stable Paper ${version} build…`, id);
  type PaperBuild = { channel: string; downloads: Record<string, { url: string }> };
  const builds = await fetchJson<PaperBuild[]>(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
  const stable = builds.find((build) => build.channel === 'STABLE' && build.downloads['server:default']?.url);
  if (!stable) throw new Error(`No stable Paper build is currently available for Minecraft ${version}.`);
  const jar = join(serverDir, 'server.jar');
  buildEvent('download', `Downloading stable Paper ${version} build…`, id);
  await downloadToFile(stable.downloads['server:default'].url, jar);
  return jar;
}

async function buildFabric(version: string, serverDir: string, id: string, pinnedLoaderVersion?: string) {
  buildEvent('download', `Resolving Fabric loader for Minecraft ${version}…`, id);
  const loaders = await fetchJson<Array<{ loader: { version: string; stable: boolean } }>>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`);
  const installers = await fetchJson<Array<{ version: string; stable: boolean }>>('https://meta.fabricmc.net/v2/versions/installer');
  const loader = pinnedLoaderVersion ? loaders.find((item) => item.loader.version === pinnedLoaderVersion) : (loaders.find((item) => item.loader.stable) ?? loaders[0]);
  if (pinnedLoaderVersion && !loader) throw new Error(`Fabric loader ${pinnedLoaderVersion} is not available for Minecraft ${version}.`);
  const installer = installers.find((item) => item.stable) ?? installers[0];
  if (!loader || !installer) throw new Error(`Fabric does not currently publish a compatible loader for Minecraft ${version}.`);
  const jar = join(serverDir, 'server.jar');
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader.loader.version)}/${encodeURIComponent(installer.version)}/server/jar`;
  buildEvent('download', `Downloading Fabric loader ${loader.loader.version}…`, id);
  await downloadToFile(url, jar);
  return jar;
}

async function buildForge(version: string, serverDir: string, id: string, pinnedLoaderVersion?: string) {
  buildEvent('download', `Resolving Forge installer for Minecraft ${version}…`, id);
  const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('Unable to access the official Forge metadata.');
  const xml = await response.text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
  const forgeVersion = pinnedLoaderVersion ? `${version}-${pinnedLoaderVersion}` : versions.filter((entry) => entry.startsWith(`${version}-`)).at(-1);
  if (!forgeVersion || !versions.includes(forgeVersion)) throw new Error(pinnedLoaderVersion ? `Forge ${pinnedLoaderVersion} is not available for Minecraft ${version}.` : `Forge does not currently publish an installer for Minecraft ${version}.`);
  const installerPath = join(serverDir, 'forge-installer.jar');
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/forge-${encodeURIComponent(forgeVersion)}-installer.jar`;
  buildEvent('download', `Downloading Forge ${forgeVersion} installer…`, id);
  await downloadToFile(installerUrl, installerPath);
  buildEvent('install', 'Running the official Forge server installer locally…', id);
  await runCommand('java', ['-jar', installerPath, '--installServer'], serverDir, id);
  const runBat = join(serverDir, 'run.bat');
  const runSh = join(serverDir, 'run.sh');
  if (process.platform === 'win32' && existsSync(runBat)) return runBat;
  if (process.platform !== 'win32' && existsSync(runSh)) return runSh;
  throw new Error('Forge installation completed but the expected startup script was not created.');
}

async function buildSpigot(version: string, serverDir: string, id: string) {
  const tools = join(serverDir, 'BuildTools.jar');
  buildEvent('download', 'Downloading the official Spigot BuildTools JAR…', id);
  await downloadToFile('https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', tools);
  buildEvent('install', `Building Spigot ${version} locally. This can take several minutes…`, id);
  await runCommand('java', ['-jar', tools, '--rev', version, '--output-dir', serverDir], serverDir, id);
  const files = await readdir(serverDir);
  const match = files.find((file) => file === `spigot-${version}.jar`) ?? files.find((file) => /^spigot-.+\.jar$/i.test(file));
  if (!match) throw new Error('Spigot BuildTools completed but no Spigot JAR was found. Check the build output for prerequisites.');
  return join(serverDir, match);
}

async function hashFileSha512(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function downloadVerifiedPackFile(file: PackFilePlan, destination: string, serverId: string) {
  let lastError: Error | null = null;
  for (const source of file.downloads) {
    try {
      await rm(destination, { force: true });
      buildEvent('download', `Retrieving verified pack file ${file.filename}…`, serverId);
      await downloadToFile(source, destination);
      const actualHash = await hashFileSha512(destination);
      if (actualHash !== file.sha512) throw new Error(`SHA-512 verification failed for ${file.filename}.`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('The pack file could not be downloaded.');
    }
  }
  throw lastError ?? new Error(`The pack file ${file.filename} could not be downloaded from a verified source.`);
}

async function createServer(payload: unknown) {
  const request = validateBuildRequest(payload);
  const { folder } = normalizeServerName(request.name);
  const serverDir = join(request.directory, folder);
  const id = randomUUID();
  if (existsSync(serverDir)) throw new Error(`The folder “${folder}” already exists in the selected directory.`);

  buildEvent('queued', `Preparing ${request.type.toUpperCase()} server workspace…`, id);
  await mkdir(serverDir, { recursive: true });
  let jarPath = '';
  try {
    if (request.type === 'vanilla') jarPath = await buildVanilla(request.version, serverDir, id);
    if (request.type === 'paper') jarPath = await buildPaper(request.version, serverDir, id);
    if (request.type === 'fabric') jarPath = await buildFabric(request.version, serverDir, id);
    if (request.type === 'forge') jarPath = await buildForge(request.version, serverDir, id);
    if (request.type === 'spigot') jarPath = await buildSpigot(request.version, serverDir, id);
    await ensureEulaAndProperties(serverDir, request.port);
    const server: ManagedServer = {
      id,
      name: request.name,
      type: request.type,
      version: request.version,
      directory: serverDir,
      jarPath,
      memory: request.memory,
      port: request.port,
      createdAt: new Date().toISOString(),
      status: 'offline',
      installedMods: 0,
      installedContent: [],
    };
    const servers = await readServers();
    servers.unshift(server);
    await saveServers(servers);
    buildEvent('complete', `${request.name} is ready. Review the server settings, then start it from the fleet view.`, id);
    return server;
  } catch (error) {
    await rm(serverDir, { recursive: true, force: true });
    buildEvent('error', error instanceof Error ? error.message : 'Server build failed.', id);
    throw error;
  }
}

async function createImportedServer(payload: unknown) {
  const request = validateImportRequest(payload);
  const inspection = inspectMrpack(request.archivePath, request.source);
  if (inspection.readiness !== 'server-ready' || !inspection.runtime) {
    throw new Error(`This package is not server-ready: ${inspection.blockedReasons.join(' ') || 'the declared runtime could not be verified.'}`);
  }
  const { folder } = normalizeServerName(request.name);
  const serverDir = join(request.directory, folder);
  const id = randomUUID();
  if (existsSync(serverDir)) throw new Error(`The folder “${folder}” already exists in the selected directory.`);

  buildEvent('queued', `Preflight passed for ${inspection.name}. Preparing a locked ${inspection.runtime.toUpperCase()} workspace…`, id);
  await mkdir(serverDir, { recursive: true });
  let jarPath = '';
  try {
    if (inspection.runtime === 'fabric') jarPath = await buildFabric(inspection.minecraft, serverDir, id, inspection.loaderVersion);
    if (inspection.runtime === 'forge') jarPath = await buildForge(inspection.minecraft, serverDir, id, inspection.loaderVersion);

    for (const file of inspection.requiredFiles) {
      const destination = join(serverDir, ...file.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await downloadVerifiedPackFile(file, destination, id);
    }

    buildEvent('install', `Applying ${inspection.overrideFiles.length} declared configuration override${inspection.overrideFiles.length === 1 ? '' : 's'}…`, id);
    await applyOverrides(inspection, serverDir);
    await enforceManagedPackProperties(serverDir, request.port, inspection.name);

    const installedContent = inspection.requiredFiles
      .filter((file) => file.path.startsWith('mods/'))
      .map((file, index) => ({ projectId: `pack:${inspection.versionId}:${index}`, title: file.filename, filename: file.filename, kind: 'mod' as const, installedAt: new Date().toISOString() }));
    const lock = {
      schema: 1,
      createdAt: new Date().toISOString(),
      source: inspection.source,
      pack: { name: inspection.name, summary: inspection.summary, versionId: inspection.versionId },
      runtime: { minecraft: inspection.minecraft, type: inspection.runtime, loaderVersion: inspection.loaderVersion },
      files: { installed: inspection.requiredFiles, excludedClientOnly: inspection.excludedClientFiles },
      overrides: inspection.overrideFiles,
      protectedSettings: ['eula', 'server-port', 'server-ip', 'online-mode', 'rcon', 'aether-launch-command', 'aether-memory-ceiling'],
      snapshot: 'pre-first-launch',
    };
    await writeFile(join(serverDir, 'aether-pack.lock.json'), JSON.stringify(lock, null, 2), 'utf8');

    const server: ManagedServer = {
      id,
      name: request.name,
      type: inspection.runtime,
      version: inspection.minecraft,
      directory: serverDir,
      jarPath,
      memory: request.memory,
      port: request.port,
      createdAt: new Date().toISOString(),
      status: 'offline',
      installedMods: installedContent.length,
      installedContent,
    };
    const servers = await readServers();
    servers.unshift(server);
    await saveServers(servers);
    buildEvent('complete', `${request.name} is ready from a verified Modrinth pack plan. Client-only files were excluded and a pre-first-launch lock was recorded.`, id);
    return server;
  } catch (error) {
    await rm(serverDir, { recursive: true, force: true });
    buildEvent('error', error instanceof Error ? error.message : 'The managed pack import failed.', id);
    throw error;
  } finally {
    if (request.source.kind === 'modrinth') await removeTemporaryPack(request.archivePath);
  }
}

async function inspectModrinthPackVersion(payload: unknown) {
  const value = payload as { projectId?: string; version?: ModrinthPackVersion };
  if (!value?.projectId || !value.version?.id || !value.version.fileUrl || !/^[a-f0-9]{128}$/i.test(value.version.sha512)) throw new Error('Choose a published Modrinth pack version before preflight.');
  const cacheDirectory = join(app.getPath('temp'), 'aether-pack-previews');
  const archivePath = await downloadMrpackVersion(value.projectId, value.version, cacheDirectory);
  const archiveHash = await hashFileSha512(archivePath);
  if (archiveHash !== value.version.sha512.toLowerCase()) {
    await removeTemporaryPack(archivePath);
    throw new Error('The downloaded Modrinth pack did not match its published SHA-512 hash.');
  }
  return inspectMrpack(archivePath, { kind: 'modrinth', projectId: value.projectId, versionId: value.version.id });
}

function emitServerOutput(serverId: string, line: string, kind: 'stdout' | 'stderr' | 'system') {
  emit('server:output', { serverId, line, kind });
}

async function startServer(id: string) {
  const servers = await readServers();
  const server = servers.find((item) => item.id === id);
  if (!server) throw new Error('Server not found.');
  if (runningServers.has(id)) return;
  if (!existsSync(server.jarPath)) throw new Error('The server startup file is missing. Rebuild or update the server configuration.');

  await updateServer(id, { status: 'starting' });
  emitServerOutput(id, `Starting ${server.name}…`, 'system');
  const isForgeScript = server.type === 'forge';
  const child = isForgeScript
    ? process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'run.bat', 'nogui'], { cwd: server.directory, windowsHide: true, shell: false })
      : spawn('sh', ['run.sh', 'nogui'], { cwd: server.directory, windowsHide: true, shell: false })
    : spawn('java', [`-Xms${Math.max(1024, Math.floor(server.memory / 2))}M`, `-Xmx${server.memory}M`, '-jar', server.jarPath, 'nogui'], { cwd: server.directory, windowsHide: true, shell: false });

  runningServers.set(id, child);
  child.stdout?.on('data', (data) => emitServerOutput(id, String(data).trimEnd(), 'stdout'));
  child.stderr?.on('data', (data) => emitServerOutput(id, String(data).trimEnd(), 'stderr'));
  child.once('error', async (error) => {
    emitServerOutput(id, error.message, 'stderr');
    runningServers.delete(id);
    await updateServer(id, { status: 'failed' });
  });
  child.once('spawn', async () => {
    await updateServer(id, { status: 'online' });
    emitServerOutput(id, `${server.name} process is running.`, 'system');
  });
  child.once('close', async (code) => {
    runningServers.delete(id);
    await updateServer(id, { status: code === 0 ? 'offline' : 'failed' });
    emitServerOutput(id, `${server.name} stopped with code ${code ?? 'unknown'}.`, 'system');
  });
}

async function stopServer(id: string) {
  const child = runningServers.get(id);
  if (!child?.stdin) return;
  await updateServer(id, { status: 'stopping' });
  child.stdin.write('stop\n');
  const forceTimer = setTimeout(() => child.kill(), 10_000);
  child.once('close', () => clearTimeout(forceTimer));
}

async function sendCommand(payload: unknown) {
  const { id, command } = payload as { id?: string; command?: string };
  if (!id || typeof command !== 'string' || !command.trim()) throw new Error('Enter a valid console command.');
  const child = runningServers.get(id);
  if (!child?.stdin) throw new Error('The server is offline. Start it before sending commands.');
  child.stdin.write(`${command.trim()}\n`);
  emitServerOutput(id, `> ${command.trim()}`, 'system');
}

async function getVersions() {
  const manifest = await fetchJson<{ versions: Array<{ id: string; type: string }> }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return manifest.versions.filter((entry) => entry.type === 'release').slice(0, 40).map((entry) => entry.id);
}

async function searchMods(payload: unknown) {
  const value = payload as { query?: string; version?: string; loader?: string; contentType?: 'mod' | 'plugin'; limit?: number };
  const query = String(value.query ?? '').trim();
  const version = String(value.version ?? '').trim();
  const loader = String(value.loader ?? '').trim().toLowerCase();
  if (!version) throw new Error('Choose a Minecraft version before searching mods.');
  const supportedLoaders = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'bukkit', 'spigot', 'paper']);
  const projectType = value.contentType === 'plugin' ? 'plugin' : 'mod';
  const facets: string[][] = [[`project_type:${projectType}`], [`versions:${version}`]];
  if (supportedLoaders.has(loader)) facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({ query, limit: String(Math.min(Math.max(Number(value.limit) || 18, 1), 50)), index: 'downloads', facets: JSON.stringify(facets) });
  const response = await fetchJson<{ hits: Array<Record<string, unknown>> }>(`https://api.modrinth.com/v2/search?${params.toString()}`);
  return response.hits.map((hit) => ({
    project_id: String(hit.project_id),
    slug: String(hit.slug ?? ''),
    title: String(hit.title ?? 'Untitled mod'),
    description: String(hit.description ?? ''),
    icon_url: typeof hit.icon_url === 'string' ? hit.icon_url : undefined,
    downloads: Number(hit.downloads ?? 0),
    follows: Number(hit.follows ?? 0),
    categories: Array.isArray(hit.categories) ? hit.categories.map(String) : [],
    latest_version: typeof hit.latest_version === 'string' ? hit.latest_version : undefined,
    author: typeof hit.author === 'string' ? hit.author : undefined,
  }));
}

async function installMod(payload: unknown) {
  const value = payload as { serverId?: string; projectId?: string; title?: string; version?: string; loader?: string };
  if (!value.serverId || !value.projectId || !value.version || !value.loader) throw new Error('Missing compatible mod install details.');
  const servers = await readServers();
  const server = servers.find((item) => item.id === value.serverId);
  if (!server) throw new Error('Server not found.');
  if (server.status === 'online') throw new Error('Stop the server before installing a mod.');
  const params = new URLSearchParams({ loaders: JSON.stringify([value.loader.toLowerCase()]), game_versions: JSON.stringify([value.version]) });
  type VersionFile = { url: string; filename: string; primary: boolean };
  type ModVersion = { files: VersionFile[] };
  const versions = await fetchJson<ModVersion[]>(`https://api.modrinth.com/v2/project/${encodeURIComponent(value.projectId)}/version?${params.toString()}`);
  const file = versions.flatMap((item) => item.files).find((item) => item.primary) ?? versions[0]?.files[0];
  if (!file) throw new Error('No compatible downloadable mod file was found for this server.');
  const host = new URL(file.url).hostname;
  if (host !== 'cdn.modrinth.com') throw new Error('The mod download URL is not from Modrinth’s CDN.');
  const modsDir = join(server.directory, 'mods');
  await mkdir(modsDir, { recursive: true });
  const destination = join(modsDir, file.filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
  await downloadToFile(file.url, destination);
  const kind = server.type === 'paper' || server.type === 'spigot' ? 'plugin' : 'mod';
  const installedContent = (server.installedContent ?? []).filter((item) => item.filename !== file.filename && item.projectId !== value.projectId);
  installedContent.push({ projectId: value.projectId, title: value.title?.trim() || value.projectId, filename: file.filename, kind, installedAt: new Date().toISOString() });
  await updateServer(server.id, { installedMods: installedContent.length, installedContent });
  return { filename: file.filename, title: value.title?.trim() || value.projectId, installedCount: installedContent.length };
}

function checkExecutable(command: string, args: string[]) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8' });
  if (result.error) return { found: false, detail: `${command} was not found on PATH.` };
  const detail = `${result.stdout || result.stderr || `${command} found`}`.trim().split('\n')[0];
  return { found: result.status === 0, detail };
}

function checkGit() {
  const direct = checkExecutable('git', ['--version']);
  if (direct.found) return direct;
  if (process.platform !== 'win32') return direct;
  const candidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe') : '',
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe') : '',
    process.env.LocalAppData ? join(process.env.LocalAppData, 'Programs', 'Git', 'cmd', 'git.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (!result.error && result.status === 0) return { found: true, detail: `${result.stdout || result.stderr}`.trim().split('\n')[0] };
  }
  return { found: false, detail: 'Git was not found on this computer.' };
}

function readCpuUsage() {
  const cpus = os.cpus();
  const totals = cpus.reduce((accumulator, cpu) => {
    const times = cpu.times;
    accumulator.idle += times.idle;
    accumulator.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return accumulator;
  }, { idle: 0, total: 0 });
  const usage = previousCpuSample ? 100 - ((totals.idle - previousCpuSample.idle) / Math.max(1, totals.total - previousCpuSample.total)) * 100 : 0;
  previousCpuSample = totals;
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
}

function readDiskUsage() {
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive ?? 'C:').replace(/[^A-Za-z:]/g, '').slice(0, 2);
    const command = `Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      try {
        const parsed = JSON.parse(result.stdout.trim()) as { Size?: number; FreeSpace?: number };
        const total = Number(parsed.Size ?? 0);
        const free = Number(parsed.FreeSpace ?? 0);
        if (total > 0) return { usedPct: Math.round(((total - free) / total) * 1000) / 10, freeBytes: free, totalBytes: total };
      } catch {
        // Fall through to an unavailable disk state.
      }
    }
    return { usedPct: 0, freeBytes: 0, totalBytes: 0 };
  }
  const result = spawnSync('df', ['-Pk', '/'], { encoding: 'utf8' });
  const line = result.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const totalBytes = Number(line[1] ?? 0) * 1024;
  const freeBytes = Number(line[3] ?? 0) * 1024;
  return { usedPct: Number(String(line[4] ?? '0').replace('%', '')) || 0, freeBytes, totalBytes };
}

function sampleResources() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    timestamp: Date.now(),
    cpuPct: readCpuUsage(),
    ramPct: Math.round(((totalMemory - freeMemory) / totalMemory) * 1000) / 10,
    ramUsedBytes: totalMemory - freeMemory,
    ramTotalBytes: totalMemory,
    disk: readDiskUsage(),
  };
}

function emitRuntimeEvent(phase: 'checking' | 'downloading' | 'installing' | 'complete' | 'error', message: string) {
  emit('runtime:event', { phase, message });
}

async function installGitForWindows() {
  if (process.platform !== 'win32') throw new Error('Automatic Git installation is available only on Windows.');
  const existing = checkGit();
  if (existing.found) return existing;

  emitRuntimeEvent('checking', 'Looking up the current official Git for Windows release…');
  const release = await fetchJson<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>(GIT_RELEASES_API);
  const asset = release.assets.find((item) => /^Git-[^/]+-64-bit\.exe$/i.test(item.name));
  if (!asset || new URL(asset.browser_download_url).hostname !== 'github.com') throw new Error('The official Git for Windows x64 installer could not be located.');

  const installerPath = join(app.getPath('temp'), `Aether-Git-${release.tag_name.replace(/[^a-zA-Z0-9.-]/g, '_')}.exe`);
  try {
    emitRuntimeEvent('downloading', `Downloading Git for Windows ${release.tag_name.replace(/^v/, '')}…`);
    await downloadToFile(asset.browser_download_url, installerPath);
    emitRuntimeEvent('installing', 'Running the official Git installer. Windows may show a permission prompt…');
    await new Promise<void>((resolvePromise, reject) => {
      const installer = spawn(installerPath, ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', '/o:PathOption=Cmd'], { windowsHide: true, shell: false });
      installer.once('error', reject);
      installer.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`Git installer exited with code ${code ?? 'unknown'}.`)));
    });
    const verified = checkGit();
    if (!verified.found) throw new Error('Git installation finished, but Windows has not exposed Git to the current process yet. Restart Aether Panel and check again.');
    emitRuntimeEvent('complete', `${verified.detail} is ready.`);
    return verified;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git installation failed.';
    emitRuntimeEvent('error', message);
    throw error;
  } finally {
    await unlink(installerPath).catch(() => undefined);
  }
}

function startupMarkup(message: string, detail: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:#07111f;color:#eaf5ff;font-family:Segoe UI,Arial,sans-serif}body{display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,rgba(45,133,191,.22),transparent 38%),#07111f}.panel{width:300px;padding:30px;border:1px solid rgba(159,216,255,.18);border-radius:18px;text-align:center;background:linear-gradient(145deg,rgba(13,39,65,.94),rgba(6,20,37,.96));box-shadow:0 22px 65px rgba(0,0,0,.45)}.mark{width:46px;height:46px;display:grid;place-items:center;margin:0 auto 15px;border-radius:14px;background:linear-gradient(145deg,#48c4fa,#2b71cc);box-shadow:0 0 28px rgba(72,192,255,.4);font-weight:800;font-size:23px}.kicker{margin:0 0 7px;color:#7ed6ff;font:9px Consolas,monospace;letter-spacing:.2em}.title{margin:0;font-size:20px}.detail{margin:10px 0 20px;color:#8ca4bd;font:10px Consolas,monospace;line-height:1.5}.rail{height:3px;overflow:hidden;border-radius:99px;background:rgba(152,206,246,.13)}.rail i{display:block;width:44%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#56caff,#c0f0ff);box-shadow:0 0 14px #56caff;animation:sweep 1.25s ease-in-out infinite}@keyframes sweep{0%{transform:translateX(-120%)}55%,100%{transform:translateX(270%)}}</style></head><body><main class="panel"><div class="mark">A</div><p class="kicker">LOCAL SERVER OS</p><h1 class="title">${message}</h1><p class="detail">${detail}</p><div class="rail"><i></i></div></main></body></html>`;
}

function dataPage(message: string, detail: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(startupMarkup(message, detail))}`;
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 390,
    height: 275,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#07111f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.center();
  void splash.loadURL(dataPage('Starting Aether', 'Preparing your private control room…'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

function createWindow() {
  const splash = createSplashWindow();
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#07111f',
    title: 'Aether Panel',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  let revealed = false;
  const revealWindow = () => {
    if (revealed) return;
    revealed = true;
    if (!window.isDestroyed()) window.show();
    if (!splash.isDestroyed()) splash.close();
  };
  const failsafe = setTimeout(revealWindow, 9000);
  window.once('ready-to-show', () => {
    clearTimeout(failsafe);
    revealWindow();
  });
  window.on('closed', () => {
    clearTimeout(failsafe);
    if (!splash.isDestroyed()) splash.close();
  });
  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return;
    void window.loadURL(dataPage('Aether could not start', `The dashboard failed to load: ${errorDescription}. Close and reopen the app, or review the source package for diagnostics.`));
    clearTimeout(failsafe);
    revealWindow();
  });
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('io.aetherpanel.desktop');
  await initializeUpdates();
  ipcMain.handle('dialog:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:chooseMrpack', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Modrinth pack', extensions: ['mrpack'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('servers:list', () => readServers());
  ipcMain.handle('catalog:versions', () => getVersions());
  ipcMain.handle('builder:build', (_event, payload) => createServer(payload));
  ipcMain.handle('builder:importPack', (_event, payload) => createImportedServer(payload));
  ipcMain.handle('pack:inspectLocal', (_event, archivePath: string) => inspectMrpack(resolve(archivePath), { kind: 'local' }));
  ipcMain.handle('pack:search', (_event, query: string) => searchModrinthPacks(query));
  ipcMain.handle('pack:versions', (_event, projectId: string) => listModrinthPackVersions(projectId));
  ipcMain.handle('pack:preflightModrinth', (_event, payload) => inspectModrinthPackVersion(payload));
  ipcMain.handle('server:start', (_event, id: string) => startServer(id));
  ipcMain.handle('server:stop', (_event, id: string) => stopServer(id));
  ipcMain.handle('server:command', (_event, payload) => sendCommand(payload));
  ipcMain.handle('server:delete', async (_event, id: string) => {
    if (runningServers.has(id)) throw new Error('Stop the server before removing it from the panel.');
    const servers = await readServers();
    const server = servers.find((item) => item.id === id);
    if (!server) throw new Error('Server not found.');
    await saveServers(servers.filter((item) => item.id !== id));
  });
  ipcMain.handle('runtime:check', () => ({ java: checkExecutable('java', ['--version']), git: checkGit() }));
  ipcMain.handle('resources:sample', () => sampleResources());
  ipcMain.handle('runtime:installGit', () => installGitForWindows());
  ipcMain.handle('modrinth:search', (_event, payload) => searchMods(payload));
  ipcMain.handle('modrinth:install', (_event, payload) => installMod(payload));
  ipcMain.handle('updates:state', () => getUpdateState());
  ipcMain.handle('updates:settings', (_event, payload) => saveUpdateSettings(payload));
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installDownloadedUpdate());
  ipcMain.handle('updates:policy', () => releaseArtifactPolicy());
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
