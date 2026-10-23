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
            nodejs_24
            git
          ];

          shellHook = ''
            echo "noctis devshell — node $(node --version), npm $(npm --version)"
            echo "  npm install       install JS dependencies"
            echo "  npm run dev       start Vite at http://localhost:5173"
            echo "  npm run typecheck run vue-tsc"
            echo "  npm run build     build web assets into dist/"
            echo "  npm run sync      build + copy assets into android/"
            echo "  npm run android   build + sync + open Android Studio"
            echo
            echo "Building an APK additionally needs the Android SDK / JDK 21,"
            echo "which this shell intentionally leaves out."
          '';
        };
      });

      formatter = eachSystem (pkgs: pkgs.nixfmt);
    };
}
