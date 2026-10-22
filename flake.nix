{
  description = "Transcribe audio using Codex or Chrome speech recognition";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "ntranscribe";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            src = self;
            nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];
            # Runtime code has no external dependencies; no dependency download is needed.
            buildPhase = ''
              runHook preBuild
              bun build src/index.ts --target bun --outfile ntranscribe.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 ntranscribe.js $out/libexec/ntranscribe/index.js
              makeWrapper ${pkgs.bun}/bin/bun $out/bin/ntranscribe \
                --add-flags "$out/libexec/ntranscribe/index.js" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg-headless ]}
              runHook postInstall
            '';
            meta = {
              description = "Transcribe audio using Codex or Chrome speech recognition";
              homepage = "https://github.com/nakasyou/ntransctibe";
              license = pkgs.lib.licenses.mit;
              mainProgram = "ntranscribe";
              platforms = systems;
            };
          };
        });
      apps = forAllSystems (system: {
        default = {
          type = "app";
          meta.description = "Transcribe audio using Codex or Chrome speech recognition";
          program = "${self.packages.${system}.default}/bin/ntranscribe";
        };
      });
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { packages = [ pkgs.bun pkgs.nodejs pkgs.ffmpeg-headless ]; }; });
    };
}
