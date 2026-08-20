# Aether Panel

**Aether Panel** is a standalone Windows desktop control panel for operating Minecraft servers locally. It follows Pterodactyl-inspired values—isolated server workspaces, explicit resource limits, visible operations, least-privilege architecture, and a clean control surface—without being a Pterodactyl distribution or requiring a remote Panel/Wings installation.

## Included capabilities

| Area | What the application does |
|---|---|
| Local operation | Creates and manages servers stored in folders you select on the Windows machine. It does not run a remote hosting control plane. |
| Popular runtimes | Builds or installs **Vanilla**, **Paper**, **Spigot**, **Forge**, and **Fabric** servers. |
| Official build routes | Resolves Vanilla via Mojang metadata; stable Paper builds through PaperMC; Fabric through Fabric Meta; Forge through its Maven installer; and Spigot by running official BuildTools locally. |
| Lifecycle controls | Starts, stops, and sends commands to active server processes. The local console streams stdout/stderr output. |
| Resource profile | Stores a per-server memory ceiling and local game port alongside the managed server profile. |
| Compatible discovery | Searches Modrinth using the selected server’s Minecraft version and loader. Fabric/Forge surface mods; Paper/Spigot surface compatible plugins. |
| One-click compatible install | Downloads a compatible Modrinth release into the selected offline server’s `mods` folder after validation. |
| Security boundaries | Uses Electron context isolation, disabled Node integration in the renderer, explicit IPC operations, HTTPS-only server downloads, and trusted-host checks for Modrinth file installation. |

## Windows prerequisites

Install a supported Java runtime and ensure `java` is available on your `PATH`. Java 21 is a practical choice for current Minecraft server versions; older Minecraft versions can require a different Java version. To build **Spigot**, Aether checks for Git and provides an **Install** button in the Local foundation card when Git is missing. The button downloads the current official Git for Windows x64 installer from the Git for Windows release feed and runs its documented unattended installer options. Windows may show a permission prompt during installation; Aether verifies the installation afterward.

## Install the Windows application

1. Download the latest `Aether-Panel-<version>-x64.exe` installer from the repository’s **Releases** page.
2. Run the installer on a Windows 10 or Windows 11 x64 computer and choose an installation location when prompted.
3. Launch **Aether Panel**, select **Server foundry**, and choose a parent folder that you own, such as `D:\Minecraft\Servers`.
4. Choose a runtime, Minecraft version, memory ceiling, and game port. Then select **Build local server**.
5. When the build completes, select the server in **Mission control** and start it from **Live console**.

> **Windows trust prompt:** The current release is not code-signed. Windows may show a SmartScreen prompt. Review the public source and build it yourself if you need a fully self-verified deployment.

## Build from source

The source archive includes the complete Electron + React project.

```powershell
pnpm install
pnpm build
pnpm dist:win        # managed NSIS installer
pnpm dist:portable   # offline recovery executable
```

The managed installer and updater metadata are written to `release\` by `pnpm dist:win`; the recovery executable is written there by `pnpm dist:portable`.

## Managed updates and rollback

Aether Panel now supports an installed Windows release with an **Updates & rollback** center, Stable and Preview channels, explicit download and restart-to-install controls, and a recovery-release policy. The portable executable remains an offline recovery option and does not self-update. See [RELEASE_MANAGEMENT.md](RELEASE_MANAGEMENT.md) for the one-time GitHub setup, tag-driven release workflow, update artifacts, and safe rollback procedure.

## Operational notes

Aether Panel accepts the Minecraft EULA as part of server preparation by writing `eula=true`; use it only if you agree to Mojang’s current EULA. Back up a server’s world directory before updating a Minecraft version, switching loaders, changing large modpacks, or using third-party plugins. The MVP manages local process lifecycles only; it does not include a billing system, user accounts, DDoS protection, remote multi-node orchestration, or a plugin marketplace.

## Public integration sources

The application uses documented public sources. No API key or user connector is required for its baseline operation.

- [Mojang version metadata](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
- [PaperMC Downloads Service](https://docs.papermc.io/misc/downloads-service/)
- [Fabric Meta](https://github.com/FabricMC/fabric-meta)
- [Spigot BuildTools](https://www.spigotmc.org/wiki/buildtools/)
- [Modrinth API](https://docs.modrinth.com/api/)
- [Git for Windows unattended installation options](https://gitforwindows.org/silent-or-unattended-installation.html)
- [Git for Windows latest releases](https://github.com/git-for-windows/git/releases/latest)
