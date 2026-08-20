import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  ArrowDownToLine,
  History,
  RefreshCw,
  RotateCcw,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  Download,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Layers3,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Network,
  PackagePlus,
  Play,
  Plus,
  Power,
  Search,
  SendHorizonal,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { BuildEvent, ManagedServer, ModSearchHit, ReleasePolicy, ResourceSnapshot, RuntimeStatus, ServerOutputEvent, ServerType, UpdateChannel, UpdateState } from './aether';
import './styles.css';

type View = 'overview' | 'server' | 'build' | 'discover' | 'console' | 'updates';

const serverTypeMeta: Record<ServerType, { label: string; accent: string; description: string; needsGit?: boolean; loader: string; contentType: 'mod' | 'plugin' }> = {
  paper: { label: 'Paper', accent: '#51d4ff', description: 'High-performance Java server with plugin ecosystem.', loader: 'bukkit', contentType: 'plugin' },
  spigot: { label: 'Spigot', accent: '#ffb15b', description: 'Officially built locally with Spigot BuildTools.', needsGit: true, loader: 'bukkit', contentType: 'plugin' },
  forge: { label: 'Forge', accent: '#a47aff', description: 'Classic mod-loader with an official server installer.', loader: 'forge', contentType: 'mod' },
  fabric: { label: 'Fabric', accent: '#8ff08b', description: 'Lightweight modded server via Fabric Meta.', loader: 'fabric', contentType: 'mod' },
  vanilla: { label: 'Vanilla', accent: '#e6edf8', description: 'Official Minecraft dedicated-server runtime.', loader: '', contentType: 'mod' },
};

const previewBridge: Window['aether'] = {
  chooseDirectory: async () => null,
  getServers: async () => [],
  getVersions: async () => ['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.19.4', '1.18.2'],
  buildServer: async () => { throw new Error('Server building is available only in the Windows desktop application.'); },
  startServer: async () => { throw new Error('Server control is available only in the Windows desktop application.'); },
  stopServer: async () => { throw new Error('Server control is available only in the Windows desktop application.'); },
  sendCommand: async () => { throw new Error('The local console is available only in the Windows desktop application.'); },
  deleteServer: async () => { throw new Error('Server control is available only in the Windows desktop application.'); },
  checkRuntime: async () => ({ java: { found: true, detail: 'Preview mode · verified inside the Electron desktop build' }, git: { found: true, detail: 'Preview mode · verified inside the Electron desktop build' } }),
  searchMods: async () => [],
  installMod: async () => { throw new Error('Compatible downloads are available only in the Windows desktop application.'); },
  installGit: async () => ({ found: false, detail: 'Git installation is available in the Windows desktop application.' }),
  getUpdateState: async () => ({ phase: 'development', message: 'Update checks are available in the installed Windows release, not in development preview.', currentVersion: '0.1.0', channel: 'stable', feedUrl: '' }),
  saveUpdateSettings: async ({ feedUrl, channel }) => ({ phase: 'development', message: 'Update feed configuration is saved only in the Windows desktop application.', currentVersion: '0.1.0', channel, feedUrl }),
  checkForUpdates: async () => ({ phase: 'development', message: 'Install a packaged Aether release to check for updates.', currentVersion: '0.1.0', channel: 'stable', feedUrl: '' }),
  downloadUpdate: async () => ({ phase: 'development', message: 'Install a packaged Aether release to download updates.', currentVersion: '0.1.0', channel: 'stable', feedUrl: '' }),
  installUpdate: async () => undefined,
  getReleasePolicy: async () => ({ currentVersion: '0.1.0', channels: [{ id: 'stable', manifest: 'latest.yml', label: 'Stable' }, { id: 'preview', manifest: 'beta.yml', label: 'Preview' }], rollback: 'Publish the last known-good code as a newer recovery release and retain previous installers.' }),
  onUpdateEvent: () => () => undefined,
  onGitInstallEvent: () => () => undefined,
  onServerState: () => () => undefined,
  onBuildEvent: () => () => undefined,
  onServerOutput: () => () => undefined,
};

if (!window.aether) {
  window.aether = previewBridge;
}

const defaultForm = {
  name: 'New Minecraft Server',
  type: 'paper' as ServerType,
  version: '1.21.4',
  directory: '',
  memory: 4096,
  port: 25565,
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function relativeTime(value: string) {
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function loaderFor(server?: ManagedServer) {
  return server ? serverTypeMeta[server.type].loader : 'fabric';
}

function App() {
  const [view, setView] = useState<View>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [servers, setServers] = useState<ManagedServer[]>([]);
  const [versions, setVersions] = useState<string[]>(['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.19.4', '1.18.2']);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [releasePolicy, setReleasePolicy] = useState<ReleasePolicy | null>(null);
  const [updateFeed, setUpdateFeed] = useState('');
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>('stable');
  const [updateAction, setUpdateAction] = useState<'saving' | 'checking' | 'downloading' | null>(null);
  const [resourceHistory, setResourceHistory] = useState<ResourceSnapshot[]>([]);
  const [gitInstalling, setGitInstalling] = useState(false);
  const [gitInstallMessage, setGitInstallMessage] = useState('');
  const [form, setForm] = useState(defaultForm);
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<BuildEvent[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<ServerOutputEvent[]>([]);
  const [consoleAtLatest, setConsoleAtLatest] = useState(true);
  const consoleOutputRef = useRef<HTMLDivElement>(null);
  const [consoleCommand, setConsoleCommand] = useState('');
  const [modQuery, setModQuery] = useState('');
  const [mods, setMods] = useState<ModSearchHit[]>([]);
  const [modsLoading, setModsLoading] = useState(false);
  const [installedProject, setInstalledProject] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? servers[0] ?? null,
    [servers, selectedServerId],
  );
  const onlineServers = servers.filter((server) => server.status === 'online').length;
  const totalMemory = servers.reduce((total, server) => total + server.memory, 0);
  const selectedMeta = serverTypeMeta[form.type];
  const selectedConsoleLines = consoleLines.filter((line) => line.serverId === selectedServer?.id);

  useEffect(() => {
    setConsoleAtLatest(true);
  }, [selectedServer?.id]);

  useEffect(() => {
    const output = consoleOutputRef.current;
    if (output && consoleAtLatest) output.scrollTop = output.scrollHeight;
  }, [consoleLines, selectedServer?.id, consoleAtLatest]);

  function handleConsoleScroll() {
    const output = consoleOutputRef.current;
    if (!output) return;
    const distanceFromLatest = output.scrollHeight - output.scrollTop - output.clientHeight;
    setConsoleAtLatest(distanceFromLatest <= 24);
  }

  function jumpToLatest() {
    const output = consoleOutputRef.current;
    if (!output) return;
    setConsoleAtLatest(true);
    output.scrollTo({ top: output.scrollHeight, behavior: 'smooth' });
  }

  function pushNotice(tone: 'success' | 'error', text: string) {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice(null), 4800);
  }

  async function refreshServers() {
    const result = await window.aether.getServers();
    setServers(result);
    if (!selectedServerId && result[0]) setSelectedServerId(result[0].id);
  }

  useEffect(() => {
    let active = true;
    const pollResources = async () => {
      try {
        const snapshot = await window.aether.sampleResources();
        if (active) setResourceHistory((items) => [...items, snapshot].slice(-60));
      } catch {
        // Resource telemetry is non-blocking; the dashboard remains usable if a sample fails.
      }
    };
    void pollResources();
    const resourceTimer = window.setInterval(() => void pollResources(), 1000);
    return () => {
      active = false;
      window.clearInterval(resourceTimer);
    };
  }, []);

  useEffect(() => {
    const dismissStartup = () => document.getElementById('startup-loading')?.classList.add('startup-done');
    const startupFallback = window.setTimeout(dismissStartup, 7500);
    void Promise.all([
      refreshServers(),
      window.aether.getUpdateState().then((update) => { setUpdateState(update); setUpdateFeed(update.feedUrl); setUpdateChannel(update.channel); }),
      window.aether.getReleasePolicy().then(setReleasePolicy),
      window.aether.getVersions().then((items) => {
        setVersions(items);
        if (items.length && !items.includes(form.version)) setForm((previous) => ({ ...previous, version: items[0] }));
      }),
      window.aether.checkRuntime().then(setRuntime),
    ]).catch((error: Error) => pushNotice('error', error.message)).finally(() => {
      window.clearTimeout(startupFallback);
      window.setTimeout(dismissStartup, 180);
    });
    const removeUpdateListener = window.aether.onUpdateEvent((event) => setUpdateState(event));
    const removeBuildListener = window.aether.onBuildEvent((event) => setBuildLog((items) => [...items.slice(-31), event]));
    const removeGitListener = window.aether.onGitInstallEvent((event) => setGitInstallMessage(event.message));
    const removeStateListener = window.aether.onServerState((event) => {
      setServers((items) => items.map((server) => server.id === event.serverId ? { ...server, status: event.status } : server));
      if (event.status === 'offline') pushNotice('success', 'Server shutdown acknowledged. The world is now offline.');
    });
    const removeOutputListener = window.aether.onServerOutput((event) => setConsoleLines((items) => [...items.slice(-500), event]));
    return () => {
      window.clearTimeout(startupFallback);
      removeUpdateListener();
      removeBuildListener();
      removeGitListener();
      removeStateListener();
      removeOutputListener();
    };
  }, []);

  async function saveUpdateFeed() {
    setUpdateAction('saving');
    try {
      const next = await window.aether.saveUpdateSettings({ feedUrl: updateFeed, channel: updateChannel });
      setUpdateState(next);
      pushNotice('success', 'Release feed saved. You can now check this channel for updates.');
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to save update settings.');
    } finally {
      setUpdateAction(null);
    }
  }

  async function checkUpdates() {
    setUpdateAction('checking');
    try {
      setUpdateState(await window.aether.checkForUpdates());
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to check for updates.');
    } finally {
      setUpdateAction(null);
    }
  }

  async function downloadAvailableUpdate() {
    setUpdateAction('downloading');
    try {
      setUpdateState(await window.aether.downloadUpdate());
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to download the update.');
    } finally {
      setUpdateAction(null);
    }
  }

  async function installAvailableUpdate() {
    try {
      await window.aether.installUpdate();
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to start the update installer.');
    }
  }

  async function installGit() {
    setGitInstalling(true);
    setGitInstallMessage('Preparing the official Git for Windows installer…');
    try {
      const result = await window.aether.installGit();
      setRuntime((current) => current ? { ...current, git: result } : current);
      pushNotice('success', 'Git is installed and ready for Spigot builds.');
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Git installation failed.');
    } finally {
      setGitInstalling(false);
      setGitInstallMessage('');
    }
  }

  async function selectDirectory() {
    const directory = await window.aether.chooseDirectory();
    if (directory) setForm((current) => ({ ...current, directory }));
  }

  async function buildServer() {
    if (!form.directory) {
      pushNotice('error', 'Choose a parent folder for the local server before building.');
      return;
    }
    setBuilding(true);
    setBuildLog([{ phase: 'queued', message: `Build request created for ${form.name}.` }]);
    try {
      const server = await window.aether.buildServer(form);
      await refreshServers();
      setSelectedServerId(server.id);
      setView('server');
      pushNotice('success', `${server.name} is ready for its first start.`);
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'The server build did not complete.');
    } finally {
      setBuilding(false);
    }
  }

  function openServer(server: ManagedServer) {
    setSelectedServerId(server.id);
    setView('server');
  }

  function openConsole(server: ManagedServer) {
    setSelectedServerId(server.id);
    setView('console');
  }

  function openDiscovery(server: ManagedServer) {
    setSelectedServerId(server.id);
    setView('discover');
  }

  async function start(server: ManagedServer, showConsole = true) {
    try {
      await window.aether.startServer(server.id);
      await refreshServers();
      setSelectedServerId(server.id);
      if (showConsole) setView('console');
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to start this server.');
    }
  }

  async function stop(server: ManagedServer) {
    try {
      await window.aether.stopServer(server.id);
      await refreshServers();
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to stop this server.');
    }
  }

  async function removeServer(server: ManagedServer) {
    if (!window.confirm(`Remove “${server.name}” from Aether Panel? Its local files will remain untouched.`)) return;
    try {
      await window.aether.deleteServer(server.id);
      setSelectedServerId(null);
      setView('overview');
      await refreshServers();
      pushNotice('success', `${server.name} was removed from the panel. Its files were not deleted.`);
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to remove this server.');
    }
  }

  async function sendConsoleCommand(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedServer || !consoleCommand.trim()) return;
    try {
      await window.aether.sendCommand(selectedServer.id, consoleCommand);
      setConsoleCommand('');
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Unable to send the console command.');
    }
  }

  async function searchMods() {
    const loader = loaderFor(selectedServer);
    if (!selectedServer) {
      pushNotice('error', 'Create or select a server before searching compatible content.');
      return;
    }
    if (selectedServer.type === 'vanilla') {
      pushNotice('error', 'Vanilla servers do not support a mod loader. Create Fabric or Forge for mod discovery.');
      return;
    }
    setModsLoading(true);
    try {
      const results = await window.aether.searchMods({
        query: modQuery,
        version: selectedServer.version,
        loader,
        contentType: serverTypeMeta[selectedServer.type].contentType,
        limit: 18,
      } as never);
      setMods(results);
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'Compatible search was unavailable.');
    } finally {
      setModsLoading(false);
    }
  }

  async function installMod(projectId: string) {
    if (!selectedServer) return;
    setInstalledProject(projectId);
    try {
      const mod = mods.find((item) => item.project_id === projectId);
      const result = await window.aether.installMod({
        serverId: selectedServer.id,
        projectId,
        title: mod?.title,
        version: selectedServer.version,
        loader: loaderFor(selectedServer),
      });
      await refreshServers();
      pushNotice('success', `${result.title} installed in ${selectedServer.name}. ${result.installedCount} ${result.installedCount === 1 ? 'item' : 'items'} tracked.`);
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : 'The compatible download could not be installed.');
    } finally {
      setInstalledProject(null);
    }
  }

  const installedProjectIds = new Set((selectedServer?.installedContent ?? []).map((item) => item.projectId));

  const navigation: Array<{ id: View; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: 'Mission control', icon: Activity },
    { id: 'build', label: 'Server foundry', icon: Box },
    { id: 'discover', label: 'Compatible discovery', icon: Sparkles },
    { id: 'console', label: 'Live console', icon: TerminalSquare },
    { id: 'updates', label: 'Updates & rollback', icon: History },
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark"><Zap size={20} strokeWidth={2.5} /></div>
          <div>
            <strong>Aether</strong>
            <span>LOCAL SERVER OS</span>
          </div>
          <button className="mobile-close icon-button" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <nav className="navigation">
          <p className="nav-kicker">CONTROL ROOM</p>
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-button ${view === item.id || (item.id === 'overview' && view === 'server') ? 'active' : ''}`} onClick={() => { setView(item.id); setSidebarOpen(false); }}>
              <Icon size={18} /><span>{item.label}</span>{item.id === 'console' && onlineServers > 0 && <i>{onlineServers}</i>}
            </button>;
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="runtime-pill"><span className={runtime?.java.found ? 'status-dot online' : 'status-dot alert'}></span><span>{runtime?.java.found ? 'Java runtime ready' : 'Java needs attention'}</span></div>
          <button className="support-link" onClick={() => setView('build')}><Settings2 size={16} /> Runtime & setup <ChevronRight size={14} /></button>
        </div>
      </aside>
      <main className="main-stage">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="breadcrumb"><span>Windows local</span><ChevronRight size={14}/><strong>{view === 'overview' ? 'Mission control' : view === 'server' ? selectedServer?.name ?? 'Server details' : view === 'build' ? 'Server foundry' : view === 'discover' ? 'Compatible discovery' : view === 'console' ? 'Live console' : 'Updates & rollback'}</strong></div>
          <div className="top-actions">
            <div className="local-badge"><ShieldCheck size={15}/><span>Private by design</span></div>
            <button className="primary-button compact" onClick={() => setView('build')}><Plus size={17}/> New server</button>
          </div>
        </header>

        {view === 'overview' && <section className="content-area overview-view">
          <div className="hero-row">
            <div>
              <p className="eyebrow"><span></span> SYSTEM NOMINAL</p>
              <h1>Own the <em>local</em> experience.</h1>
              <p className="hero-copy">Build, operate, and evolve Minecraft worlds from one private Windows workstation. No browser panel. No remote command plane.</p>
            </div>
            <div className="hero-actions">
              <button className="primary-button" onClick={() => setView('build')}><Box size={18}/> Forge a server</button>
              <button className="ghost-button" onClick={() => setView('discover')}><Sparkles size={18}/> Explore compatible content</button>
            </div>
          </div>

          <div className="metric-grid">
            <MetricCard icon={<Server size={19}/>} value={String(servers.length).padStart(2, '0')} label="Managed worlds" detail={`${onlineServers} actively running`} accent="#51d4ff" />
            <MetricCard icon={<Power size={19}/>} value={String(onlineServers).padStart(2, '0')} label="Live processes" detail={onlineServers ? 'Console ready' : 'Awaiting first start'} accent="#8ff08b" />
            <MetricCard icon={<Cpu size={19}/>} value={`${Math.round(totalMemory / 1024) || 0} GB`} label="Reserved memory" detail="Configured across fleet" accent="#a47aff" />
            <MetricCard icon={<Layers3 size={19}/>} value={String(servers.reduce((sum, server) => sum + server.installedMods, 0)).padStart(2, '0')} label="Installed content" detail="Tracked compatible packages" accent="#ffb15b" />
          </div>

          <div className="section-heading">
            <div><p className="eyebrow"><span></span> FLEET</p><h2>Managed worlds</h2></div>
            <button className="text-button" onClick={() => setView('build')}>Create a server <ArrowUpRight size={16}/></button>
          </div>
          {servers.length ? <div className="server-list">{servers.map((server) => <ServerRow key={server.id} server={server} selected={selectedServer?.id === server.id} onSelect={() => openServer(server)} onConsole={() => openConsole(server)} onStart={() => start(server)} onStop={() => stop(server)} onRemove={() => removeServer(server)} />)}</div> : <EmptyFleet onBuild={() => setView('build')} />}

          <ResourceMonitor history={resourceHistory} />

          <div className="lower-grid">
            <div className="glass-card runtime-card">
              <div className="card-topline"><div><p className="eyebrow"><span></span> READINESS</p><h3>Local foundation</h3></div><Network size={19}/></div>
              <RuntimeItem label="Java runtime" detail={runtime?.java.detail ?? 'Checking local environment…'} ready={Boolean(runtime?.java.found)} />
              <RuntimeItem label="Git for Spigot" detail={gitInstalling ? gitInstallMessage : (runtime?.git.detail ?? 'Checking local environment…')} ready={Boolean(runtime?.git.found)} action={runtime && !runtime.git.found && !gitInstalling ? <button className="install-tool-button" onClick={installGit}><Download size={14}/> Install</button> : gitInstalling ? <span className="installing-tool"><LoaderCircle className="spin" size={14}/> Working</span> : undefined} />
              <p className="card-note">Git is only needed when building Spigot. Aether can install the official Git for Windows package for you.</p>
            </div>
            <div className="glass-card insight-card">
              <div className="aurora"></div>
              <p className="eyebrow"><span></span> DISCOVERY ENGINE</p>
              <h3>Match content to the runtime you actually deploy.</h3>
              <p>Search Modrinth with your selected server’s Minecraft version and loader already applied. Only compatible releases are offered for installation.</p>
              <button className="ghost-button light" onClick={() => setView('discover')}><Search size={17}/> Search compatibility</button>
            </div>
          </div>
        </section>}

        {view === 'build' && <section className="content-area build-view">
          <div className="section-intro"><p className="eyebrow"><span></span> SERVER FOUNDRY</p><h1>Build with intention.</h1><p>Choose a runtime, pin a Minecraft release, and keep every build inside a local workspace you control.</p></div>
          <div className="builder-layout">
            <div className="build-form glass-card">
              <div className="form-section-title"><span>01</span><div><h3>Select runtime</h3><p>All downloads originate from documented official sources.</p></div></div>
              <div className="runtime-select-grid">
                {(Object.keys(serverTypeMeta) as ServerType[]).map((type) => {
                  const meta = serverTypeMeta[type];
                  return <button key={type} className={`runtime-choice ${form.type === type ? 'selected' : ''}`} style={{ '--runtime-accent': meta.accent } as React.CSSProperties} onClick={() => setForm((current) => ({ ...current, type }))}>
                    <span className="runtime-dot"></span><strong>{meta.label}</strong><small>{meta.description}</small>{form.type === type && <Check size={16} className="choice-check" />}
                  </button>;
                })}
              </div>
              <div className="form-section-title top-gap"><span>02</span><div><h3>Shape the world</h3><p>These settings become a managed local server profile.</p></div></div>
              <div className="form-grid">
                <label className="field full"><span>World name</span><input value={form.name} maxLength={48} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
                <label className="field"><span>Minecraft release</span><select value={form.version} onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))}>{versions.map((version) => <option key={version}>{version}</option>)}</select></label>
                <label className="field"><span>Memory ceiling</span><div className="suffix-input"><input type="number" min="1024" max="65536" step="512" value={form.memory} onChange={(event) => setForm((current) => ({ ...current, memory: Number(event.target.value) }))}/><span>MB</span></div></label>
                <label className="field"><span>Game port</span><input type="number" min="1024" max="65535" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: Number(event.target.value) }))}/></label>
                <label className="field full"><span>Workspace parent folder</span><div className="directory-input"><input value={form.directory} placeholder="Choose where this server will live" readOnly/><button type="button" onClick={selectDirectory}><FolderOpen size={17}/> Browse</button></div></label>
              </div>
              <div className="build-footer"><div className="build-note"><CircleAlert size={16}/><span>{form.type === 'spigot' ? 'Spigot compiles locally. First builds may take several minutes.' : form.type === 'forge' ? 'Forge runs its official installer locally after download.' : `A stable ${selectedMeta.label} build will be resolved at build time.`}</span></div><button className="primary-button" disabled={building} onClick={buildServer}>{building ? <LoaderCircle className="spin" size={18}/> : <Zap size={18}/>} {building ? 'Forging server…' : 'Build local server'}</button></div>
            </div>
            <aside className="build-telemetry glass-card">
              <div className="card-topline"><div><p className="eyebrow"><span></span> BUILD TELEMETRY</p><h3>Process stream</h3></div><TerminalSquare size={19}/></div>
              <div className="telemetry-status"><span className={building ? 'pulse-dot' : 'status-dot'}></span><strong>{building ? 'Building in local workspace' : 'Ready for a controlled build'}</strong></div>
              <div className="build-log">{buildLog.length ? buildLog.map((event, index) => <div key={`${event.message}-${index}`} className={`log-line ${event.phase}`}><span>{event.phase === 'error' ? '!' : event.phase === 'complete' ? '✓' : '›'}</span><p>{event.message}</p></div>) : <div className="log-empty"><TerminalSquare size={23}/><p>Your build steps, downloads, and local tool output will appear here.</p></div>}</div>
              <div className="source-list"><p>Verified build routes</p><span><Check size={14}/> Mojang / Paper / Fabric Meta</span><span><Check size={14}/> Forge Maven installer</span><span><Check size={14}/> Spigot BuildTools</span></div>
            </aside>
          </div>
        </section>}

        {view === 'server' && <section className="content-area server-detail-view">
          {selectedServer ? <>
            <div className="detail-back-row"><button className="text-button" onClick={() => setView('overview')}><ChevronRight className="back-chevron" size={16}/> Back to Mission control</button></div>
            <div className="server-detail-hero">
              <div><p className="eyebrow"><span></span> MANAGED WORLD</p><h1>{selectedServer.name}</h1><p>{serverTypeMeta[selectedServer.type].label} {selectedServer.version} · local port {selectedServer.port} · created {relativeTime(selectedServer.createdAt)}</p></div>
              <div className="server-detail-actions"><span className={`status-label ${selectedServer.status}`}><i></i>{selectedServer.status}</span>{selectedServer.status === 'online' ? <button className="danger-button" onClick={() => stop(selectedServer)}><Square size={16}/> Stop world</button> : <button className="primary-button" onClick={() => start(selectedServer, false)}><Play size={16}/> Start world</button>}</div>
            </div>
            <div className="server-detail-grid">
              <div className="server-profile-card glass-card">
                <div className="card-topline"><div><p className="eyebrow"><span></span> SERVER PROFILE</p><h3>Local deployment details</h3></div><Server size={20}/></div>
                <div className="server-profile-stats"><div><span>RUNTIME</span><strong>{serverTypeMeta[selectedServer.type].label}</strong><small>{serverTypeMeta[selectedServer.type].description}</small></div><div><span>MINECRAFT</span><strong>{selectedServer.version}</strong><small>Managed local runtime</small></div><div><span>MEMORY</span><strong>{selectedServer.memory / 1024 >= 1 ? `${selectedServer.memory / 1024} GB` : `${selectedServer.memory} MB`}</strong><small>Configured ceiling</small></div><div><span>PORT</span><strong>{selectedServer.port}</strong><small>localhost:{selectedServer.port}</small></div></div>
                <div className="server-workspace"><FolderOpen size={17}/><div><span>WORKSPACE</span><strong>{selectedServer.directory}</strong></div></div>
              </div>
              <aside className="server-command-card glass-card"><p className="eyebrow"><span></span> COMMAND DECK</p><h3>Operate this world.</h3><p>Move from configuration to console and compatible content without losing the selected server.</p><button className="primary-button full-width" onClick={() => openConsole(selectedServer)}><TerminalSquare size={17}/> Open live console</button><button className="ghost-button full-width" onClick={() => openDiscovery(selectedServer)}><Sparkles size={17}/> Find compatible content</button><button className="remove-server-button" onClick={() => removeServer(selectedServer)}><Trash2 size={15}/> Remove from panel</button></aside>
            </div>
            <ServerInventory server={selectedServer} />
          </> : <div className="discovery-empty glass-card"><div className="empty-orb"><Server size={26}/></div><h3>Select a managed world</h3><p>Return to Mission Control and choose a world to inspect its local profile, content inventory, and command deck.</p><button className="primary-button" onClick={() => setView('overview')}><Activity size={18}/> Open Mission control</button></div>}
        </section>}

        {view === 'discover' && <section className="content-area discover-view">
          <div className="section-intro"><p className="eyebrow"><span></span> COMPATIBLE DISCOVERY</p><h1>Search what will <em>actually run.</em></h1><p>Every search binds to one local server’s loader and Minecraft release before it reaches the catalog.</p></div>
          <div className="discovery-toolbar glass-card">
            <div className="server-picker"><span>Target server</span><select value={selectedServer?.id ?? ''} onChange={(event) => setSelectedServerId(event.target.value)} disabled={!servers.length}>{servers.length ? servers.map((server) => <option value={server.id} key={server.id}>{server.name} · {serverTypeMeta[server.type].label} {server.version}</option>) : <option>No local servers yet</option>}</select></div>
            <form className="mod-search" onSubmit={(event) => { event.preventDefault(); void searchMods(); }}><Search size={20}/><input value={modQuery} onChange={(event) => setModQuery(event.target.value)} placeholder={selectedServer ? `Search ${serverTypeMeta[selectedServer.type].contentType === 'plugin' ? 'plugins' : 'mods'} for ${selectedServer.version}` : 'Create a server to begin'} disabled={!selectedServer}/><button disabled={modsLoading || !selectedServer}>{modsLoading ? <LoaderCircle className="spin" size={17}/> : 'Search catalog'}</button></form>
            {selectedServer && <div className="compatibility-chip"><ShieldCheck size={15}/><span>{serverTypeMeta[selectedServer.type].label} · {selectedServer.version}</span></div>}
          </div>
          {selectedServer && selectedServer.type === 'vanilla' && <div className="inline-warning"><CircleAlert size={18}/><span>Vanilla has no mod-loader compatibility filter. Create a Fabric or Forge server to discover installable mods.</span><button onClick={() => setView('build')}>Build modded server</button></div>}
          {modsLoading ? <div className="mod-loading"><LoaderCircle className="spin" size={28}/><span>Resolving current compatibility graph…</span></div> : mods.length ? <div className="mod-grid">{mods.map((mod) => <ModCard key={mod.project_id} mod={mod} isInstalling={installedProject === mod.project_id} installed={installedProjectIds.has(mod.project_id)} onInstall={() => installMod(mod.project_id)} mode={selectedServer ? serverTypeMeta[selectedServer.type].contentType : 'mod'} />)}</div> : <div className="discovery-empty glass-card"><div className="empty-orb"><Sparkles size={26}/></div><h3>{selectedServer ? 'Ready for a precise search' : 'Your compatibility graph starts with a server'}</h3><p>{selectedServer ? `Search popular ${serverTypeMeta[selectedServer.type].contentType === 'plugin' ? 'plugins' : 'mods'} or leave the search blank to surface leading ${serverTypeMeta[selectedServer.type].contentType === 'plugin' ? 'plugins' : 'mods'} for ${selectedServer.version}.` : 'Build a local Fabric, Forge, Paper, or Spigot server, then discover content that matches it.'}</p>{!selectedServer && <button className="primary-button" onClick={() => setView('build')}><Box size={18}/> Start with a server</button>}</div>}
        </section>}

        {view === 'updates' && <section className="content-area updates-view">
          <div className="section-intro"><p className="eyebrow"><span></span> RELEASE CONTROL</p><h1>Update with a <em>way back.</em></h1><p>Manage your release feed, use Stable or Preview deliberately, and keep recovery releases visible instead of replacing executables by hand.</p></div>
          <div className="updates-grid"><div className="update-card glass-card"><div className="update-card-head"><div><p className="eyebrow"><span></span> CURRENT RELEASE</p><h3>Version {updateState?.currentVersion ?? '—'}</h3></div><span className={`update-phase ${updateState?.phase ?? 'unconfigured'}`}>{updateState?.phase?.replace(/-/g, ' ') ?? 'loading'}</span></div><p className="update-message">{updateState?.message ?? 'Loading update service state…'}</p>{updateState?.progress !== undefined && <div className="update-progress"><span style={{ width: `${Math.max(0, Math.min(100, updateState.progress))}%` }}></span><small>{Math.round(updateState.progress)}%</small></div>}{updateState?.availableVersion && <div className="available-release"><Download size={17}/><div><strong>Version {updateState.availableVersion}</strong><p>{updateState.releaseNotes || 'Release notes were not supplied by the feed.'}</p></div></div>}<div className="update-actions">{updateState?.phase === 'available' && <button className="primary-button" disabled={updateAction === 'downloading'} onClick={downloadAvailableUpdate}>{updateAction === 'downloading' ? <LoaderCircle className="spin" size={17}/> : <Download size={17}/>} Download update</button>}{updateState?.phase === 'downloaded' && <button className="primary-button" onClick={installAvailableUpdate}><RefreshCw size={17}/> Restart & install</button>}<button className="ghost-button" disabled={updateAction === 'checking' || updateState?.phase === 'development' || updateState?.phase === 'unsupported' || !updateState?.feedUrl} onClick={checkUpdates}>{updateAction === 'checking' ? <LoaderCircle className="spin" size={17}/> : <RefreshCw size={17}/>} Check for updates</button></div></div><div className="update-card glass-card"><div className="update-card-head"><div><p className="eyebrow"><span></span> RELEASE FEED</p><h3>Channel configuration</h3></div><Settings2 size={19}/></div><label className="field"><span>HTTPS release feed</span><input value={updateFeed} onChange={(event) => setUpdateFeed(event.target.value)} placeholder="https://updates.example.com/aether" /></label><div className="channel-select"><button className={updateChannel === 'stable' ? 'selected' : ''} onClick={() => setUpdateChannel('stable')}><ShieldCheck size={16}/><div><strong>Stable</strong><span>Known-good releases only</span></div></button><button className={updateChannel === 'preview' ? 'selected' : ''} onClick={() => setUpdateChannel('preview')}><Sparkles size={16}/><div><strong>Preview</strong><span>Beta releases plus Stable</span></div></button></div><button className="primary-button full-width" disabled={updateAction === 'saving'} onClick={saveUpdateFeed}>{updateAction === 'saving' ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} Save release configuration</button></div></div>
          <div className="rollback-card glass-card"><div className="rollback-icon"><RotateCcw size={20}/></div><div><p className="eyebrow"><span></span> ROLLBACK POLICY</p><h3>Recover without unsafe downgrades.</h3><p>{releasePolicy?.rollback ?? 'Loading release policy…'}</p></div><div className="release-manifests">{releasePolicy?.channels.map((channel) => <span key={channel.id}>{channel.label} · {channel.manifest}</span>)}</div></div>
        </section>}

        {view === 'console' && <section className="content-area console-view">
          <div className="console-header"><div><p className="eyebrow"><span></span> LIVE CONSOLE</p><h1>{selectedServer?.name ?? 'Select a world'}</h1><p>{selectedServer ? `${serverTypeMeta[selectedServer.type].label} ${selectedServer.version} · ${selectedServer.memory} MB reserved · localhost:${selectedServer.port}` : 'Create or select a managed local server to begin.'}</p></div>{selectedServer && <div className="console-header-actions"><span className={`status-label ${selectedServer.status}`}><i></i>{selectedServer.status}</span>{selectedServer.status === 'online' ? <button className="danger-button" onClick={() => stop(selectedServer)}><Square size={16}/> Stop world</button> : <button className="primary-button" onClick={() => start(selectedServer)}><Play size={16}/> Start world</button>}</div>}</div>
          {servers.length > 1 && <div className="console-tabs">{servers.map((server) => <button key={server.id} className={selectedServer?.id === server.id ? 'active' : ''} onClick={() => setSelectedServerId(server.id)}><span style={{ background: serverTypeMeta[server.type].accent }}></span>{server.name}<i className={server.status}></i></button>)}</div>}
          <div className="console-shell glass-card"><div className="console-top"><div><span className="terminal-dots"><i></i><i></i><i></i></span><strong>Local process output</strong></div><span>{selectedServer?.status === 'online' ? 'STREAMING' : 'WAITING'}</span></div><div ref={consoleOutputRef} className="terminal-output" onScroll={handleConsoleScroll}>{selectedConsoleLines.length ? selectedConsoleLines.map((line, index) => <p key={`${line.line}-${index}`} className={line.kind}><span>{line.kind === 'system' ? '◆' : line.kind === 'stderr' ? '!' : '›'}</span>{line.line}</p>) : <div className="terminal-empty"><TerminalSquare size={30}/><p>{selectedServer ? 'Start this world to stream the local process output.' : 'No local world selected.'}</p></div>}</div>{!consoleAtLatest && selectedConsoleLines.length > 0 && <button className="latest-button" onClick={jumpToLatest}><ArrowDownToLine size={15}/> Latest</button>}<form className="console-input" onSubmit={sendConsoleCommand}><span>›</span><input value={consoleCommand} onChange={(event) => setConsoleCommand(event.target.value)} placeholder={selectedServer?.status === 'online' ? 'Enter a Minecraft console command…' : 'Start a server to enable console commands'} disabled={selectedServer?.status !== 'online'}/><button disabled={selectedServer?.status !== 'online' || !consoleCommand.trim()}><SendHorizonal size={17}/></button></form></div>
        </section>}
      </main>
      {notice && <div className={`notice ${notice.tone}`}><span>{notice.tone === 'success' ? <Check size={17}/> : <CircleAlert size={17}/>}</span><p>{notice.text}</p><button onClick={() => setNotice(null)}><X size={16}/></button></div>}
    </div>
  );
}

function ResourceMonitor({ history }: { history: ResourceSnapshot[] }) {
  const latest = history.at(-1);
  const chartWidth = 640;
  const chartHeight = 190;
  const graphTop = 16;
  const graphBottom = 166;
  const makePath = (values: number[]) => values.map((value, index) => {
    const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * chartWidth;
    const y = graphBottom - (Math.max(0, Math.min(100, value)) / 100) * (graphBottom - graphTop);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const cpuValues = history.map((item) => item.cpuPct);
  const ramValues = history.map((item) => item.ramPct);
  const diskValues = history.map((item) => item.disk.usedPct);
  const formatBytes = (bytes: number) => {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  };
  return <div className="resource-monitor glass-card">
    <div className="resource-monitor-head"><div><p className="eyebrow"><span></span> HOST TELEMETRY</p><h3>Resource pulse</h3><p className="resource-subtitle">Live workstation utilization · 60 second window</p></div><div className={`live-indicator ${latest ? '' : 'syncing'}`}><i></i> {latest ? 'LIVE' : 'SYNCING'} <span>{latest ? new Date(latest.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span></div></div>
    <div className="resource-monitor-body"><div className="resource-chart"><svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="Live CPU, RAM, and disk usage graph"><defs><linearGradient id="resourceGlow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#6dceff" stopOpacity=".16"/><stop offset="1" stopColor="#6dceff" stopOpacity="0"/></linearGradient></defs>{[0, 25, 50, 75, 100].map((level) => { const y = graphBottom - (level / 100) * (graphBottom - graphTop); return <line key={level} x1="0" x2={chartWidth} y1={y} y2={y} className="chart-gridline" />; })}<path d={cpuValues.length ? `${makePath(cpuValues)} L ${chartWidth} ${graphBottom} L 0 ${graphBottom} Z` : ''} className="chart-area"/><path d={makePath(cpuValues)} className="chart-line cpu"/><path d={makePath(ramValues)} className="chart-line ram"/><path d={makePath(diskValues)} className="chart-line disk"/></svg><div className="chart-scale"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>{!history.length && <div className="chart-empty"><LoaderCircle className="spin" size={18}/> Sampling local metrics…</div>}</div><div className="resource-stats"><ResourceStat label="CPU" value={latest ? `${latest.cpuPct.toFixed(1)}%` : '—'} detail="system load" color="cpu" icon={<Cpu size={16}/>} /><ResourceStat label="RAM" value={latest ? `${latest.ramPct.toFixed(1)}%` : '—'} detail={latest ? `${formatBytes(latest.ramUsedBytes)} / ${formatBytes(latest.ramTotalBytes)}` : 'awaiting sample'} color="ram" icon={<Activity size={16}/>} /><ResourceStat label="DISK" value={latest ? `${latest.disk.usedPct.toFixed(1)}%` : '—'} detail={latest ? `${formatBytes(latest.disk.freeBytes)} free` : 'awaiting sample'} color="disk" icon={<HardDrive size={16}/>} /></div></div>
  </div>;
}

function ResourceStat({ label, value, detail, color, icon }: { label: string; value: string; detail: string; color: 'cpu' | 'ram' | 'disk'; icon: React.ReactNode }) {
  return <div className={`resource-stat ${color}`}><div className="resource-stat-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function MetricCard({ icon, value, label, detail, accent }: { icon: React.ReactNode; value: string; label: string; detail: string; accent: string }) {
  return <div className="metric-card glass-card" style={{ '--metric-accent': accent } as React.CSSProperties}><div className="metric-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span><small>{detail}</small></div></div>;
}

function RuntimeItem({ label, detail, ready, optional = false, action }: { label: string; detail: string; ready: boolean; optional?: boolean; action?: React.ReactNode }) {
  return <div className="runtime-item"><span className={`status-dot ${ready ? 'online' : 'alert'}`}></span><div><strong>{label}{optional && <small> Optional except Spigot</small>}</strong><p>{detail}</p></div>{action ?? (ready ? <Check size={17}/> : <CircleAlert size={17}/>)}</div>;
}

function EmptyFleet({ onBuild }: { onBuild: () => void }) {
  return <div className="empty-fleet glass-card"><div className="empty-orb"><Gamepad2 size={28}/></div><div><h3>Your first world belongs here.</h3><p>Choose a popular runtime, set its local destination, and Aether will make the build path visible from download to launch.</p></div><button className="primary-button" onClick={onBuild}><Plus size={17}/> Forge first server</button></div>;
}

function ServerRow({ server, selected, onSelect, onConsole, onStart, onStop, onRemove }: { server: ManagedServer; selected: boolean; onSelect: () => void; onConsole: () => void; onStart: () => void; onStop: () => void; onRemove: () => void }) {
  const meta = serverTypeMeta[server.type];
  const installedContent = server.installedContent ?? [];
  return <div className={`server-row glass-card ${selected ? 'selected' : ''}`} onClick={onSelect}><div className="server-type" style={{ '--type-accent': meta.accent } as React.CSSProperties}><span></span><strong>{meta.label}</strong></div><div className="server-name"><h3>{server.name}</h3><p>{server.version} · local port {server.port} · created {relativeTime(server.createdAt)}</p></div><div className="server-resource"><Cpu size={15}/><span>{server.memory / 1024 >= 1 ? `${server.memory / 1024} GB` : `${server.memory} MB`}</span></div><div className="server-resource"><PackagePlus size={15}/><span>{installedContent.length} content</span></div><div className={`status-label ${server.status}`}><i></i>{server.status}</div><div className="row-actions"><button className="row-icon" title="Open server details" onClick={(event) => { event.stopPropagation(); onSelect(); }}><PackagePlus size={17}/></button><button className="row-icon" title="Open live console" onClick={(event) => { event.stopPropagation(); onConsole(); }}><TerminalSquare size={17}/></button>{server.status === 'online' ? <button className="row-icon stop" title="Stop server" onClick={(event) => { event.stopPropagation(); onStop(); }}><Square size={16}/></button> : <button className="row-icon play" title="Start server" onClick={(event) => { event.stopPropagation(); onStart(); }}><Play size={16}/></button>}<button className="row-icon delete" title="Remove server from panel" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Trash2 size={16}/></button><button className="row-icon more" title="More options"><MoreHorizontal size={18}/></button></div></div>;
}

function ServerInventory({ server }: { server: ManagedServer }) {
  const installedContent = server.installedContent ?? [];
  return <div className="server-inventory glass-card"><div className="inventory-heading"><div><p className="eyebrow"><span></span> INSTALLED CONTENT</p><h3>{installedContent.length ? `${installedContent.length} installed ${installedContent.length === 1 ? 'item' : 'items'}` : 'No installed content yet'}</h3></div><span className="inventory-path">{server.type === 'paper' || server.type === 'spigot' ? 'plugins' : 'mods'}</span></div>{installedContent.length ? <div className="inventory-grid">{installedContent.map((item) => <div className="inventory-item" key={`${item.projectId}-${item.filename}`}><div className="inventory-icon"><PackagePlus size={15}/></div><div><strong>{item.title}</strong><p>{item.filename} · installed {relativeTime(item.installedAt)}</p></div><span>{item.kind}</span></div>)}</div> : <p className="inventory-empty">Install compatible content from Discovery and it will be acknowledged here immediately.</p>}</div>;
}

function ModCard({ mod, isInstalling, installed, onInstall, mode }: { mod: ModSearchHit; isInstalling: boolean; installed: boolean; onInstall: () => void; mode: 'mod' | 'plugin' }) {
  return <article className={`mod-card glass-card ${installed ? 'installed' : ''}`}><div className="mod-card-header">{mod.icon_url ? <img src={mod.icon_url} alt="" /> : <div className="mod-fallback"><PackagePlus size={22}/></div>}<div><h3>{mod.title}</h3><p>by {(mod.author ?? mod.slug) || 'community'}</p></div><span>{mode}</span></div><p className="mod-description">{mod.description || 'No project description was supplied by the catalog.'}</p><div className="mod-tags">{mod.categories.slice(0, 3).map((category) => <span key={category}>{category}</span>)}</div><div className="mod-card-footer"><div><Download size={15}/><span>{formatNumber(mod.downloads)}</span></div><button disabled={isInstalling || installed} onClick={onInstall}>{isInstalling ? <LoaderCircle className="spin" size={15}/> : installed ? <Check size={15}/> : <Plus size={15}/>} {isInstalling ? 'Installing' : installed ? 'Installed' : 'Install compatible'}</button></div></article>;
}

createRoot(document.getElementById('root')!).render(<App />);
