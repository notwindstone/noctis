{
  description = "Noctis — a Material You mobile app built with Vue 3 and Capacitor";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_24
            git
          ];

          shellHook = ''
            echo "noctis devshell — bun $(bun --version), node $(node --version)"
            echo "  bun install            install every workspace's dependencies"
            echo "  bun run dev            client: Vite at http://localhost:5173"
            echo "  bun run dev:server     server: http://localhost:4747"
            echo "  bun run typecheck      typecheck every workspace"
            echo "  bun test               client-free tests (plugin core, server)"
            echo "  bun run sync           build the client + copy it into apps/client/android"
            echo "  bun run pack-plugin examples/plugins/<name>   pack a plugin"
            echo
            echo "Building an APK additionally needs the Android SDK / JDK 21,"
            echo "which this shell intentionally leaves out."
          '';
        };
      });

      formatter = eachSystem (pkgs: pkgs.nixfmt);
    };
}
