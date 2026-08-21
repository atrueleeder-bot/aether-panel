import AdmZip from 'adm-zip';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type ImportRuntime = 'fabric' | 'forge';
export type PackReadiness = 'server-ready' | 'unsupported';

type Environment = 'required' | 'optional' | 'unsupported';

interface MrpackFile {
  path?: unknown;
  hashes?: { sha1?: unknown; sha512?: unknown };
  env?: { client?: unknown; server?: unknown };
  downloads?: unknown;
  fileSize?: unknown;
}

interface MrpackManifest {
  formatVersion?: unknown;
  game?: unknown;
  versionId?: unknown;
  name?: unknown;
  summary?: unknown;
  dependencies?: Record<string, unknown>;
  files?: unknown;
}

export interface PackFilePlan {
  path: string;
  filename: string;
  sha512: string;
  downloads: string[];
  size: number;
}

export interface OverridePlan {
  source: string;
  destination: string;
  layer: 'common-override' | 'server-override';
}

export interface PackInspection {
  readiness: PackReadiness;
  archivePath: string;
  name: string;
  summary: string;
  versionId: string;
  minecraft: string;
  runtime: ImportRuntime | null;
  loaderVersion: string;
  requiredFiles: PackFilePlan[];
  excludedClientFiles: string[];
  overrideFiles: OverridePlan[];
  blockedReasons: string[];
  source: { kind: 'local' | 'modrinth'; projectId?: string; versionId?: string };
}

export interface ModrinthPackHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  loaders: string[];
  versions: string[];
  environment: string[];
}

export interface ModrinthPackVersion {
  id: string;
  number: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  environment: string;
  releasedAt: string;
  fileName: string;
  fileUrl: string;
  sha512: string;
  size: number;
}

const USER_AGENT = 'atrueleeder-bot/aether-panel (https://github.com/atrueleeder-bot/aether-panel)';
const TRUSTED_DOWNLOAD_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const ALLOWED_OVERRIDE_ROOTS = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs', 'openloader']);
const ALLOWED_MANIFEST_ROOTS = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs', 'openloader']);
const CLIENT_ASSET_ROOTS = new Set(['shaderpacks', 'resourcepacks', 'screenshots']);
const CLIENT_COSMETIC_FILES = new Set(['options.txt', 'icon.png', 'instance.png', 'pack.png', 'mmc-pack.json', 'minecraftinstance.json']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe package path: ${value || '(empty path)'}.`);
  }
  return normalized;
}

function safeDestination(root: string, relative: string) {
  const destination = resolve(root, ...relative.split('/'));
  const prefix = resolve(root) + sep;
  if (!destination.startsWith(prefix)) throw new Error(`Package path escapes the managed workspace: ${relative}.`);
  return destination;
}

function allowedOverrideDestination(relative: string) {
  if (relative === 'server.properties') return true;
  const root = relative.split('/')[0];
  return ALLOWED_OVERRIDE_ROOTS.has(root);
}

function allowedManifestDestination(relative: string) {
  const root = relative.split('/')[0];
  return ALLOWED_MANIFEST_ROOTS.has(root);
}

function isClientAssetPath(relative: string) {
  const normalized = relative.toLowerCase();
  const root = normalized.split('/')[0];
  return CLIENT_ASSET_ROOTS.has(root) || CLIENT_COSMETIC_FILES.has(normalized);
}

function overrideJarIsClientOnly(data: Buffer) {
  try {
    const nested = new AdmZip(data);
    const fabric = nested.getEntry('fabric.mod.json');
    if (fabric) {
      const metadata = JSON.parse(fabric.getData().toString('utf8')) as { environment?: unknown };
      return metadata.environment === 'client';
    }
    const forge = nested.getEntry('META-INF/mods.toml');
    return Boolean(forge && /(?:^|\n)\s*clientSideOnly\s*=\s*true\s*(?:\n|$)/i.test(forge.getData().toString('utf8')));
  } catch {
    // The outer `.mrpack` checksum still protects the artifact; unsupported metadata is not treated as a client-only claim.
    return false;
  }
}

function readEnvironment(value: unknown): Environment | null {
  return value === 'required' || value === 'optional' || value === 'unsupported' ? value : null;
}

function filePlans(manifest: MrpackManifest) {
  const requiredFiles: PackFilePlan[] = [];
  const excludedClientFiles: string[] = [];
  const blockedReasons: string[] = [];
  if (!Array.isArray(manifest.files)) {
    blockedReasons.push('The manifest does not contain a files list.');
    return { requiredFiles, excludedClientFiles, blockedReasons };
  }

  for (const rawFile of manifest.files) {
    if (!isRecord(rawFile)) {
      blockedReasons.push('The manifest contains an invalid file declaration.');
      continue;
    }
    const file = rawFile as MrpackFile;
    const rawPath = asString(file.path);
    let path = '';
    try {
      path = safeRelativePath(rawPath);
    } catch (error) {
      blockedReasons.push(error instanceof Error ? error.message : 'The manifest contains an unsafe file path.');
      continue;
    }
    if (isClientAssetPath(path)) {
      excludedClientFiles.push(path);
      continue;
    }
    if (!allowedManifestDestination(path)) {
      blockedReasons.push(`The manifest file ${path} targets an unsupported server destination.`);
      continue;
    }

    const rawEnvironment = (rawFile as { env?: unknown }).env;
    const environment = isRecord(rawEnvironment) ? rawEnvironment : null;
    // In the Modrinth format, env is optional; an omitted env applies the file to both physical sides.
    const serverEnvironment = environment ? readEnvironment(environment.server) : 'required';
    if (serverEnvironment === 'unsupported') {
      excludedClientFiles.push(path);
      continue;
    }
    if (serverEnvironment !== 'required') {
      blockedReasons.push(`The server applicability of ${path} is optional or invalid; Aether requires a deterministic server file plan.`);
      continue;
    }

    const hashes = isRecord(file.hashes) ? file.hashes : {};
    const sha512 = asString(hashes.sha512).toLowerCase();
    if (!/^[a-f0-9]{128}$/.test(sha512)) {
      blockedReasons.push(`The required server file ${path} does not include a valid SHA-512 hash.`);
      continue;
    }
    const downloads = Array.isArray(file.downloads) ? file.downloads.filter((entry): entry is string => typeof entry === 'string') : [];
    if (!downloads.length) {
      blockedReasons.push(`The required server file ${path} does not provide an HTTPS download URL.`);
      continue;
    }
    try {
      for (const download of downloads) {
        const parsed = new URL(download);
        if (parsed.protocol !== 'https:' || !TRUSTED_DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error();
      }
    } catch {
      blockedReasons.push(`The required server file ${path} uses an untrusted download source.`);
      continue;
    }
    const size = Number(file.fileSize);
    if (!Number.isFinite(size) || size < 0 || size > 2_147_483_647) {
      blockedReasons.push(`The required server file ${path} does not include a safe file size.`);
      continue;
    }
    requiredFiles.push({ path, filename: basename(path), sha512, downloads, size });
  }
  return { requiredFiles, excludedClientFiles, blockedReasons };
}

function inspectOverrides(zip: AdmZip) {
  const overrideFiles: OverridePlan[] = [];
  const excludedClientFiles: string[] = [];
  const blockedReasons: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    let name = '';
    try {
      name = safeRelativePath(entry.entryName);
    } catch (error) {
      blockedReasons.push(error instanceof Error ? error.message : 'The archive contains an unsafe override path.');
      continue;
    }
    const match = /^(overrides|server-overrides|client-overrides)\/(.+)$/.exec(name);
    if (!match) continue;
    const [, layer, rawDestination] = match;
    let destination = '';
    try {
      destination = safeRelativePath(rawDestination);
    } catch (error) {
      blockedReasons.push(error instanceof Error ? error.message : 'The archive contains an unsafe override path.');
      continue;
    }
    if (layer === 'client-overrides') {
      excludedClientFiles.push(name);
      continue;
    }
    if (isClientAssetPath(destination)) {
      excludedClientFiles.push(name);
      continue;
    }
    const entryData = zip.getEntry(name)?.getData();
    if (destination.startsWith('mods/') && destination.toLowerCase().endsWith('.jar') && entryData && overrideJarIsClientOnly(entryData)) {
      excludedClientFiles.push(name);
      continue;
    }
    if (!allowedOverrideDestination(destination)) {
      blockedReasons.push(`The ${layer} entry ${destination} targets a protected or unsupported server path.`);
      continue;
    }
    overrideFiles.push({ source: name, destination, layer: layer === 'server-overrides' ? 'server-override' : 'common-override' });
  }
  return { overrideFiles, excludedClientFiles, blockedReasons };
}

export function inspectMrpack(archivePath: string, source: PackInspection['source']): PackInspection {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('This archive is not a Modrinth pack because modrinth.index.json is missing.');
  let manifest: MrpackManifest;
  try {
    manifest = JSON.parse(entry.getData().toString('utf8')) as MrpackManifest;
  } catch {
    throw new Error('The Modrinth pack manifest is not valid JSON.');
  }

  const blockedReasons: string[] = [];
  if (manifest.formatVersion !== 1) blockedReasons.push('This Modrinth pack format version is not supported.');
  if (manifest.game !== 'minecraft') blockedReasons.push('The package does not declare Minecraft as its game.');
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const minecraft = asString(dependencies.minecraft);
  const forge = asString(dependencies.forge);
  const fabric = asString(dependencies['fabric-loader']);
  const neoForge = asString(dependencies.neoforge);
  const quilt = asString(dependencies['quilt-loader']);
  let runtime: ImportRuntime | null = null;
  let loaderVersion = '';
  if (forge && !fabric && !neoForge && !quilt) {
    runtime = 'forge';
    loaderVersion = forge;
  } else if (fabric && !forge && !neoForge && !quilt) {
    runtime = 'fabric';
    loaderVersion = fabric;
  } else {
    blockedReasons.push('The package must declare exactly one supported server loader: Forge or Fabric.');
  }
  if (!minecraft || !/^[0-9A-Za-z._-]+$/.test(minecraft)) blockedReasons.push('The package does not declare a valid Minecraft version.');
  if (!asString(manifest.versionId)) blockedReasons.push('The package does not declare an immutable version ID.');
  if (!asString(manifest.name)) blockedReasons.push('The package does not declare a readable name.');

  const files = filePlans(manifest);
  const overrides = inspectOverrides(zip);
  blockedReasons.push(...files.blockedReasons, ...overrides.blockedReasons);

  return {
    readiness: blockedReasons.length ? 'unsupported' : 'server-ready',
    archivePath,
    name: asString(manifest.name) || 'Unnamed Modrinth pack',
    summary: asString(manifest.summary),
    versionId: asString(manifest.versionId),
    minecraft,
    runtime,
    loaderVersion,
    requiredFiles: files.requiredFiles,
    excludedClientFiles: [...files.excludedClientFiles, ...overrides.excludedClientFiles],
    overrideFiles: overrides.overrideFiles,
    blockedReasons,
    source,
  };
}

export async function applyOverrides(inspection: PackInspection, serverDirectory: string) {
  const zip = new AdmZip(inspection.archivePath);
  const ordered = [...inspection.overrideFiles].sort((left, right) => left.layer === right.layer ? left.source.localeCompare(right.source) : left.layer === 'common-override' ? -1 : 1);
  for (const item of ordered) {
    const entry = zip.getEntry(item.source);
    if (!entry) throw new Error(`The verified override ${item.source} is missing from the package.`);
    const destination = safeDestination(serverDirectory, item.destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.getData());
  }
}

export async function downloadMrpackVersion(projectId: string, version: ModrinthPackVersion, directory: string) {
  const target = join(directory, `${projectId}-${version.id}.mrpack`);
  await mkdir(directory, { recursive: true });
  const response = await fetch(version.fileUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`Unable to download the selected Modrinth pack (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target));
  return target;
}

export async function removeTemporaryPack(path: string) {
  await rm(path, { force: true });
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Modrinth request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function searchModrinthPacks(query: string, limit = 18): Promise<ModrinthPackHit[]> {
  const facets = [[`project_type:modpack`]];
  const params = new URLSearchParams({ query: query.trim(), limit: String(Math.min(Math.max(limit, 1), 30)), index: 'downloads', facets: JSON.stringify(facets) });
  const result = await apiJson<{ hits: Array<Record<string, unknown>> }>(`https://api.modrinth.com/v2/search?${params}`);
  return result.hits.map((hit) => ({
    projectId: asString(hit.project_id),
    slug: asString(hit.slug),
    title: asString(hit.title) || 'Untitled pack',
    description: asString(hit.description),
    author: asString(hit.author),
    iconUrl: typeof hit.icon_url === 'string' ? hit.icon_url : undefined,
    downloads: Number(hit.downloads) || 0,
    loaders: Array.isArray(hit.categories) ? hit.categories.filter((item): item is string => ['fabric', 'forge', 'neoforge', 'quilt'].includes(String(item))).map(String) : [],
    versions: Array.isArray(hit.versions) ? hit.versions.map(String) : [],
    environment: Array.isArray(hit.environment) ? hit.environment.map(String) : [],
  }));
}

export async function listModrinthPackVersions(projectId: string): Promise<ModrinthPackVersion[]> {
  const result = await apiJson<Array<Record<string, unknown>>>(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?include_changelog=false`);
  return result
    .filter((version) => version.status === 'listed' && version.version_type === 'release')
    .map((version) => {
      const files = Array.isArray(version.files) ? version.files.filter(isRecord) : [];
      const file = files.find((item) => typeof item.filename === 'string' && item.filename.toLowerCase().endsWith('.mrpack')) ?? files.find((item) => item.primary === true) ?? files[0];
      const hashes = file && isRecord(file.hashes) ? file.hashes : {};
      return {
        id: asString(version.id),
        number: asString(version.version_number),
        name: asString(version.name),
        gameVersions: Array.isArray(version.game_versions) ? version.game_versions.map(String) : [],
        loaders: Array.isArray(version.loaders) ? version.loaders.map(String) : [],
        environment: asString(version.environment),
        releasedAt: asString(version.date_published),
        fileName: asString(file?.filename),
        fileUrl: asString(file?.url),
        sha512: asString(hashes.sha512).toLowerCase(),
        size: Number(file?.size) || 0,
      };
    })
    .filter((version) => version.id && version.fileName.toLowerCase().endsWith('.mrpack') && version.fileUrl && /^[a-f0-9]{128}$/.test(version.sha512));
}
