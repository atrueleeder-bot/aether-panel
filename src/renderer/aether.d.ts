export type ServerType = 'paper' | 'spigot' | 'forge' | 'fabric' | 'vanilla';

export interface InstalledContent {
  projectId: string;
  title: string;
  filename: string;
  kind: 'mod' | 'plugin';
  installedAt: string;
}

export interface ManagedServer {
  id: string;
  name: string;
  type: ServerType;
  version: string;
  directory: string;
  jarPath: string;
  memory: number;
  port: number;
  createdAt: string;
  status: 'offline' | 'starting' | 'online' | 'stopping' | 'failed';
  installedMods: number;
  installedContent: InstalledContent[];
}

export interface RuntimeStatus {
  java: { found: boolean; detail: string };
  git: { found: boolean; detail: string };
}

export type UpdateChannel = 'stable' | 'preview';
export type UpdatePhase = 'unconfigured' | 'ready' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error' | 'development' | 'unsupported';

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

export interface ReleasePolicy {
  currentVersion: string;
  channels: Array<{ id: UpdateChannel; manifest: string; label: string }>;
  rollback: string;
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuPct: number;
  ramPct: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  disk: { usedPct: number; freeBytes: number; totalBytes: number };
}

export interface BuildEvent {
  phase: 'queued' | 'download' | 'install' | 'complete' | 'error';
  message: string;
  serverId?: string;
}

export interface ServerOutputEvent {
  serverId: string;
  line: string;
  kind: 'stdout' | 'stderr' | 'system';
}

export interface ModSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  follows: number;
  categories: string[];
  latest_version?: string;
  author?: string;
}

declare global {
  interface Window {
    aether: {
      chooseDirectory: () => Promise<string | null>;
      getServers: () => Promise<ManagedServer[]>;
      getVersions: () => Promise<string[]>;
      buildServer: (payload: {
        name: string;
        type: ServerType;
        version: string;
        directory: string;
        memory: number;
        port: number;
      }) => Promise<ManagedServer>;
      startServer: (id: string) => Promise<void>;
      stopServer: (id: string) => Promise<void>;
      sendCommand: (id: string, command: string) => Promise<void>;
      deleteServer: (id: string) => Promise<void>;
      checkRuntime: () => Promise<RuntimeStatus>;
      sampleResources: () => Promise<ResourceSnapshot>;
      installGit: () => Promise<{ found: boolean; detail: string }>;
      onGitInstallEvent: (callback: (event: { phase: 'checking' | 'downloading' | 'installing' | 'complete' | 'error'; message: string }) => void) => () => void;
      searchMods: (payload: { query: string; version: string; loader: string; contentType?: 'mod' | 'plugin'; limit?: number }) => Promise<ModSearchHit[]>;
      installMod: (payload: { serverId: string; projectId: string; title?: string; version: string; loader: string }) => Promise<{ filename: string; title: string; installedCount: number }>;
      getUpdateState: () => Promise<UpdateState>;
      saveUpdateSettings: (payload: { feedUrl: string; channel: UpdateChannel }) => Promise<UpdateState>;
      checkForUpdates: () => Promise<UpdateState>;
      downloadUpdate: () => Promise<UpdateState>;
      installUpdate: () => Promise<void>;
      getReleasePolicy: () => Promise<ReleasePolicy>;
      onUpdateEvent: (callback: (event: UpdateState) => void) => () => void;
      onServerState: (callback: (event: { serverId: string; status: ManagedServer['status'] }) => void) => () => void;
      onBuildEvent: (callback: (event: BuildEvent) => void) => () => void;
      onServerOutput: (callback: (event: ServerOutputEvent) => void) => () => void;
    };
  }
}
